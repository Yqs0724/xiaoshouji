/**
 * 共听骨架：场次 / 你侧吐槽 / 家机 mock 吐槽 / mock 播控。
 * Apple Music 真连接搁置（L 连接配置不挡骨架）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const LISTEN_PATH = path.join(DATA_DIR, "listen.json");
const COREAD_SETTINGS = path.join(__dirname, "..", "..", "共读app", "data", "settings.json");
const SPIT_BODY_MAX = 400;

const MOCK_TRACKS = [
  {
    id: "mock-1",
    title: "Mint Melody",
    artist: "薄巧电台",
    cover: "deco-mint-cupcake.png",
  },
  {
    id: "mock-2",
    title: "Chocolate Drizzle",
    artist: "家机点播",
    cover: "deco-espresso.png",
  },
  {
    id: "mock-3",
    title: "Parfait Night",
    artist: "同居电台",
    cover: "deco-cookie-bear.png",
  },
];

/** 家机本场吐槽短句池（非 LLM） */
const BOT_OPEN = [
  "耳机戴好了吗，我先占个沙发。",
  "共听开场～这轨我听着顺耳。",
  "来了来了，音量你说了算。",
];
const BOT_SKIP = [
  "这曲过门不错哎。",
  "切歌了？行，跟着你。",
  "换这首我也能哼两句。",
];
const BOT_REPLY = [
  "嗯嗯，记下来了。",
  "哈哈，同感。",
  "你吐槽比副歌还准。",
  "我先安静听，你接着说。",
];

function pickLine(pool) {
  const list = Array.isArray(pool) && pool.length ? pool : ["…"];
  return list[Math.floor(Math.random() * list.length)];
}

const DEFAULTS = {
  apple_music_dev_token: "",
  apple_music_user_token: "",
  /** 连接搁置：骨架不依赖真 MusicKit */
  connection: "shelved",
  playback: {
    playing: false,
    trackIndex: 0,
  },
  proposal: null,
  favorites: [],
  passes: [],
  messages: [],
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LISTEN_PATH)) {
    const migrated = migrateFromCoreadSettings();
    fs.writeFileSync(
      LISTEN_PATH,
      JSON.stringify({ ...DEFAULTS, ...migrated }, null, 2),
      "utf8"
    );
  }
}

function migrateFromCoreadSettings() {
  const out = {
    apple_music_dev_token: "",
    apple_music_user_token: "",
  };
  const envDev =
    process.env.APPLE_MUSIC_DEV_TOKEN || process.env.MUSICKIT_DEV_TOKEN || "";
  if (envDev) out.apple_music_dev_token = String(envDev).trim();
  if (!fs.existsSync(COREAD_SETTINGS)) return out;
  try {
    const s = JSON.parse(fs.readFileSync(COREAD_SETTINGS, "utf8"));
    if (!out.apple_music_dev_token && s.apple_music_dev_token) {
      out.apple_music_dev_token = String(s.apple_music_dev_token || "").trim();
    }
    if (s.apple_music_user_token) {
      out.apple_music_user_token = String(s.apple_music_user_token || "").trim();
    }
    if (
      Object.prototype.hasOwnProperty.call(s, "apple_music_dev_token") ||
      Object.prototype.hasOwnProperty.call(s, "apple_music_user_token")
    ) {
      delete s.apple_music_dev_token;
      delete s.apple_music_user_token;
      fs.writeFileSync(COREAD_SETTINGS, JSON.stringify(s, null, 2), "utf8");
    }
  } catch {
    /* keep */
  }
  return out;
}

function normalizePass(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    status: raw.status === "ended" ? "ended" : "active",
    engaged: !!raw.engaged,
    track_title: String(raw.track_title || "").trim(),
    spit_count: Math.max(0, Math.floor(Number(raw.spit_count) || 0)),
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
}

