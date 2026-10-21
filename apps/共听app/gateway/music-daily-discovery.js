/**
 * Cove 阶段 E+F：今日私选（程序找真歌 → LLM 排序/理由 → 确定性兜底）。
 * 缓存：data/music_daily_discovery.json（锁+原子写；不提交 Git）。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "music_daily_discovery.json");
const LOCK = { busy: false };

const TAGS = ["稳准", "旁支", "私心", "小冒险"];
const FEEDBACK_ACTIONS = new Set([
  "like",
  "heard",
  "more_like_this",
  "less_like_this",
  "dislike",
]);
const MAX_FEEDBACK = 1000;
const MAX_QUERIES = 12;
const SEARCH_PER_QUERY = 10;
const MAX_VERIFY = 48;
const MAX_LLM_CANDIDATES = 60;
const LLM_TIMEOUT_MS = 45_000;
const DEFAULT_LIMIT = 16;
const STYLE_QUERIES = [
  "indie pop",
  "dream pop",
  "city pop",
  "neo soul",
  "jazz hip hop",
  "民谣",
  "独立流行",
  "轻电音",
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyStore() {
  return { cards: {}, feedback: [] };
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      cards: raw && raw.cards && typeof raw.cards === "object" ? raw.cards : {},
      feedback: Array.isArray(raw && raw.feedback) ? raw.feedback : [],
    };
  } catch (_) {
    try {
      fs.copyFileSync(STORE_PATH, STORE_PATH + ".corrupt." + Date.now());
    } catch (_) {}
    return emptyStore();
  }
}

function writeStore(data) {
  ensureDataDir();
  const payload = JSON.stringify(data, null, 2);
  const tmp = STORE_PATH + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

function withLock(fn) {
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

function mutateStore(mutator) {
  return withLock(() => {
    const store = readStore();
    const result = mutator(store);
    writeStore(store);
    return result;
  });
}

function todayLocalISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function songKey(s) {
  if (!s) return "";
  if (s.song_key) return String(s.song_key);
  const id = s.id != null ? s.id : s.song_id;
  if (id != null) return "netease:" + String(id);
  const name = String(s.name || "").trim().toLowerCase();
  const artist = String(s.artist || "").trim().toLowerCase();
  return name ? "na:" + name + "|" + artist : "";
}

function nameArtistKey(s) {
  return (
    String((s && s.name) || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "") +
    "|" +
    String((s && s.artist) || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
  );
}

function readLibrarySafe() {
  const p = path.join(DATA_DIR, "music_library.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {}
  return { playlists: {}, queue: [], events: [], summaries: [], session: {} };
}

function buildKnownSets(store) {
  const idSet = new Set();
  const naSet = new Set();
  const lib = readLibrarySafe();
  for (const pl of Object.values(lib.playlists || {})) {
    for (const t of pl.tracks || []) {
      const k = songKey(t);
      if (k) idSet.add(k);
      const na = nameArtistKey(t);
      if (na !== "|") naSet.add(na);
    }
  }
  for (const e of lib.events || []) {
    if (!e || !e.song) continue;
    const k = songKey(e.song);
    if (k) idSet.add(k);
    const na = nameArtistKey(e.song);
    if (na !== "|") naSet.add(na);
  }
  for (const card of Object.values(store.cards || {})) {
    for (const s of (card && card.songs) || []) {
      const k = songKey(s);
      if (k) idSet.add(k);
      const na = nameArtistKey(s);
      if (na !== "|") naSet.add(na);
    }
  }
  for (const f of store.feedback || []) {
    if (!f) continue;
    if (f.action === "heard" || f.action === "dislike") {
      if (f.song_id != null) idSet.add("netease:" + String(f.song_id));
    }
  }
  return { idSet, naSet, excludedCount: idSet.size };
}

function buildTasteProfile(store) {
  const lib = readLibrarySafe();
  const user_picks = [];
  const companion_picks = [];
  const artistCount = new Map();
  const avoid = new Set();
  const positive = new Set();

  for (const e of (lib.events || []).slice(-200)) {
    if (!e || !e.song) continue;
    if (!["play", "ready", "finish"].includes(e.event_type)) continue;
    const row = {
      id: e.song.id,
      name: e.song.name,
      artist: e.song.artist,
    };
    if (e.actor === "companion") companion_picks.push(row);
    else user_picks.push(row);
    const a = String(e.song.artist || "").trim();
    if (a) artistCount.set(a, (artistCount.get(a) || 0) + 1);
  }

  for (const f of store.feedback || []) {
    if (!f) continue;
    if (f.action === "more_like_this" || f.action === "like") {
      if (f.artist) positive.add(String(f.artist).trim());
    }
    if (f.action === "less_like_this" || f.action === "dislike") {
      if (f.artist) avoid.add(String(f.artist).trim());
    }
  }

  const top_artists = [...artistCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);

  const playlist_names = Object.values(lib.playlists || {})
    .map((p) => String(p.name || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  const clues = [];
  for (const s of lib.summaries || []) {
    for (const c of s.recommendation_clues || []) {
      if (c) clues.push(String(c).slice(0, 40));
    }
  }

  return {
    user_picks: user_picks.slice(-12),
    companion_picks: companion_picks.slice(-12),
    top_artists,
    playlist_names,
    positive_feedback_artists: [...positive].slice(0, 8),
    avoid_artists: [...avoid].slice(0, 8),
    clues: clues.slice(-6),
  };
}

function buildQueries(profile) {
  const qs = [];
  const push = (q) => {
    const s = String(q || "").trim();
    if (!s || qs.includes(s) || qs.length >= MAX_QUERIES) return;
    qs.push(s);
  };
  for (const a of profile.top_artists || []) push(a);
  for (const a of profile.positive_feedback_artists || []) push(a);
  for (const n of profile.playlist_names || []) push(n);
  for (const p of (profile.user_picks || []).slice(-4)) {
    if (p.artist) push(p.artist);
  }
  for (const st of STYLE_QUERIES) push(st);
  if (!qs.length) {
    push("流行");
    push("轻音乐");
    push("独立");
  }
  return qs.slice(0, MAX_QUERIES);
}

function isVariantName(name) {
  const n = String(name || "").toLowerCase();
  return /live|remaster|edit|instrumental|mix|钢琴版|伴奏|纯音乐/.test(n);
}

function reasonTemplate(tag, song, profile) {
  const artist = String(song.artist || "").trim() || "这位歌手";
  if (tag === "稳准") {
    const top = (profile.top_artists && profile.top_artists[0]) || "";
    return top
      ? "贴近你常听的「" + top + "」一路，听感稳。"
      : "听感熟悉好进，适合现在接着听。";
  }
  if (tag === "旁支") {
    return "和你最近口味有亲缘，但「" + artist + "」这条线稍偏一点。";
  }
  if (tag === "私心") {
    return "家机私心安利：「" + (song.name || "这首") + "」。";
  }
  return "稍微探一步：「" + artist + "」可能还没在旧歌单里出现过。";
}

function assignTag(index, song, profile) {
  const artist = String(song.artist || "").trim();
  if (
    artist &&
    (profile.top_artists || []).some((a) => a === artist)
  ) {
    return "稳准";
  }
  if (
    artist &&
    (profile.positive_feedback_artists || []).some((a) => a === artist)
  ) {
    return "私心";
  }
  if (index % 5 === 4) return "小冒险";
  if (index % 3 === 2) return "旁支";
  return TAGS[index % TAGS.length];
}

async function collectPlayableCandidates(queries, known, profile) {
  const catalog = require("./netease-catalog");
  const avoid = new Set(
    (profile.avoid_artists || []).map((a) => a.toLowerCase())
  );
  const pool = [];
  const seenId = new Set();
  const seenNa = new Set();

  for (const q of queries) {
    let hits = [];
    try {
      hits = await catalog.searchSongs(q, { limit: SEARCH_PER_QUERY });
    } catch (_) {
      hits = [];
    }
    for (const t of hits) {
      if (!t || t.id == null) continue;
      const sk = songKey(t);
      const na = nameArtistKey(t);
      if (known.idSet.has(sk) || seenId.has(sk)) continue;
      if (na !== "|" && (known.naSet.has(na) || seenNa.has(na))) continue;
      const artist = String(t.artist || "").toLowerCase();
      if (artist && [...avoid].some((a) => artist.includes(a))) continue;
      seenId.add(sk);
      if (na !== "|") seenNa.add(na);
      pool.push(t);
      if (pool.length >= MAX_VERIFY * 2) break;
    }
    if (pool.length >= MAX_VERIFY * 2) break;
  }

  /* 折叠变体：同名歌手优先非 Live 版 */
  pool.sort((a, b) => {
    const va = isVariantName(a.name) ? 1 : 0;
    const vb = isVariantName(b.name) ? 1 : 0;
    return va - vb;
  });

  const playable = [];
  let checked = 0;
  for (const t of pool) {
    if (checked >= MAX_VERIFY) break;
    checked += 1;
    try {
      const url = await catalog.getAudioUrl(t.id);
      if (!url) continue;
      playable.push(t);
    } catch (e) {
      if (e && e.code === "MUSIC_TRIAL_ONLY") continue;
      /* skip unreachable */
    }
  }
  return { poolSize: pool.length, playable, checked };
}

