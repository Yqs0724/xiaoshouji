/**
 * Cove 阶段 B：共同状态（music_library.json）
 * session / events / actor / close+租约 / 锁与原子写 / 阶段总结
 * 不存 Cookie、不存临时 CDN、不存完整歌词。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "music_library.json");
const ACTIVE_LEASE_MS = 2 * 60 * 60 * 1000;
const MAX_EVENTS = 500;
const MAX_SUMMARIES = 8;

const LOCK = { busy: false };

const TERMINAL = new Set(["close", "finish", "ended", "stopped"]);
const ACTIVE_STATES = new Set(["play", "resume"]);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyLibrary() {
  return {
    playlists: {},
    queue: [],
    session: {
      current_song: null,
      current_playlist: null,
      last_actor: "",
      state: "idle",
      updated_at: 0,
    },
    events: [],
    summaries: [],
  };
}

function mergeLibrary(raw) {
  const base = emptyLibrary();
  if (!raw || typeof raw !== "object") return base;
  return {
    playlists:
      raw.playlists && typeof raw.playlists === "object" ? raw.playlists : {},
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    session: { ...base.session, ...(raw.session || {}) },
    events: Array.isArray(raw.events) ? raw.events : [],
    summaries: Array.isArray(raw.summaries) ? raw.summaries : [],
  };
}

function readLibrary() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) return emptyLibrary();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return mergeLibrary(raw);
  } catch (e) {
    /* 损坏时备份，不静默盖掉原文件内容直到下次合法写入 */
    try {
      fs.copyFileSync(
        STORE_PATH,
        STORE_PATH + ".corrupt." + Date.now()
      );
    } catch (_) {}
    const err = new Error("music_library.json 损坏，已备份");
    err.code = "music_library_corrupt";
    err.cause = e;
    /* 返回空库供本轮继续，避免网关挂死；磁盘上仍留 .corrupt 备份 */
    return emptyLibrary();
  }
}

function writeLibrary(data) {
  ensureDataDir();
  const payload = JSON.stringify(data, null, 2);
  /* 唯一临时名，避免多进程抢同一个 .tmp（教程 §25.2） */
  const tmp =
    STORE_PATH + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function withLock(fn) {
  /* ponytail: 单进程网关；多 worker 换 SQLite/跨进程锁 */
  if (LOCK.busy) {
    const start = Date.now();
    while (LOCK.busy && Date.now() - start < 2000) {
      /* busy wait capped */
    }
  }
  LOCK.busy = true;
  try {
    return fn();
  } finally {
    LOCK.busy = false;
  }
}

/** 所有会改库的入口走这里，防导入歌单与事件互相覆盖 */
function mutateMusicLibrary(mutator) {
  return withLock(() => {
    const lib = readLibrary();
    const result = mutator(lib);
    writeLibrary(lib);
    return result;
  });
}

function compactSong(song) {
  if (!song || typeof song !== "object") return null;
  const id = song.id != null ? song.id : song.song_id;
  const name = String(song.name || song.title || "").trim();
  if (!name && id == null) return null;
  const out = {
    provider: String(song.provider || "netease").trim() || "netease",
    id: id != null ? id : undefined,
    name,
    artist: String(song.artist || "").trim(),
  };
  if (song.album) out.album = String(song.album).trim().slice(0, 80);
  if (song.apple_url) out.apple_url = String(song.apple_url).trim();
  if (song.preview_url) out.preview_url = String(song.preview_url).trim();
  if (song.cover) out.cover = String(song.cover).trim().slice(0, 400);
  if (song.song_key) out.song_key = String(song.song_key).trim();
  if (song.stream_path) {
    out.stream_path = String(song.stream_path).trim().slice(0, 200);
  }
  if (song.duration_ms) {
    out.duration_ms = Math.max(0, Math.floor(Number(song.duration_ms) || 0));
  }
  return out;
}

function isoWeekPeriod(tsSec) {
  const d = new Date((Number(tsSec) || Math.floor(Date.now() / 1000)) * 1000);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function rollPhaseSummary(lib, nowSec) {
  const events = Array.isArray(lib.events) ? lib.events : [];
  const songCount = new Map();
  const artistCount = new Map();
  for (const e of events.slice(-120)) {
    if (!e || !e.song) continue;
    if (!["play", "finish", "skip", "ready"].includes(e.event_type)) continue;
    const name = String(e.song.name || "").trim();
    const artist = String(e.song.artist || "").trim();
    if (name) songCount.set(name, (songCount.get(name) || 0) + 1);
    if (artist) artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
  }
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, c]) => ({ name: k, count: c }));
  const top_songs = top(songCount, 5);
  const top_artists = top(artistCount, 5);
  if (!top_songs.length && !top_artists.length) return null;
  const clues = [];
  if (top_artists[0]) clues.push("常听歌手倾向：" + top_artists[0].name);
  if (top_songs[0]) clues.push("反复出现：《" + top_songs[0].name + "》");
  const summary = {
    period: isoWeekPeriod(nowSec),
    top_songs,
    top_artists,
    recommendation_clues: clues,
    created_at: nowSec,
  };
  if (!Array.isArray(lib.summaries)) lib.summaries = [];
  lib.summaries.push(summary);
  if (lib.summaries.length > MAX_SUMMARIES) {
    lib.summaries = lib.summaries.slice(-MAX_SUMMARIES);
  }
  return summary;
}