function normalizeFavorite(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const known = MOCK_TRACKS.find((t) => t.id === id);
  return {
    id,
    title: String(raw.title || (known && known.title) || id).trim(),
    artist: String(raw.artist || (known && known.artist) || "").trim(),
    cover: String(raw.cover || (known && known.cover) || "").trim(),
    ts: Number(raw.ts) || Date.now(),
  };
}

function normalizeMsg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const passId = String(raw.passId || "").trim();
  const body = String(raw.body || "").trim();
  if (!id || !passId || !body) return null;
  return {
    id,
    passId,
    from: raw.from === "bot" ? "bot" : "you",
    body: body.slice(0, SPIT_BODY_MAX),
    ts: Number(raw.ts) || Date.now(),
  };
}

function readAll() {
  ensureFile();
  let file = { ...DEFAULTS };
  try {
    file = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(LISTEN_PATH, "utf8")) };
  } catch {
    /* defaults */
  }
  const envDev = (
    process.env.APPLE_MUSIC_DEV_TOKEN ||
    process.env.MUSICKIT_DEV_TOKEN ||
    ""
  ).trim();
  const playback = file.playback && typeof file.playback === "object" ? file.playback : {};
  return {
    apple_music_dev_token: (envDev || file.apple_music_dev_token || "").trim(),
    apple_music_user_token: String(file.apple_music_user_token || "").trim(),
    connection: "shelved",
    playback: {
      playing: !!playback.playing,
      trackIndex: Math.max(0, Math.floor(Number(playback.trackIndex) || 0)),
    },
    proposal: file.proposal && typeof file.proposal === "object" ? file.proposal : null,
    favorites: (Array.isArray(file.favorites) ? file.favorites : [])
      .map(normalizeFavorite)
      .filter(Boolean),
    passes: (Array.isArray(file.passes) ? file.passes : []).map(normalizePass).filter(Boolean),
    messages: (Array.isArray(file.messages) ? file.messages : []).map(normalizeMsg).filter(Boolean),
  };
}

function writeAll(next) {
  ensureFile();
  const merged = { ...DEFAULTS, ...next, connection: "shelved" };
  fs.writeFileSync(LISTEN_PATH, JSON.stringify(merged, null, 2), "utf8");
  return readAll();
}

function currentTrack(all = readAll()) {
  const i = all.playback.trackIndex % MOCK_TRACKS.length;
  return { ...MOCK_TRACKS[i], index: i };
}

function appleMusicHealth(s = readAll()) {
  if (s.connection === "shelved") return "shelved";
  if (s.apple_music_dev_token && s.apple_music_user_token) return "authorized";
  if (s.apple_music_dev_token) return "developer_ok";
  return "missing";
}

function publicListenAuth(s = readAll()) {
  return {
    connection: "shelved",
    apple_music: appleMusicHealth(s),
    apple_music_authorized: false,
    apple_music_dev_token: "",
    apple_music_user_token: "",
    note: "Apple Music 连接配置搁置；共听骨架可用 mock 播控与吐槽",
  };
}

function patchListenAuth(patch) {
  const all = readAll();
  if (Object.prototype.hasOwnProperty.call(patch, "apple_music_dev_token")) {
    all.apple_music_dev_token = String(patch.apple_music_dev_token || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "apple_music_user_token")) {
    all.apple_music_user_token = String(patch.apple_music_user_token || "").trim();
  }
  writeAll(all);
  return publicListenAuth();
}

function appendBotSpit(all, passId, body) {
  const text = String(body || "").trim().slice(0, SPIT_BODY_MAX);
  if (!passId || !text) return null;
  const msg = {
    id: randomUUID(),
    passId,
    from: "bot",
    body: text,
    ts: Date.now(),
  };
  all.messages.push(msg);
  const pi = all.passes.findIndex((p) => p.id === passId);
  if (pi >= 0) all.passes[pi] = { ...all.passes[pi], updated_at: Date.now() };
  return msg;
}