function pickDeterministic(playable, profile, limit) {
  const byArtist = new Map();
  for (const t of playable) {
    const a = String(t.artist || "未知").trim() || "未知";
    if (!byArtist.has(a)) byArtist.set(a, []);
    const arr = byArtist.get(a);
    if (arr.length < 2) arr.push(t);
  }
  const artists = [...byArtist.keys()];
  /* 熟悉歌手轮询优先，再其它 */
  const familiar = new Set(profile.top_artists || []);
  artists.sort((a, b) => {
    const fa = familiar.has(a) ? 0 : 1;
    const fb = familiar.has(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.localeCompare(b, "zh");
  });

  const picked = [];
  let guard = 0;
  while (picked.length < limit && guard < 500) {
    guard += 1;
    let added = false;
    for (const a of artists) {
      const arr = byArtist.get(a);
      if (!arr || !arr.length) continue;
      const t = arr.shift();
      picked.push(t);
      added = true;
      if (picked.length >= limit) break;
    }
    if (!added) break;
  }
  return picked;
}

function publicCard(card, warning) {
  if (!card) return null;
  const out = {
    ok: true,
    date: card.date,
    title: card.title || "今日私选",
    subtitle: card.subtitle || "",
    note: card.note || "",
    generated_at: card.generated_at,
    strategy: card.strategy || {},
    songs: Array.isArray(card.songs) ? card.songs : [],
    cached: true,
  };
  if (warning) out.warning = warning;
  return out;
}

function songRowFromTrack(t, tag, reason) {
  return {
    provider: "netease",
    id: t.id,
    song_key: t.song_key || "netease:" + t.id,
    name: t.name,
    artist: t.artist,
    album: t.album,
    cover: t.cover,
    duration_ms: t.duration_ms,
    stream_path: t.stream_path || "/api/v1/music/stream/netease/" + t.id,
    reason: String(reason || "").trim().slice(0, 80),
    tag: TAGS.includes(tag) ? tag : "旁支",
    playable: true,
  };
}

function buildDeterministicSongs(playable, profile, limit) {
  const picked = pickDeterministic(playable, profile, limit);
  return picked.map((t, i) => {
    const tag = assignTag(i, t, profile);
    return songRowFromTrack(t, tag, reasonTemplate(tag, t, profile));
  });
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("LLM 策展超时");
        err.code = "llm_timeout";
        reject(err);
      }, ms);
    }),
  ]);
}