/**
 * @param {{ event_type: string, actor?: string, song?: object, note?: string, playlist?: object }} patch
 */
function recordSessionEvent(patch) {
  return mutateMusicLibrary((lib) => {
    const event_type = String((patch && patch.event_type) || "")
      .trim()
      .toLowerCase();
    const allowed = new Set([
      "play",
      "pause",
      "resume",
      "skip",
      "finish",
      "close",
      "ready",
      "ended",
      "stopped",
      "import_playlist",
      "queue_playlist",
    ]);
    if (!allowed.has(event_type)) {
      return { ok: false, error: "bad_event", message: "未知事件类型" };
    }
    const actor =
      String((patch && patch.actor) || "user").trim() === "companion"
        ? "companion"
        : "user";
    const song = compactSong(patch && patch.song);
    const now = Math.floor(Date.now() / 1000);
    const ev = {
      event_type,
      actor,
      song,
      playlist: patch && patch.playlist ? patch.playlist : null,
      note: String((patch && patch.note) || "").trim().slice(0, 120),
      created_at: now,
    };
    lib.events.push(ev);
    if (lib.events.length > MAX_EVENTS) {
      lib.events = lib.events.slice(-MAX_EVENTS);
    }
    const sess = lib.session || emptyLibrary().session;
    if (song && (event_type === "play" || event_type === "resume")) {
      sess.current_song = song;
      sess.last_actor = actor;
      sess.state = "play";
      sess.updated_at = now;
    } else if (song && event_type === "ready") {
      sess.current_song = song;
      sess.last_actor = actor;
      sess.state = "ready";
      sess.updated_at = now;
    } else if (event_type === "pause") {
      if (song) sess.current_song = song;
      if (sess.current_song) {
        sess.state = "pause";
        sess.updated_at = now;
        sess.last_actor = actor;
      }
    } else if (TERMINAL.has(event_type)) {
      sess.state = event_type === "ended" || event_type === "stopped"
        ? "close"
        : event_type;
      sess.updated_at = now;
      sess.last_actor = actor;
      if (song) sess.current_song = song;
      rollPhaseSummary(lib, now);
    } else if (event_type === "skip" && song) {
      sess.current_song = song;
      sess.last_actor = actor;
      sess.state = "play";
      sess.updated_at = now;
    }
    lib.session = sess;
    return { ok: true, session: publicSession(sess), event: ev };
  });
}

function postPhaseSummary(body) {
  return mutateMusicLibrary((lib) => {
    const now = Math.floor(Date.now() / 1000);
    if (body && body.summary && typeof body.summary === "object") {
      const s = {
        period: String(body.summary.period || isoWeekPeriod(now)),
        top_songs: Array.isArray(body.summary.top_songs)
          ? body.summary.top_songs.slice(0, 8)
          : [],
        top_artists: Array.isArray(body.summary.top_artists)
          ? body.summary.top_artists.slice(0, 8)
          : [],
        recommendation_clues: Array.isArray(body.summary.recommendation_clues)
          ? body.summary.recommendation_clues.map((x) => String(x).slice(0, 80)).slice(0, 6)
          : [],
        created_at: now,
      };
      if (!Array.isArray(lib.summaries)) lib.summaries = [];
      lib.summaries.push(s);
      lib.summaries = lib.summaries.slice(-MAX_SUMMARIES);
      return { ok: true, summary: s, summaries: lib.summaries.slice(-2) };
    }
    const summary = rollPhaseSummary(lib, now);
    return {
      ok: true,
      summary,
      summaries: (lib.summaries || []).slice(-2),
    };
  });
}

function publicSession(sess, nowMs = Date.now()) {
  const s = sess || emptyLibrary().session;
  const updatedMs = (Number(s.updated_at) || 0) * 1000;
  let state = String(s.state || "idle");
  if (state === "resume") state = "play";
  const fresh = updatedMs > 0 && nowMs - updatedMs <= ACTIVE_LEASE_MS;
  const terminal = TERMINAL.has(state);
  const active = fresh && !terminal && ACTIVE_STATES.has(state);
  const paused = fresh && state === "pause" && !!s.current_song;
  let label = "";
  if (active) label = "正在共听";
  else if (paused) label = "已暂停";
  else if (state === "ready" && s.current_song && fresh) label = "已备好";
  else if (terminal) label = "已结束";
  else if (s.current_song && !fresh) label = "已过期";
  return {
    current_song: s.current_song || null,
    current_playlist: s.current_playlist || null,
    last_actor: s.last_actor || "",
    state,
    updated_at: s.updated_at || 0,
    active,
    paused,
    terminated: terminal,
    stale: !!(s.current_song && !fresh && !terminal),
    lease_ms: ACTIVE_LEASE_MS,
    label,
  };
}