function ensureActivePass() {
  const all = readAll();
  let pass = all.passes.find((p) => p.status === "active");
  if (!pass) {
    const now = Date.now();
    pass = {
      id: randomUUID(),
      status: "active",
      engaged: false,
      created_at: now,
      updated_at: now,
    };
    all.passes.push(pass);
    appendBotSpit(all, pass.id, pickLine(BOT_OPEN));
    writeAll(all);
  }
  const messages = readAll().messages.filter((m) => m.passId === pass.id);
  return { pass, messages };
}

function markPassEngaged(passId) {
  const all = readAll();
  const pi = all.passes.findIndex((p) => p.id === passId);
  if (pi < 0) return null;
  if (all.passes[pi].engaged) return all.passes[pi];
  all.passes[pi] = {
    ...all.passes[pi],
    engaged: true,
    updated_at: Date.now(),
  };
  writeAll(all);
  return all.passes[pi];
}

/** 桌面胶囊 / 正在做什么：不新建场次 */
function getListenPresence() {
  const all = readAll();
  const pass = all.passes.find((p) => p.status === "active");
  const track = currentTrack(all);
  const playing = !!all.playback.playing;
  if (!pass || !pass.engaged) {
    return {
      ok: true,
      active: false,
      playing: false,
      track: null,
      label: "",
    };
  }
  const title = track.title || "共听";
  return {
    ok: true,
    active: true,
    playing,
    track: { id: track.id, title: track.title, artist: track.artist },
    label: playing ? "共听 · " + title : "共听中 · " + title,
  };
}

function engageListen() {
  const { pass } = ensureActivePass();
  markPassEngaged(pass.id);
  return getListenPresence();
}

function isLiked(trackId, all = readAll()) {
  const tid = String(trackId || "").trim();
  return !!tid && all.favorites.some((f) => f.id === tid);
}

function getSession() {
  const { pass, messages } = ensureActivePass();
  const all = readAll();
  const track = currentTrack(all);
  return {
    ok: true,
    connection: "shelved",
    pass,
    messages,
    track,
    tracks: MOCK_TRACKS.map((t, i) => ({ ...t, index: i })),
    playing: all.playback.playing,
    proposal: all.proposal,
    liked: isLiked(track.id, all),
  };
}

/** 切换当前曲（或指定 id）收藏 */
function toggleFavorite(trackId) {
  const all = readAll();
  const cur = currentTrack(all);
  const tid = String(trackId || cur.id || "").trim();
  const known = MOCK_TRACKS.find((t) => t.id === tid) || (cur.id === tid ? cur : null);
  if (!known) {
    const err = new Error("未知曲目");
    err.code = "bad_favorite";
    throw err;
  }
  const idx = all.favorites.findIndex((f) => f.id === tid);
  let liked;
  if (idx >= 0) {
    all.favorites.splice(idx, 1);
    liked = false;
  } else {
    all.favorites.push({
      id: known.id,
      title: known.title,
      artist: known.artist,
      cover: known.cover || "",
      ts: Date.now(),
    });
    liked = true;
  }
  writeAll(all);
  return { ok: true, ...getSession(), liked, favorites: readAll().favorites };
}

/** 已结束场次摘要 + 收藏列表（只读） */
function getHistory(limit) {
  const all = readAll();
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const history = all.passes
    .filter((p) => p.status === "ended")
    .slice()
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, n)
    .map((p) => {
      const spit =
        p.spit_count ||
        all.messages.filter((m) => m.passId === p.id).length;
      return {
        id: p.id,
        track_title: p.track_title || "共听",
        spit_count: spit,
        ended_at: p.updated_at,
        created_at: p.created_at,
      };
    });
  return { ok: true, history, favorites: all.favorites.slice() };
}