function resolveCurateModels() {
  let primary = "";
  let fallback = "";
  try {
    const s = require("../../共读app/gateway/settings").readSettings();
    primary = String(s.llm_model || "").trim();
    fallback = String(s.sentinel_model || "").trim();
  } catch (_) {}
  const out = [];
  if (primary) out.push(primary);
  if (fallback && fallback !== primary) out.push(fallback);
  return out;
}

/**
 * 校验 LLM 输出：只收白名单 id、合法 tag、歌手多样性；不足则确定性补齐。
 */
function applyLlmCurate(parsed, playable, profile, limit) {
  const byId = new Map();
  for (const t of playable) {
    if (t && t.id != null) byId.set(String(t.id), t);
  }
  const note = String((parsed && parsed.note) || "").trim().slice(0, 80);
  const rows = Array.isArray(parsed && parsed.songs) ? parsed.songs : [];
  const songs = [];
  const seen = new Set();
  const artistCount = new Map();

  for (const row of rows) {
    if (!row || row.id == null) continue;
    const idKey = String(row.id);
    if (!byId.has(idKey) || seen.has(idKey)) continue;
    const t = byId.get(idKey);
    const artist = String(t.artist || "未知").trim() || "未知";
    if ((artistCount.get(artist) || 0) >= 2) continue;
    let tag = String(row.tag || "").trim();
    if (!TAGS.includes(tag)) tag = assignTag(songs.length, t, profile);
    let reason = String(row.reason || "").trim().slice(0, 80);
    if (!reason) reason = reasonTemplate(tag, t, profile);
    songs.push(songRowFromTrack(t, tag, reason));
    seen.add(idKey);
    artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
    if (songs.length >= limit) break;
  }

  if (songs.length < limit) {
    const rest = playable.filter((t) => t && !seen.has(String(t.id)));
    const pad = buildDeterministicSongs(rest, profile, limit - songs.length);
    for (const s of pad) {
      const artist = String(s.artist || "未知").trim() || "未知";
      if ((artistCount.get(artist) || 0) >= 2) continue;
      songs.push(s);
      seen.add(String(s.id));
      artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
      if (songs.length >= limit) break;
    }
  }

  return {
    note:
      note ||
      (songs.length >= 8
        ? "前半段偏稳，后面会探一点生面孔。"
        : "今天候选不多，先听这几首。"),
    songs,
    llm_ok: songs.length > 0 && rows.length > 0,
  };
}