function getMusicSession() {
  const lib = readLibrary();
  return {
    ok: true,
    session: publicSession(lib.session),
    recent_events: (lib.events || []).slice(-5),
    summaries: (lib.summaries || []).slice(-2),
  };
}

function providerHint(song) {
  const p = String((song && song.provider) || "").toLowerCase();
  if (p === "netease") return "网易云";
  if (p === "apple") return "Apple";
  return p || "音源";
}

/** 塞进家机 system 的紧凑共听上下文（Cove §14） */
function buildMusicContextPrompt() {
  const { session, recent_events, summaries } = getMusicSession();
  if (
    !session.current_song &&
    !(recent_events && recent_events.length) &&
    !(summaries && summaries.length)
  ) {
    return "";
  }
  const lines = ["[当前共听音乐上下文]"];
  const song = session.current_song;
  const songLine = (s) =>
    "《" +
    s.name +
    "》" +
    (s.artist ? " — " + s.artist : "") +
    "（" +
    providerHint(s) +
    "）";

  if (session.active && song) {
    lines.push("正在共听：" + songLine(song));
  } else if (session.paused && song) {
    lines.push("当前已暂停：" + songLine(song) + "（可恢复，不是正在共听）");
  } else if (session.terminated && song) {
    lines.push(
      "最近一次共听已结束（close/finish），勿写成正在播放：" + songLine(song)
    );
  } else if (session.stale && song) {
    lines.push(
      "共听租约已过期，只能当历史：" + songLine(song) + "（勿写正在共听）"
    );
  } else if (session.state === "ready" && song && !session.stale) {
    lines.push("已备好点歌卡（尚未开始共听）：" + songLine(song));
  }

  if (recent_events && recent_events.length) {
    const bits = recent_events
      .slice(-5)
      .map((e) => {
        const who = e.actor === "companion" ? "家机" : "你";
        const sn = (e.song && e.song.name) || "";
        return who + " " + e.event_type + (sn ? "《" + sn + "》" : "");
      })
      .filter(Boolean);
    if (bits.length) lines.push("最近共听事件：" + bits.join("；"));
  }

  if (summaries && summaries.length) {
    const last = summaries[summaries.length - 1];
    const tops = (last.top_songs || [])
      .slice(0, 3)
      .map((x) => "《" + (x.name || x) + "》")
      .join("");
    const clues = (last.recommendation_clues || []).slice(0, 2).join("；");
    const bits = [];
    if (tops) bits.push("反复出现" + tops);
    if (clues) bits.push(clues);
    if (bits.length) {
      lines.push("共听沉淀（" + (last.period || "") + "）：" + bits.join("；"));
    }
  }

  lines.push(
    "规则：仅活跃租约内的 play 可称「正在共听」；pause=已暂停；close/finish/过期=历史。勿编造未记录的播放。"
  );
  return lines.join("\n");
}

if (require.main === module) {
  const r1 = recordSessionEvent({
    event_type: "play",
    actor: "user",
    song: { provider: "netease", id: 1, name: "自检曲", artist: "测试" },
  });
  console.assert(r1.ok && r1.session.active, "play active");
  console.assert(r1.session.label === "正在共听", "label playing");

  const r2 = recordSessionEvent({ event_type: "pause", actor: "user" });
  console.assert(r2.ok && !r2.session.active && r2.session.paused, "pause");
  console.assert(
    r2.session.current_song && r2.session.current_song.name === "自检曲",
    "keep song"
  );

  const ctxPause = buildMusicContextPrompt();
  console.assert(ctxPause.includes("已暂停"), "ctx pause");
  console.assert(
    !/正在共听：《自检曲》/.test(ctxPause),
    "ctx no active on pause"
  );

  const r3 = recordSessionEvent({ event_type: "close", actor: "user" });
  console.assert(r3.ok && r3.session.terminated && !r3.session.active, "close");
  const ctxClose = buildMusicContextPrompt();
  console.assert(
    ctxClose.includes("已结束") || ctxClose.includes("勿写成正在播放"),
    "ctx close"
  );

  const g = getMusicSession();
  console.assert(Array.isArray(g.summaries), "summaries");
  console.assert(g.recent_events.length >= 1, "events");

  mutateMusicLibrary((lib) => {
    lib.session.state = "play";
    lib.session.updated_at = Math.floor(Date.now() / 1000) - 60 * 60 * 3;
    lib.session.current_song = {
      provider: "netease",
      id: 2,
      name: "陈旧曲",
      artist: "旧",
    };
  });
  const stale = getMusicSession().session;
  console.assert(stale.stale && !stale.active, "stale lease");
  const ctxStale = buildMusicContextPrompt();
  console.assert(ctxStale.includes("过期") || ctxStale.includes("历史"), "ctx stale");

  console.log("music-session stage B ok");
}

module.exports = {
  recordSessionEvent,
  postPhaseSummary,
  getMusicSession,
  buildMusicContextPrompt,
  publicSession,
  mutateMusicLibrary,
  compactSong,
  ACTIVE_LEASE_MS,
  MAX_EVENTS,
  MAX_SUMMARIES,
};