function controlPlayback(action, opts) {
  const act = String(action || "").trim();
  const { pass } = ensureActivePass();
  const live = readAll();
  if (act === "play") live.playback.playing = true;
  else if (act === "pause") live.playback.playing = false;
  else if (act === "next") {
    live.playback.trackIndex = (live.playback.trackIndex + 1) % MOCK_TRACKS.length;
    live.playback.playing = true;
    const t = currentTrack(live);
    appendBotSpit(live, pass.id, pickLine(BOT_SKIP) + "「" + t.title + "」");
  } else if (act === "prev") {
    const n = MOCK_TRACKS.length;
    live.playback.trackIndex = (live.playback.trackIndex - 1 + n) % n;
    live.playback.playing = true;
    const t = currentTrack(live);
    appendBotSpit(live, pass.id, pickLine(BOT_SKIP) + "「" + t.title + "」");
  } else if (act === "select") {
    const tid = String((opts && (opts.trackId || opts.id)) || "").trim();
    const idx = MOCK_TRACKS.findIndex((t) => t.id === tid);
    if (idx < 0) {
      const err = new Error("歌单里没有这首");
      err.code = "bad_control";
      throw err;
    }
    if (idx !== live.playback.trackIndex) {
      live.playback.trackIndex = idx;
      live.playback.playing = true;
      const t = currentTrack(live);
      appendBotSpit(live, pass.id, pickLine(BOT_SKIP) + "「" + t.title + "」");
    } else {
      live.playback.playing = true;
    }
  } else {
    const err = new Error("未知播控：" + act);
    err.code = "bad_control";
    throw err;
  }
  const pi = live.passes.findIndex((p) => p.id === pass.id);
  if (pi >= 0) {
    live.passes[pi] = {
      ...live.passes[pi],
      engaged: true,
      updated_at: Date.now(),
    };
  }
  writeAll(live);
  return getSession();
}

function setProposal(demo) {
  const all = readAll();
  if (demo === false || demo === "clear") {
    all.proposal = null;
  } else {
    const next = MOCK_TRACKS[(all.playback.trackIndex + 1) % MOCK_TRACKS.length];
    all.proposal = {
      id: randomUUID(),
      from: "bot",
      action: "skip",
      track: { ...next },
      ts: Date.now(),
    };
  }
  writeAll(all);
  return getSession();
}

function respondProposal(decision) {
  const all = readAll();
  const d = String(decision || "").trim();
  if (!all.proposal) {
    return getSession();
  }
  if (d === "confirm") {
    const tid = all.proposal.track && all.proposal.track.id;
    const idx = MOCK_TRACKS.findIndex((t) => t.id === tid);
    if (idx >= 0) {
      all.playback.trackIndex = idx;
      all.playback.playing = true;
    } else {
      all.playback.trackIndex = (all.playback.trackIndex + 1) % MOCK_TRACKS.length;
      all.playback.playing = true;
    }
    all.proposal = null;
  } else if (d === "ignore") {
    all.proposal = null;
  } else {
    const err = new Error("请 confirm 或 ignore");
    err.code = "bad_proposal";
    throw err;
  }
  writeAll(all);
  return getSession();
}

function createSpit(patch) {
  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("吐槽不能为空");
    err.code = "bad_spit_body";
    throw err;
  }
  const { pass } = ensureActivePass();
  const all = readAll();
  const msg = {
    id: randomUUID(),
    passId: pass.id,
    from: "you",
    body: body.slice(0, SPIT_BODY_MAX),
    ts: Date.now(),
  };
  const pi = all.passes.findIndex((p) => p.id === pass.id);
  if (pi >= 0) all.passes[pi] = { ...all.passes[pi], updated_at: Date.now() };
  all.messages.push(msg);
  const eng = all.passes.findIndex((p) => p.id === pass.id);
  if (eng >= 0) {
    all.passes[eng] = {
      ...all.passes[eng],
      engaged: true,
      updated_at: Date.now(),
    };
  }
  writeAll(all);
  return { ok: true, pass, message: msg, ...getSession() };
}