async function rankWithLlm(playable, profile, limit) {
  const models = resolveCurateModels();
  if (!models.length) {
    const err = new Error("未配置 LLM");
    err.code = "llm_not_configured";
    throw err;
  }
  const whitelist = playable.slice(0, MAX_LLM_CANDIDATES).map((t) => ({
    id: t.id,
    name: t.name,
    artist: t.artist,
    album: t.album || "",
  }));
  if (!whitelist.length) {
    const err = new Error("无候选可策展");
    err.code = "no_candidates";
    throw err;
  }

  const system =
    "你是共听「今日私选」策展助手。" +
    "只能从候选列表里选歌，禁止编造 id / 歌名 / 歌手。" +
    "只输出 JSON 对象，不要 markdown 代码块，不要解释。" +
    '格式：{"note":"一句话总评","songs":[{"id":数字,"reason":"短理由","tag":"稳准|旁支|私心|小冒险"}]}。' +
    "要求：选 " +
    limit +
    " 首；每位歌手最多 2 首；兼顾贴近品味与小幅探索；reason≤40字；tag 只能是四选一。";

  const user =
    "品味信号：\n" +
    JSON.stringify(
      {
        top_artists: profile.top_artists || [],
        positive_feedback_artists: profile.positive_feedback_artists || [],
        avoid_artists: profile.avoid_artists || [],
        clues: profile.clues || [],
      },
      null,
      0
    ) +
    "\n\n候选白名单（只能用这些 id）：\n" +
    JSON.stringify(whitelist);

  const { chatCompletion } = require("../../共读app/gateway/llm");
  let lastErr = null;
  for (const model of models) {
    try {
      const raw = await withTimeout(
        chatCompletion({
          system,
          user,
          think: false,
          replyKind: "chat",
          model,
        }),
        LLM_TIMEOUT_MS
      );
      const content = String((raw && raw.content) || "").trim();
      const parsed = extractJsonObject(content);
      if (!parsed) {
        lastErr = new Error("LLM 未返回合法 JSON");
        lastErr.code = "llm_bad_json";
        continue;
      }
      const applied = applyLlmCurate(parsed, playable, profile, limit);
      if (applied.songs.length >= Math.min(4, limit)) {
        return {
          note: applied.note,
          songs: applied.songs,
          model,
        };
      }
      lastErr = new Error("LLM 有效选曲不足");
      lastErr.code = "llm_thin";
    } catch (e) {
      lastErr = e;
      if (e && e.code === "llm_not_configured") throw e;
    }
  }
  if (lastErr) throw lastErr;
  const err = new Error("LLM 策展失败");
  err.code = "llm_failed";
  throw err;
}