const SPIT_HISTORY = 12;
const LISTEN_SYSTEM_BASE =
  "你是同居室友「家机」，正在和用户一起听歌（共听）。" +
  "用一两句短吐槽接话，口语、轻松，可轻轻提曲情绪，不要编造版权内幕。" +
  "不要长篇，不要扮演系统通知，不要提议改播放进度（用户主控）。";

function persistBotSpit(passId, body) {
  const all = readAll();
  const msg = appendBotSpit(all, passId, body);
  if (!msg) return null;
  writeAll(all);
  return msg;
}

async function streamTextAsDeltas(write, text) {
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    await write({ type: "bot_delta", text: s[i] });
    await new Promise((r) => setTimeout(r, 16));
  }
}

/**
 * 你侧落库后家机流式接一句。LLM 失败则 mock 按字流式，不回滚你侧。
 */
async function createSpitWithReplyStream(patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const you = createSpit(patch);
  await write({
    type: "you",
    ok: true,
    pass: you.pass,
    message: you.message,
  });

  let bot_message = null;
  let bot_error = null;
  const track = currentTrack();
  const trackHint =
    (track && track.title ? track.title : "这轨") +
    (track && track.artist ? " · " + track.artist : "");

  try {
    const { chatCompletionStream, parseThinkBody } = require("../../共读app/gateway/llm");
    const { readSettings, effectiveDialogue } = require("../../共读app/gateway/settings");
    const dlg = effectiveDialogue(readSettings());
    let system = LISTEN_SYSTEM_BASE + "\n当前在播：" + trackHint + "。";
    const persona = String((dlg && dlg.persona) || "").trim();
    if (persona) system += "\n人设（请遵守语气与关系）：" + persona;

    const hist = (getSession().messages || []).filter(
      (m) => m.passId === you.pass.id
    );
    const prior = [];
    for (const m of hist.slice(-SPIT_HISTORY)) {
      if (m.id === you.message.id) continue;
      prior.push({
        role: m.from === "bot" ? "assistant" : "user",
        content: m.body,
      });
    }
    prior.push({ role: "user", content: you.message.body });

    await write({ type: "bot_start" });
    let deltaChain = Promise.resolve();
    const raw = await chatCompletionStream({
      system,
      messages: prior,
      think: false,
      replyKind: "chat",
      onDelta: (piece) => {
        if (!piece) return;
        deltaChain = deltaChain.then(() => write({ type: "bot_delta", text: piece }));
      },
    });
    await deltaChain;
    const parsed = parseThinkBody(raw.content, false);
    const text = String(parsed.body || raw.content || "").trim();
    if (!text) {
      const err = new Error("家机没说出话来");
      err.code = "llm_empty";
      throw err;
    }
    bot_message = persistBotSpit(you.pass.id, text);
    await write({ type: "bot_done", message: bot_message });
  } catch (e) {
    // ponytail: 无 Key / LLM 挂了时 mock 按字流，升级=真流式恢复即可
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "家机暂时接不上",
      fallback: "mock_stream",
    };
    const mock = pickLine(BOT_REPLY);
    await write({ type: "bot_start" });
    await streamTextAsDeltas(write, mock);
    bot_message = persistBotSpit(you.pass.id, mock);
    await write({ type: "bot_done", message: bot_message, bot_error });
  }

  const session = getSession();
  await write({
    type: "done",
    ok: true,
    pass: session.pass,
    message: you.message,
    bot_message,
    bot_error,
    messages: session.messages,
    track: session.track,
    playing: session.playing,
    proposal: session.proposal,
    liked: session.liked,
    connection: "shelved",
  });
  return {
    ok: true,
    pass: session.pass,
    message: you.message,
    bot_message,
    bot_error,
    messages: session.messages,
  };
}