async function generateCard(opts = {}) {
  const limit = Math.max(
    4,
    Math.min(24, Math.floor(Number(opts.limit) || DEFAULT_LIMIT))
  );
  const store = readStore();
  const known = buildKnownSets(store);
  const profile = buildTasteProfile(store);
  const queries = buildQueries(profile);
  const { poolSize, playable, checked } = await collectPlayableCandidates(
    queries,
    known,
    profile
  );

  if (!playable.length) {
    return {
      ok: false,
      error: "no_candidates",
      message: "今天没捞到可播新歌（检查网易云 API / Cookie）",
      strategy: {
        target_count: limit,
        excluded_known_count: known.excludedCount,
        candidate_count: poolSize,
        playable_count: 0,
        verified: checked,
        llm_ranked: false,
      },
    };
  }

  let songs = [];
  let note = "";
  let llm_ranked = false;
  let llm_model = "";
  let llm_error = "";

  try {
    const ranked = await rankWithLlm(playable, profile, limit);
    songs = ranked.songs;
    note = ranked.note;
    llm_ranked = true;
    llm_model = ranked.model || "";
  } catch (e) {
    llm_error = String((e && e.code) || (e && e.message) || "llm_failed").slice(
      0,
      80
    );
    songs = buildDeterministicSongs(playable, profile, limit);
    note =
      songs.length >= 8
        ? "前半段偏稳，后面会探一点生面孔。"
        : "今天候选不多，先听这几首。";
  }

  if (!songs.length) {
    return {
      ok: false,
      error: "no_candidates",
      message: "今天没捞到可播新歌（检查网易云 API / Cookie）",
      strategy: {
        target_count: limit,
        excluded_known_count: known.excludedCount,
        candidate_count: poolSize,
        playable_count: playable.length,
        verified: checked,
        llm_ranked: false,
        llm_error: llm_error || undefined,
      },
    };
  }

  const date = todayLocalISO();
  const now = Math.floor(Date.now() / 1000);
  const card = {
    date,
    version: 1,
    title: "今日私选",
    subtitle: llm_ranked
      ? "家机从可播候选里挑了今天这组"
      : "向外找了几首还没在旧歌单里出现过的歌",
    note,
    generated_at: now,
    strategy: {
      target_count: limit,
      excluded_known_count: known.excludedCount,
      candidate_count: poolSize,
      playable_count: playable.length,
      verified: checked,
      llm_ranked,
      llm_model: llm_model || undefined,
      llm_error: llm_ranked ? undefined : llm_error || undefined,
      queries: queries.slice(0, 8),
    },
    songs,
  };

  mutateStore((s) => {
    if (!s.cards) s.cards = {};
    s.cards[date] = card;
    const keys = Object.keys(s.cards).sort();
    while (keys.length > 14) {
      delete s.cards[keys.shift()];
    }
    return true;
  });

  return publicCard(card, null);
}