function endActivePass() {
  const all = readAll();
  const pi = all.passes.findIndex((p) => p.status === "active");
  if (pi < 0) {
    return { ok: true, ended: false, pass: null, ...getSession() };
  }
  const passId = all.passes[pi].id;
  const track = currentTrack(all);
  const spitCount = all.messages.filter((m) => m.passId === passId).length;
  all.passes[pi] = {
    ...all.passes[pi],
    status: "ended",
    track_title: track.title || "共听",
    spit_count: spitCount,
    updated_at: Date.now(),
  };
  all.proposal = null;
  writeAll(all);
  const endedPass = all.passes[pi];
  const session = getSession();
  return { ok: true, ended: true, endedPass, ...session };
}

function scrubListenObj(obj) {
  const out = { ...(obj && typeof obj === "object" ? obj : {}) };
  out.apple_music_dev_token = "";
  out.apple_music_user_token = "";
  out._backup_note = "Apple Music 令牌已剔除；连接配置搁置";
  out._backup_at = new Date().toISOString();
  return out;
}

if (require.main === module) {
  (async () => {
    endActivePass();
    const s0 = getSession();
    console.assert(s0.pass && s0.pass.status === "active");
    console.assert(s0.messages.some((m) => m.from === "bot"), "开场家机句");
    const events = [];
    await createSpitWithReplyStream({ body: "骨架吐槽流式" }, (ev) => {
      events.push(ev);
    });
    console.assert(events.some((e) => e.type === "you"));
    console.assert(events.some((e) => e.type === "bot_start"));
    console.assert(events.some((e) => e.type === "bot_delta"));
    console.assert(events.some((e) => e.type === "bot_done"));
    console.assert(events.some((e) => e.type === "done"));
    controlPlayback("play");
    const before = getSession().messages.length;
    controlPlayback("next");
    console.assert(getSession().messages.length > before, "切歌家机句");
    const pick = MOCK_TRACKS[0].id;
    controlPlayback("select", { trackId: pick });
    console.assert(getSession().track.id === pick, "歌单选曲");
    console.assert(Array.isArray(getSession().tracks) && getSession().tracks.length >= 3);
    setProposal(true);
    console.assert(getSession().proposal);
    respondProposal("ignore");
    console.assert(!getSession().proposal);
    console.assert(getListenPresence().active === true, "吐槽后应 engaged");
    const ended = endActivePass();
    console.assert(ended.ended === true);
    console.assert(getListenPresence().active === false, "结束本场后不应显示进行中");
    const fresh = getSession();
    console.assert(fresh.messages.every((m) => m.passId === fresh.pass.id));
    console.assert(getListenPresence().active === false, "新空场未 engage");
    engageListen();
    console.assert(getListenPresence().active === true);
    console.assert(appleMusicHealth() === "shelved");
    const tid = getSession().track.id;
    if (getSession().liked) toggleFavorite(tid);
    const favOn = toggleFavorite(tid);
    console.assert(favOn.liked === true && getSession().liked === true, "收藏应落库");
    const favOff = toggleFavorite(tid);
    console.assert(favOff.liked === false && getSession().liked === false, "取消收藏");
    toggleFavorite(tid);
    endActivePass();
    const hist = getHistory();
    console.assert(
      hist.history.some((h) => h.id === ended.endedPass.id && h.spit_count >= 1),
      "结束本场应进 history"
    );
    console.assert(hist.favorites.some((f) => f.id === tid), "收藏列表保留");
    console.log("listen ok", {
      track: fresh.track.title,
      presence: getListenPresence().label,
      health: appleMusicHealth(),
      history: hist.history.length,
      favorites: hist.favorites.length,
    });
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  readListen: readAll,
  readAll,
  patchListenAuth,
  appleMusicHealth,
  publicListenAuth,
  scrubListenObj,
  getSession,
  controlPlayback,
  setProposal,
  respondProposal,
  createSpit,
  createSpitWithReplyStream,
  endActivePass,
  ensureActivePass,
  getListenPresence,
  engageListen,
  toggleFavorite,
  getHistory,
  MOCK_TRACKS,
  LISTEN_PATH,
  DATA_DIR,
};