async function getDailyDiscovery(opts = {}) {
  const refresh = opts.refresh === true || opts.refresh === "true" || opts.refresh === "1";
  const limit = Math.max(
    4,
    Math.min(24, Math.floor(Number(opts.limit) || DEFAULT_LIMIT))
  );
  const date = todayLocalISO();
  const store = readStore();
  const cached = store.cards && store.cards[date];
  if (!refresh && cached && Array.isArray(cached.songs) && cached.songs.length) {
    return publicCard(cached, null);
  }
  try {
    return await generateCard({ limit });
  } catch (e) {
    /* 刷新失败：回落最近非空缓存 */
    const keys = Object.keys(store.cards || {}).sort().reverse();
    for (const k of keys) {
      const c = store.cards[k];
      if (c && c.songs && c.songs.length) {
        return publicCard(
          c,
          "今日刷新失败，先显示 " + k + " 的缓存 · " +
            String((e && e.message) || "error").slice(0, 60)
        );
      }
    }
    return {
      ok: false,
      error: e.code || "discovery_failed",
      message: String((e && e.message) || e).slice(0, 160),
    };
  }
}

function recordFeedback(body = {}) {
  const song_id = body.song_id != null ? body.song_id : body.id;
  const action = String(body.action || "").trim();
  if (song_id == null || !FEEDBACK_ACTIONS.has(action)) {
    return {
      ok: false,
      error: "bad_feedback",
      message: "需要 song_id 与合法 action",
    };
  }
  const now = Math.floor(Date.now() / 1000);
  return mutateStore((store) => {
    if (!Array.isArray(store.feedback)) store.feedback = [];
    store.feedback.push({
      song_id: Math.floor(Number(song_id)) || song_id,
      action,
      artist: String(body.artist || "").trim().slice(0, 80) || undefined,
      name: String(body.name || "").trim().slice(0, 80) || undefined,
      created_at: now,
    });
    if (store.feedback.length > MAX_FEEDBACK) {
      store.feedback = store.feedback.slice(-MAX_FEEDBACK);
    }
    return { ok: true, action, song_id };
  });
}

if (require.main === module) {
  const profile = buildTasteProfile(emptyStore());
  const qs = buildQueries(profile);
  console.assert(qs.length >= 1 && qs.length <= MAX_QUERIES, "queries");
  const tag = assignTag(0, { artist: "X", name: "Y" }, profile);
  console.assert(TAGS.includes(tag), "tag");
  console.assert(todayLocalISO().length === 10, "date");
  const fakePlayable = [
    { id: 1, name: "A", artist: "X", stream_path: "/a" },
    { id: 2, name: "B", artist: "Y", stream_path: "/b" },
    { id: 3, name: "C", artist: "X", stream_path: "/c" },
  ];
  const applied = applyLlmCurate(
    {
      note: "测",
      songs: [
        { id: 1, reason: "好", tag: "稳准" },
        { id: 999, reason: "幻觉", tag: "旁支" },
        { id: 3, reason: "也行", tag: "私心" },
      ],
    },
    fakePlayable,
    profile,
    3
  );
  console.assert(applied.songs.length === 3, "curate pad");
  console.assert(
    applied.songs.every((s) => s.id === 1 || s.id === 2 || s.id === 3),
    "whitelist"
  );
  console.assert(!applied.songs.some((s) => s.id === 999), "no invent");
  const parsed = extractJsonObject('说两句\n{"note":"n","songs":[]}');
  console.assert(parsed && parsed.note === "n", "json extract");
  console.log("music-daily-discovery stage E+F ok");
}

module.exports = {
  getDailyDiscovery,
  recordFeedback,
  buildTasteProfile,
  buildQueries,
  todayLocalISO,
  extractJsonObject,
  applyLlmCurate,
  TAGS,
  FEEDBACK_ACTIONS,
};
