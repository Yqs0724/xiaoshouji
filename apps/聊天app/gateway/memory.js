/**
 * H2.2 海马体 + H2.4 自动抽记 + M1 记忆库工作台。
 * 按 peer 分桶；decay_score；接话 top-K。
 * M1：增删改 / 搜索 / 待办钉。M2：手动总结 + 锚点。
 * M3：关键词召回。M4：规则哨兵。M5：可选 Embedding 综合评分。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const CONTENT_MAX = 400;
const TOP_K = 5;
const LAMBDA = {
  deep: 0.05,
  daily: 0.05,
  diary: 0.05,
  writing: 0.05,
  ambient: 0.15,
};
const PERMANENT_CATEGORIES = new Set([
  "sop",
  "infra",
  "progress",
  "feature_plan",
  "lessons_learned",
  "llm_routing",
  "tts_config",
]);

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_PATH)) {
    fs.writeFileSync(
      MEMORY_PATH,
      JSON.stringify({ version: 1, peers: {} }, null, 2),
      "utf8"
    );
  }
}

function normalizePeerId(raw) {
  const s = String(raw || "").trim();
  if (/^[a-zA-Z0-9_-]{1,32}$/.test(s)) return s;
  return "daily";
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
    const peers =
      raw && raw.peers && typeof raw.peers === "object" ? raw.peers : {};
    return { version: 1, peers };
  } catch (_) {
    return { version: 1, peers: {} };
  }
}

function writeStore(store) {
  ensureFile();
  fs.writeFileSync(
    MEMORY_PATH,
    JSON.stringify({ version: 1, peers: store.peers || {} }, null, 2),
    "utf8"
  );
}

function daysSince(ts, now) {
  const t = Number(ts) || 0;
  const n = now != null ? Number(now) : Date.now();
  if (!t) return 30;
  return Math.max(0, (n - t) / (24 * 3600 * 1000));
}

function timeWeight(days) {
  if (days <= 1) return 1;
  if (days <= 2) return 0.9;
  return Math.max(0.3, 0.9 * Math.exp(-0.2197 * (days - 2)));
}

function computeDecayScore(m, now) {
  const days = daysSince(m.ts, now);
  const layer = String(m.layer || "daily");
  const lambda = LAMBDA[layer] != null ? LAMBDA[layer] : LAMBDA.daily;
  const importance = clamp(m.importance, 1, 10);
  const act = Math.max(1, Math.floor(Number(m.activation_count) || 1));
  const arousal = clamp(m.arousal, 0, 1);
  const normalize = 10;
  let base =
    (importance *
      Math.pow(act, 0.3) *
      Math.exp(-lambda * days) *
      (1 + arousal * 0.5)) /
    normalize;
  let score = timeWeight(days) * base;
  if (m.resolved) score *= 0.05;
  else if (arousal >= 0.7 && !m.resolved) score *= 1.5;
  const cat = String(m.category || "").trim().toLowerCase();
  if (
    PERMANENT_CATEGORIES.has(cat) ||
    m.pinned ||
    m.must_read ||
    cat.indexOf("规则") === 0
  ) {
    score = Math.max(score, 99);
  }
  return Math.round(score * 1000) / 1000;
}

function normalizeKeywords(raw) {
  const src = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[,，、\s]+/)
        .filter(Boolean);
  return src
    .map((t) => String(t).trim().slice(0, 24))
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeEmbedding(raw) {
  if (!Array.isArray(raw) || raw.length < 8 || raw.length > 8192) return null;
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = Number(raw[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = Math.round(n * 1e6) / 1e6;
  }
  return out;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na < 1e-12 || nb < 1e-12) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * H2.16：V/A 共鸣——查询情绪与记忆坐标越近加分越高（教程「今天难过→浮现以前难过」）。
 * qMood: { valence, arousal }；无则 0。
 */
function vaResonance(m, qMood) {
  if (!qMood || qMood.valence == null) return 0;
  const qV = clamp(qMood.valence, -1, 1);
  const qA = clamp(qMood.arousal != null ? qMood.arousal : 0.4, 0, 1);
  const mV = clamp(m.valence, -1, 1);
  const mA = clamp(m.arousal, 0, 1);
  const dist = (Math.abs(mV - qV) + Math.abs(mA - qA)) / 2;
  return Math.max(0, 0.15 * (1 - dist));
}

/** AionsHome 风格：vec×0.6 + kw×0.3 + importance×0.1；再轻叠待办/鲜活/共鸣 */
function compositeScore(m, tokens, qVec, qMood) {
  const kw = keywordHitScore(m, tokens);
  const kwN = Math.min(1, kw / 3);
  const impN = clamp(m.importance, 1, 10) / 10;
  let vec = 0;
  let hasVec = false;
  if (qVec && m.embedding && m.embedding.length === qVec.length) {
    vec = cosineSim(qVec, m.embedding);
    hasVec = true;
  }
  let base;
  if (hasVec) {
    base = vec * 0.6 + kwN * 0.3 + impN * 0.1;
  } else {
    base = turnRankScore(m, tokens) / 20;
  }
  if (m.unresolved) base += 0.12;
  base += Math.min(0.08, (Number(m.decay_score) || 0) * 0.02);
  base += vaResonance(m, qMood);
  return base;
}

function toPublicMemory(m) {
  if (!m) return m;
  const copy = Object.assign({}, m);
  const has = Array.isArray(copy.embedding) && copy.embedding.length > 0;
  delete copy.embedding;
  copy.has_embedding = has;
  return copy;
}

function normalizeMemory(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const content = String(raw.content || "").trim().slice(0, CONTENT_MAX);
  if (!content) return null;
  const id = String(raw.id || "").trim() || randomUUID();
  const ts = Number(raw.ts) || Date.now();
  let resolved = raw.resolved ? 1 : 0;
  if (raw.unresolved != null) resolved = raw.unresolved ? 0 : 1;
  const keywords = normalizeKeywords(raw.keywords);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 8)
    : [];
  const m = {
    id,
    layer: ["deep", "daily", "diary", "writing", "ambient"].includes(raw.layer)
      ? raw.layer
      : "daily",
    content,
    category: String(raw.category || "日常").trim().slice(0, 32) || "日常",
    tags,
    keywords: keywords.length ? keywords : tags.slice(0, 8),
    importance: clamp(raw.importance != null ? raw.importance : 5, 1, 10),
    valence: clamp(raw.valence != null ? raw.valence : 0, -1, 1),
    arousal: clamp(raw.arousal != null ? raw.arousal : 0.4, 0, 1),
    activation_count: Math.max(0, Math.floor(Number(raw.activation_count) || 0)),
    last_activated: Number(raw.last_activated) || 0,
    resolved,
    unresolved: !resolved,
    pinned: !!raw.pinned,
    must_read: !!raw.must_read,
    source_start_ts: Math.max(0, Math.floor(Number(raw.source_start_ts) || 0)),
    source_end_ts: Math.max(0, Math.floor(Number(raw.source_end_ts) || 0)),
    embedding: sanitizeEmbedding(raw.embedding),
    prior_versions: Array.isArray(raw.prior_versions)
      ? raw.prior_versions.slice(0, 20)
      : [],
    ts,
  };
  m.decay_score = computeDecayScore(m, now);
  return m;
}

function memoryMatchesQuery(m, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    m.content,
    m.category,
    ...(m.tags || []),
    ...(m.keywords || []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.indexOf(needle) >= 0;
}

function listPeerMemories(peerId, opts) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const store = readStore();
  const rawList = Array.isArray(store.peers[pid]) ? store.peers[pid] : [];
  let list = rawList.map((x) => normalizeMemory(x, now)).filter(Boolean);
  list.sort((a, b) => {
    const u = (b.unresolved ? 1 : 0) - (a.unresolved ? 1 : 0);
    if (u) return u;
    return (b.decay_score || 0) - (a.decay_score || 0);
  });
  const q = opts && opts.q;
  if (q) list = list.filter((m) => memoryMatchesQuery(m, q));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts && opts.limit) || 80)));
  /* 查询不回写整库，避免搜索时重排落盘；无 q 时刷新 decay */
  if (!q) {
    store.peers[pid] = list;
    writeStore(store);
  }
  return {
    ok: true,
    peerId: pid,
    total: list.length,
    memories: list.slice(0, limit).map(toPublicMemory),
  };
}

function addMemory(peerId, input) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const store = readStore();
  const list = (Array.isArray(store.peers[pid]) ? store.peers[pid] : [])
    .map((x) => normalizeMemory(x, now))
    .filter(Boolean);
  const m = normalizeMemory(
    Object.assign({}, input || {}, {
      id: randomUUID(),
      ts: now,
      activation_count: 0,
      last_activated: 0,
    }),
    now
  );
  if (!m) {
    const err = new Error("记忆内容不能为空");
    err.code = "bad_memory";
    throw err;
  }
  list.unshift(m);
  store.peers[pid] = list.slice(0, 500);
  writeStore(store);
  void hydrateEmbedding(pid, m.id).catch(() => {});
  return { ok: true, peerId: pid, memory: toPublicMemory(m) };
}

function findPeerList(store, pid, now) {
  return (Array.isArray(store.peers[pid]) ? store.peers[pid] : [])
    .map((x) => normalizeMemory(x, now))
    .filter(Boolean);
}

function updateMemory(peerId, id, patch) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("记忆不存在");
    err.code = "not_found";
    throw err;
  }
  const store = readStore();
  const list = findPeerList(store, pid, now);
  const idx = list.findIndex((m) => m.id === sid);
  if (idx < 0) {
    const err = new Error("记忆不存在");
    err.code = "not_found";
    throw err;
  }
  const cur = list[idx];
  const next = normalizeMemory(
    Object.assign({}, cur, patch || {}, {
      id: cur.id,
      ts: cur.ts,
      activation_count: cur.activation_count,
      last_activated: cur.last_activated,
      prior_versions: cur.prior_versions,
    }),
    now
  );
  if (!next) {
    const err = new Error("记忆内容不能为空");
    err.code = "bad_memory";
    throw err;
  }
  list[idx] = next;
  store.peers[pid] = list;
  writeStore(store);
  void hydrateEmbedding(pid, next.id).catch(() => {});
  return { ok: true, peerId: pid, memory: toPublicMemory(next) };
}

function deleteMemory(peerId, id) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const sid = String(id || "").trim();
  const store = readStore();
  const list = findPeerList(store, pid, now);
  const next = list.filter((m) => m.id !== sid);
  if (next.length === list.length) {
    const err = new Error("记忆不存在");
    err.code = "not_found";
    throw err;
  }
  store.peers[pid] = next;
  writeStore(store);
  return { ok: true, peerId: pid, deleted: sid };
}

function toggleUnresolved(peerId, id) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const sid = String(id || "").trim();
  const store = readStore();
  const list = findPeerList(store, pid, now);
  const idx = list.findIndex((m) => m.id === sid);
  if (idx < 0) {
    const err = new Error("记忆不存在");
    err.code = "not_found";
    throw err;
  }
  const cur = list[idx];
  const next = normalizeMemory(
    Object.assign({}, cur, { unresolved: !cur.unresolved }),
    now
  );
  list[idx] = next;
  store.peers[pid] = list;
  writeStore(store);
  return { ok: true, peerId: pid, memory: toPublicMemory(next) };
}

const UNRESOLVED_CAP = 2;

const CHITCHAT_RE =
  /^(嗯+|哦+|啊+|哈+|嘿+|嗨+|草+|操+|哼+|行|好|好的|哦了|知道了|没事|随便|在吗|在不在|早|晚安|拜拜|再见|谢谢|辛苦了)[。！？.~…\s]*$/i;
const FORCE_SEARCH_RE =
  /记得|记不记得|上次|那天|之前|你说过|说过|别忘|提醒|我们约|约好|还欠|待办|答应/;

/**
 * M4 即时哨兵（规则版）。
 * ponytail: 每轮再打 flash 模型贵；规则够用先顶着。漏判多了再加 LLM 哨兵（升级：轻量模型 JSON）。
 * @returns {{ search_needed: boolean, mode: 'skip'|'open_only'|'search', keywords: string[], topic: string }}
 */
function instantSentinel(userText) {
  const raw = String(userText || "").trim().slice(0, 400);
  if (!raw) {
    return { search_needed: false, mode: "skip", keywords: [], topic: "" };
  }
  if (CHITCHAT_RE.test(raw) || raw.length < 2) {
    return { search_needed: false, mode: "skip", keywords: [], topic: "" };
  }
  const keywords = tokenizeQuery(raw);
  const topic = keywords.slice(0, 4).join("·");
  if (FORCE_SEARCH_RE.test(raw)) {
    return { search_needed: true, mode: "search", keywords, topic };
  }
  /* 短寒暄但不在闭集：只抬待办，不扫整库 */
  if (raw.length < 8 && !/[？?吗呢]/.test(raw)) {
    return {
      search_needed: false,
      mode: "open_only",
      keywords,
      topic,
    };
  }
  return { search_needed: true, mode: "search", keywords, topic };
}

/** 从用户句抽检索词：连续中文≥2、英文/数字词 */
function tokenizeQuery(text) {
  const raw = String(text || "").trim().slice(0, 400);
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  const push = (w) => {
    const t = String(w || "").trim().toLowerCase();
    if (t.length < 2 || t.length > 24) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const zh = raw.match(/[\u4e00-\u9fff]{2,12}/g) || [];
  for (const w of zh) {
    push(w);
    /* 长串再抽 2～4 字片，方便对上「草莓」这类词 */
    const maxN = Math.min(4, w.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= w.length - n; i++) push(w.slice(i, i + n));
    }
  }
  const lat = raw.match(/[a-zA-Z0-9]{2,16}/g) || [];
  for (const w of lat) push(w);
  return out.slice(0, 32);
}

function memoryHaystack(m) {
  return [
    m.content,
    m.category,
    ...(m.keywords || []),
    ...(m.tags || []),
  ]
    .join(" ")
    .toLowerCase();
}

/** 关键词命中数（子串）；无 query 时为 0 */
function keywordHitScore(m, tokens) {
  if (!tokens || !tokens.length) return 0;
  const hay = memoryHaystack(m);
  let hits = 0;
  for (const t of tokens) {
    if (hay.indexOf(t) >= 0) hits += 1;
  }
  return hits;
}

function turnRankScore(m, tokens) {
  const decay = Number(m.decay_score) || 0;
  const kw = keywordHitScore(m, tokens);
  const open = m.unresolved ? 1 : 0;
  /* 待办与关键词压过纯鲜活；decay 仍作底 */
  return open * 8 + kw * 5 + decay;
}

async function hydrateEmbedding(peerId, id) {
  let embedConfigured;
  let embedOne;
  try {
    ({ embedConfigured, embedOne } = require("../../共读app/gateway/llm"));
  } catch (_) {
    return null;
  }
  if (!embedConfigured()) return null;
  const pid = normalizePeerId(peerId);
  const sid = String(id || "").trim();
  if (!sid) return null;
  const now = Date.now();
  const store = readStore();
  const list = findPeerList(store, pid, now);
  const idx = list.findIndex((m) => m.id === sid);
  if (idx < 0) return null;
  const cur = list[idx];
  if (cur.embedding && cur.embedding.length) return cur;
  const vec = await embedOne(cur.content);
  const emb = sanitizeEmbedding(vec);
  if (!emb) return null;
  const next = normalizeMemory(Object.assign({}, cur, { embedding: emb }), now);
  list[idx] = next;
  store.peers[pid] = list;
  writeStore(store);
  return next;
}

/**
 * 接话召回：待办优先 + 关键词；若配置了 embed_model 则综合向量分。
 * opts.sentinel 可传入 M4 路由结果。
 */
async function recallForTurn(peerId, queryText, k, opts) {
  const now = Date.now();
  const pid = normalizePeerId(peerId);
  const want = Math.max(1, Math.min(12, Math.floor(Number(k) || TOP_K)));
  const sent =
    opts && opts.sentinel ? opts.sentinel : instantSentinel(queryText);
  if (sent.mode === "skip") return [];

  const tokens =
    sent.keywords && sent.keywords.length
      ? sent.keywords
      : tokenizeQuery(queryText);
  const store = readStore();
  let list = (Array.isArray(store.peers[pid]) ? store.peers[pid] : [])
    .map((x) => normalizeMemory(x, now))
    .filter(Boolean);

  let qVec = null;
  if (sent.mode === "search") {
    try {
      const { embedConfigured, embedOne } = require("../../共读app/gateway/llm");
      if (embedConfigured()) {
        qVec = sanitizeEmbedding(await embedOne(String(queryText || "").slice(0, 500)));
      }
    } catch (_) {
      qVec = null;
    }
  }

  /* H2.16：查询句词典坐标优先；否则用角色当前心情作共鸣锚 */
  let qMood = null;
  try {
    const { scanText, readMood } = require("./mood");
    const sc = scanText(queryText);
    if (sc && sc.hits && sc.hits.length && (Math.abs(sc.avgV) >= 0.15 || sc.negCount || sc.posCount)) {
      qMood = {
        valence: clamp(sc.avgV, -1, 1),
        arousal: clamp(sc.hitArousal != null ? sc.hitArousal : 0.4, 0, 1),
      };
    } else {
      const mood = readMood();
      if (mood && (Math.abs(mood.valence) >= 0.12 || mood.na >= 0.35 || mood.pa >= 0.45)) {
        qMood = { valence: mood.valence, arousal: mood.arousal };
      }
    }
  } catch (_) {
    qMood = null;
  }

  const rank = (a, b) =>
    compositeScore(b, tokens, qVec, qMood) - compositeScore(a, tokens, qVec, qMood);

  const openPool = list.filter((m) => m.unresolved).sort(rank);
  const picked = [];
  const used = new Set();
  const flashIds = new Set();
  for (const m of openPool) {
    if (picked.length >= UNRESOLVED_CAP || picked.length >= want) break;
    picked.push(m);
    used.add(m.id);
  }

  if (sent.mode !== "open_only") {
    const rest = list.filter((m) => !used.has(m.id)).sort(rank);
    for (const m of rest) {
      if (picked.length >= want) break;
      const score = compositeScore(m, tokens, qVec);
      const kw = keywordHitScore(m, tokens);
      /* 有向量时：低相似且无关键词、非待办 → 跳过 */
      if (qVec && !m.unresolved && kw === 0 && score < 0.42) continue;
      if (
        !qVec &&
        tokens.length &&
        !m.unresolved &&
        kw === 0 &&
        (Number(m.decay_score) || 0) < 0.35
      ) {
        continue;
      }
      picked.push(m);
      used.add(m.id);
    }

    /* 「忽然想起」：结果不够时 40% 从旧记忆随机捞 1～3 条 */
    if (
      picked.length < want &&
      list.length > picked.length &&
      Math.random() < 0.4
    ) {
      const pool = list.filter((m) => !used.has(m.id));
      const room = Math.min(3, want - picked.length, pool.length);
      let take = room > 0 ? 1 + Math.floor(Math.random() * room) : 0;
      while (take > 0 && pool.length) {
        const j = Math.floor(Math.random() * pool.length);
        const m = pool.splice(j, 1)[0];
        picked.push(m);
        used.add(m.id);
        flashIds.add(m.id);
        take -= 1;
      }
    }
  }

  list = list.map((m) => {
    if (!used.has(m.id)) return m;
    const next = Object.assign({}, m, {
      activation_count: (m.activation_count || 0) + 1,
      last_activated: now,
    });
    next.decay_score = computeDecayScore(next, now);
    return next;
  });
  store.peers[pid] = list;
  writeStore(store);
  return picked
    .map((p) => list.find((m) => m.id === p.id) || p)
    .filter(Boolean)
    .map((m) =>
      flashIds.has(m.id) ? Object.assign({}, m, { flash: true }) : m
    );
}

/** @deprecated 用 recallForTurn；保留给旧调用 */
async function recallTopK(peerId, k) {
  return recallForTurn(peerId, "", k, {
    sentinel: { search_needed: true, mode: "search", keywords: [], topic: "" },
  });
}

/**
 * @param {string} peerId
 * @param {string} [queryText] 本轮用户句，用于哨兵 + 关键词/向量对齐
 */
async function buildMemoryPrompt(peerId, queryText) {
  const sent = instantSentinel(queryText);
  const hits = await recallForTurn(peerId, queryText, TOP_K, {
    sentinel: sent,
  });
  if (!hits.length) return "";
  const lines = hits.map((m, i) => {
    const pin = m.unresolved ? "📌" : "";
    const flash = m.flash ? "✧忽然想起 " : "";
    const tag = m.category ? "[" + m.category + "] " : "";
    return i + 1 + ". " + pin + flash + tag + m.content;
  });
  const topicBit = sent.topic ? " · 话题线索：" + sent.topic : "";
  const modeBit = sent.mode === "open_only" ? "（本轮只带待办）" : "";
  const hasFlash = hits.some((m) => m.flash);
  return (
    "[MEMORY] 你记得与对方相关的这些事" +
    modeBit +
    "（📌=待办/未了结，优先自然提起；勿逐条复读" +
    (hasFlash ? "；✧=忽然想起的旧事，可偶然带一句" : "") +
    "）" +
    topicBit +
    "：\n" +
    lines.join("\n")
  );
}

function normKey(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:：'\"“”‘’]/g, "")
    .slice(0, 80);
}

function looksDuplicate(peerId, content) {
  const key = normKey(content);
  if (key.length < 4) return true;
  const { memories } = listPeerMemories(peerId, { limit: 40 });
  for (const m of memories || []) {
    const k = normKey(m.content);
    if (!k) continue;
    if (k === key || k.includes(key) || key.includes(k)) return true;
  }
  return false;
}

/* ponytail: 闭集正则够抽偏好/叮嘱；要准再换 LLM 抽记（升级：抽记模型一趟 JSON） */
const EXTRACT_RULES = [
  {
    re: /(?:请)?记住[：:，,\s]*(.{4,80})/,
    importance: 7,
    category: "叮嘱",
    layer: "daily",
    fmt: (g) => String(g[1] || "").trim(),
  },
  {
    re: /记一下[：:，,\s]*(.{4,80})/,
    importance: 7,
    category: "叮嘱",
    layer: "daily",
    fmt: (g) => String(g[1] || "").trim(),
  },
  {
    re: /别忘了[：:，,\s]*(.{4,80})/,
    importance: 7,
    category: "叮嘱",
    layer: "daily",
    fmt: (g) => String(g[1] || "").trim(),
  },
  {
    re: /我(?:超)?喜欢(.{2,36})/,
    importance: 6,
    category: "偏好",
    layer: "daily",
    fmt: (g) => "对方喜欢" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /我爱吃(.{2,36})/,
    importance: 6,
    category: "偏好",
    layer: "daily",
    fmt: (g) => "对方爱吃" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /我(?:很)?讨厌(.{2,36})/,
    importance: 6,
    category: "偏好",
    layer: "daily",
    fmt: (g) => "对方讨厌" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /我(?:有点)?怕(.{2,28})/,
    importance: 6,
    category: "偏好",
    layer: "daily",
    fmt: (g) => "对方怕" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /我叫(.{2,16})/,
    importance: 8,
    category: "身份",
    layer: "deep",
    fmt: (g) => "对方叫" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /我住(?:在)?(.{2,40})/,
    importance: 6,
    category: "身份",
    layer: "daily",
    fmt: (g) => "对方住在" + String(g[1] || "").trim().replace(/[了啦啊呢呗。！？]+$/, ""),
  },
  {
    re: /(?:明天|后天|这周末|下周)[^。！？\n]{0,48}(?:要|去|有|见面|开会|约会|出门)/,
    importance: 5,
    category: "日程",
    layer: "ambient",
    fmt: (g) => String(g[0] || "").trim().slice(0, 80),
  },
];

/** @returns {object | null} 未落库的草稿 */
function draftExtract(userText) {
  const raw = String(userText || "").trim();
  if (raw.length < 4 || raw.length > 400) return null;
  if (/^(嗯+|哦+|啊+|哈+|草+|操+|哼+|行|好|哦了|知道了|没事|随便)[。！？.~…]*$/i.test(raw)) {
    return null;
  }
  for (const rule of EXTRACT_RULES) {
    const m = raw.match(rule.re);
    if (!m) continue;
    let content = "";
    try {
      content = String(rule.fmt(m) || "").trim().slice(0, CONTENT_MAX);
    } catch (_) {
      content = "";
    }
    if (content.length < 4) continue;
    const comma = content.search(/[，,]/);
    if (comma >= 6) content = content.slice(0, comma).trim();
    content = content.replace(/[。！？.!?]+$/, "").trim();
    if (content.length < 4) continue;
    return {
      content,
      importance: rule.importance,
      category: rule.category,
      layer: rule.layer,
      tags: ["auto"],
      valence: 0,
      arousal: 0.45,
    };
  }
  return null;
}

/**
 * H2.4：从本轮用户句抽 0～1 条短记。无命中 / 太短 / 重复 → null。
 * @returns {{ ok: true, memory: object } | null}
 */
function maybeExtractMemory(peerId, userText) {
  const hit = draftExtract(userText);
  if (!hit) return null;
  if (looksDuplicate(peerId, hit.content)) return null;
  return addMemory(peerId, hit);
}

/* —— M2：总结新记忆（锚点 + LLM 抽结构化条）—— */
const ANCHOR_PATH = path.join(DATA_DIR, "digest_anchor.json");
const DIGEST_BATCH = 40;
const DIGEST_MAX_ITEMS = 8;

function readAnchors() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(ANCHOR_PATH, "utf8"));
    const peers =
      raw && raw.peers && typeof raw.peers === "object" ? raw.peers : {};
    return { version: 1, peers };
  } catch (_) {
    return { version: 1, peers: {} };
  }
}

function writeAnchors(store) {
  ensureFile();
  fs.writeFileSync(
    ANCHOR_PATH,
    JSON.stringify({ version: 1, peers: store.peers || {} }, null, 2),
    "utf8"
  );
}

function getAnchorTs(peerId) {
  const pid = normalizePeerId(peerId);
  const a = readAnchors().peers[pid];
  return Math.max(0, Math.floor(Number(a && a.ts) || 0));
}

function setAnchorTs(peerId, ts) {
  const pid = normalizePeerId(peerId);
  const store = readAnchors();
  store.peers[pid] = {
    ts: Math.max(0, Math.floor(Number(ts) || 0)),
    updated_at: Date.now(),
  };
  writeAnchors(store);
  return store.peers[pid];
}

function parseDigestItems(rawText) {
  let s = String(rawText || "").trim();
  if (!s) return [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const bracket = s.match(/\[[\s\S]*\]/);
  if (bracket) s = bracket[0];
  let data;
  try {
    data = JSON.parse(s);
  } catch (_) {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.memories)
      ? data.memories
      : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const content = String(row.content || row.summary || "")
      .trim()
      .slice(0, CONTENT_MAX);
    if (content.length < 4) continue;
    out.push({
      content,
      keywords: normalizeKeywords(row.keywords || row.tags),
      importance: clamp(row.importance != null ? row.importance : 6, 1, 10),
      category: String(row.category || "日常").trim().slice(0, 32) || "日常",
      unresolved: !!(row.unresolved || row.open || row.todo),
      layer: row.layer === "deep" ? "deep" : "daily",
    });
    if (out.length >= DIGEST_MAX_ITEMS) break;
  }
  return out;
}

function digestStatus(peerId) {
  const {
    withPeer,
    listMessages,
    llmContent,
  } = require("./daily-chat");
  const pid = normalizePeerId(peerId);
  return withPeer(pid, () => {
    const anchorTs = getAnchorTs(pid);
    const msgs = listMessages().messages || [];
    let pending = 0;
    let latest = 0;
    for (const m of msgs) {
      const ts = Number(m && m.ts) || 0;
      if (ts > latest) latest = ts;
      if (ts <= anchorTs) continue;
      const text = String(llmContent(m) || "").trim();
      if (text) pending += 1;
    }
    return {
      ok: true,
      peerId: pid,
      anchor_ts: anchorTs,
      pending,
      latest_ts: latest,
    };
  });
}

/**
 * 手动总结：锚点之后最多 DIGEST_BATCH 条 → LLM 抽 0～8 条 → 写入 + 推进锚点。
 * 无最低条数限制（点了就跑）；额度不足 / 无 Key 抛错。
 */
async function runDigestOnLines(pid, lines, opts) {
  const { addTokensUsed } = require("./daily-chat");
  const { chatCompletion } = require("../../共读app/gateway/llm");
  const advanceAnchor = !(opts && opts.skipAnchor);
  const tag = String((opts && opts.tag) || "digest");

  const system =
    "你是陪伴对话的记忆整理员。从对话摘出值得长期记住的事实/偏好/约定/待办。" +
    "只输出一个 JSON 数组，不要解释、不要 markdown。" +
    "每项：{\"content\":\"一句中文短记\",\"keywords\":[\"词\"],\"importance\":1到10," +
    "\"category\":\"偏好|叮嘱|身份|日程|日常\",\"unresolved\":true或false}。" +
    "无值得记的就输出 []。最多 " +
    DIGEST_MAX_ITEMS +
    " 条。content 不超过 80 字。";
  const user =
    "以下是对话（按时间）：\n" + lines.map((x) => x.line).join("\n");

  let raw;
  try {
    raw = await chatCompletion({
      system,
      user,
      think: false,
      replyKind: "chat",
    });
  } catch (e) {
    const err = new Error((e && e.message) || "总结请求失败");
    err.code = (e && e.code) || "llm_failed";
    throw err;
  }

  const used =
    (Number(raw && raw.tokens_in) || 0) +
      (Number(raw && raw.tokens_out) || 0) || 600;
  addTokensUsed(used);

  const drafts = parseDigestItems(raw && raw.content);
  const added = [];
  let skipped_dupes = 0;
  const source_start_ts = lines[0].ts;
  const source_end_ts = lines[lines.length - 1].ts;
  let batchEndTs = source_end_ts;
  for (const d of drafts) {
    if (looksDuplicate(pid, d.content)) {
      skipped_dupes += 1;
      continue;
    }
    const saved = addMemory(pid, {
      content: d.content,
      keywords: d.keywords,
      importance: d.importance,
      category: d.category,
      unresolved: d.unresolved,
      layer: d.layer,
      tags: [tag],
      source_start_ts,
      source_end_ts,
      valence: 0,
      arousal: 0.4,
    });
    if (saved && saved.memory) added.push(saved.memory);
  }

  if (advanceAnchor) setAnchorTs(pid, batchEndTs);
  const after = digestStatus(pid);
  return {
    ok: true,
    peerId: pid,
    added,
    skipped_dupes,
    pending_left: after.pending,
    anchor_ts: advanceAnchor ? batchEndTs : getAnchorTs(pid),
    tokens_used: used,
    message:
      added.length > 0
        ? "记入 " + added.length + " 条"
        : skipped_dupes
          ? "没有新内容（与已有重复）"
          : "模型认为这段没什么要记的",
  };
}

async function digestNewMemories(peerId) {
  const {
    withPeer,
    listMessages,
    llmContent,
    budgetExhausted,
    readAll,
  } = require("./daily-chat");
  const pid = normalizePeerId(peerId);

  return withPeer(pid, async () => {
    const state = readAll();
    if (budgetExhausted(state)) {
      const err = new Error("额度不足，无法总结记忆");
      err.code = "budget_exhausted";
      throw err;
    }
    const anchorTs = getAnchorTs(pid);
    const msgs = listMessages().messages || [];
    const lines = [];
    for (const m of msgs) {
      const ts = Number(m && m.ts) || 0;
      if (ts <= anchorTs) continue;
      const text = String(llmContent(m) || "").trim();
      if (!text) continue;
      const who = m.from === "bot" ? "家机" : "用户";
      lines.push({
        ts,
        line: who + "：" + text.slice(0, 220),
      });
      if (lines.length >= DIGEST_BATCH) break;
    }
    if (!lines.length) {
      return {
        ok: true,
        peerId: pid,
        added: [],
        skipped_dupes: 0,
        pending_left: 0,
        anchor_ts: anchorTs,
        message: "没有新对话可总结",
      };
    }
    return runDigestOnLines(pid, lines, { tag: "digest" });
  });
}

/**
 * IB M7：只用选中消息生成记忆（不推进 digest 锚点）。
 * 须在 withPeer / withPeerTopic 上下文中调用。
 */
async function digestFromMessageIds(messageIds) {
  const {
    listMessages,
    llmContent,
    budgetExhausted,
    readAll,
    currentPeerId,
  } = require("./daily-chat");
  const pid = normalizePeerId(currentPeerId());
  const state = readAll();
  if (budgetExhausted(state)) {
    const err = new Error("额度不足，无法总结记忆");
    err.code = "budget_exhausted";
    throw err;
  }
  const idSet = new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );
  if (!idSet.size) {
    const err = new Error("先选中消息");
    err.code = "bad_digest_ids";
    throw err;
  }
  const msgs = (listMessages().messages || [])
    .filter((m) => m && idSet.has(String(m.id)))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const lines = [];
  for (const m of msgs) {
    const text = String(llmContent(m) || "").trim();
    if (!text) continue;
    const who = m.from === "bot" ? "家机" : "用户";
    lines.push({
      ts: Number(m.ts) || 0,
      line: who + "：" + text.slice(0, 220),
    });
    if (lines.length >= DIGEST_BATCH) break;
  }
  if (!lines.length) {
    return {
      ok: true,
      peerId: pid,
      added: [],
      skipped_dupes: 0,
      pending_left: digestStatus(pid).pending,
      anchor_ts: getAnchorTs(pid),
      message: "选中的消息没有可总结正文",
    };
  }
  return runDigestOnLines(pid, lines, {
    skipAnchor: true,
    tag: "digest-select",
  });
}

(function selfCheck() {
  const fake = normalizeMemory(
    {
      content: "喜欢草莓蛋糕",
      importance: 8,
      arousal: 0.5,
      activation_count: 2,
      ts: Date.now(),
    },
    Date.now()
  );
  if (!fake || !(fake.decay_score > 0)) throw new Error("memory decay");
  const old = normalizeMemory(
    {
      content: "很久以前的事",
      importance: 3,
      arousal: 0.2,
      activation_count: 1,
      ts: Date.now() - 40 * 24 * 3600 * 1000,
    },
    Date.now()
  );
  if (!old || !(fake.decay_score > old.decay_score)) {
    throw new Error("memory rank");
  }
  {
    const j = parseDehydrateJson(
      '废话\n```json\n{"content":"合一条","keywords":["a"],"importance":5,"drop_ids":["1","2"]}\n```'
    );
    if (!j || j.content !== "合一条" || j.drop_ids.length !== 2) {
      throw new Error("dehydrate json");
    }
  }
  const draft = draftExtract("我喜欢草莓蛋糕");
  if (!draft || draft.content.indexOf("草莓") < 0) throw new Error("memory extract");
  if (draftExtract("嗯。") != null) throw new Error("memory skip chitchat");
  const kw = normalizeMemory(
    { content: "周末要买草莓", keywords: "草莓,周末", unresolved: true },
    Date.now()
  );
  if (!kw || !kw.unresolved || kw.keywords.indexOf("草莓") < 0) {
    throw new Error("memory keywords");
  }
  if (!memoryMatchesQuery(kw, "草莓") || memoryMatchesQuery(kw, "香蕉")) {
    throw new Error("memory search");
  }
  const parsed = parseDigestItems(
    '[{"content":"对方喜欢草莓蛋糕","keywords":["草莓"],"importance":7,"category":"偏好","unresolved":false}]'
  );
  if (parsed.length !== 1 || parsed[0].content.indexOf("草莓") < 0) {
    throw new Error("digest parse");
  }
  if (parseDigestItems("不是json").length !== 0) throw new Error("digest empty");
  const tok = tokenizeQuery("我周末想吃草莓蛋糕 OK");
  if (tok.indexOf("草莓") < 0 && tok.indexOf("草莓蛋糕") < 0) {
    throw new Error("tokenize zh");
  }
  const openM = normalizeMemory(
    {
      content: "记得提醒对方买草莓",
      keywords: ["草莓"],
      unresolved: true,
      importance: 5,
      ts: Date.now(),
    },
    Date.now()
  );
  const coldM = normalizeMemory(
    {
      content: "很久以前聊过天气",
      keywords: ["天气"],
      importance: 3,
      ts: Date.now() - 20 * 24 * 3600 * 1000,
    },
    Date.now()
  );
  if (keywordHitScore(openM, ["草莓"]) < 1) throw new Error("kw hit");
  if (!(turnRankScore(openM, ["草莓"]) > turnRankScore(coldM, ["草莓"]))) {
    throw new Error("turn rank");
  }
  if (instantSentinel("嗯。").mode !== "skip") throw new Error("sentinel skip");
  if (instantSentinel("好").mode !== "skip") throw new Error("sentinel short");
  if (instantSentinel("记得上次草莓吗").mode !== "search") {
    throw new Error("sentinel force");
  }
  if (instantSentinel("哈哈").mode === "search") throw new Error("sentinel chat");
  const mid = instantSentinel("今天天气不错");
  if (mid.mode !== "search" && mid.mode !== "open_only") {
    throw new Error("sentinel mid");
  }
  if (Math.abs(cosineSim([1, 0], [1, 0]) - 1) > 1e-6) throw new Error("cos1");
  if (cosineSim([1, 0], [0, 1]) > 0.01) throw new Error("cos0");
  if (!sanitizeEmbedding([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])) {
    throw new Error("emb sanitize");
  }
})();

/**
 * 原文追溯：按记忆上的 source_start/end_ts 回聊天消息窗口。
 */
function traceMemorySource(peerId, memoryId) {
  const pid = normalizePeerId(peerId);
  const mid = String(memoryId || "").trim();
  const store = readStore();
  const list = Array.isArray(store.peers[pid]) ? store.peers[pid] : [];
  const m = list.map((x) => normalizeMemory(x)).find((x) => x && x.id === mid);
  if (!m) {
    const err = new Error("记忆不存在");
    err.code = "memory_missing";
    throw err;
  }
  const start = Math.max(0, Number(m.source_start_ts) || 0);
  const end = Math.max(start, Number(m.source_end_ts) || start);
  let messages = [];
  try {
    const { withPeer, listMessages, llmContent } = require("./daily-chat");
    messages = withPeer(pid, () => {
      const msgs = (listMessages().messages || []).filter((msg) => {
        const ts = Number(msg && msg.ts) || 0;
        if (!start && !end) return false;
        if (start && ts < start - 1000) return false;
        if (end && ts > end + 1000) return false;
        return !!String(llmContent(msg) || "").trim();
      });
      return msgs.slice(0, 40).map((msg) => ({
        id: msg.id,
        from: msg.from,
        ts: msg.ts,
        kind: msg.kind,
        preview: String(llmContent(msg) || "").slice(0, 160),
      }));
    });
  } catch (_) {
    messages = [];
  }
  return {
    ok: true,
    peerId: pid,
    memory: m,
    source_start_ts: start,
    source_end_ts: end,
    messages,
  };
}

/** 从模型正文抠出脱水 JSON（容错 markdown / 前后废话） */
function parseDehydrateJson(raw) {
  let t = String(raw || "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object") return o;
  } catch (_) {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(t.slice(start, end + 1));
    return o && typeof o === "object" ? o : null;
  } catch (_) {
    return null;
  }
}

/**
 * 脱水合并：挑 decay 低、内容相近的条，LLM 合并成一条并删旧（计额度）。
 */
async function dehydrateMemories(peerId, opts) {
  const {
    withPeer,
    addTokensUsed,
    budgetExhausted,
    readAll,
  } = require("./daily-chat");
  const chatCompletion =
    (opts && typeof opts.chatCompletion === "function" && opts.chatCompletion) ||
    require("../../共读app/gateway/llm").chatCompletion;
  const pid = normalizePeerId(peerId);
  const limit = Math.max(2, Math.min(12, Number((opts && opts.limit) || 8)));

  return withPeer(pid, async () => {
    const state = readAll();
    if (budgetExhausted(state)) {
      const err = new Error("额度不足，无法脱水");
      err.code = "budget_exhausted";
      throw err;
    }
    const listed = listPeerMemories(pid, {}).memories || [];
    const candidates = listed
      .filter((m) => {
        const tags = m.tags || [];
        return !tags.includes("digest") && !tags.includes("dehydrate");
      })
      .filter((m) => !m.pinned && !m.must_read)
      .sort((a, b) => (a.decay_score || 0) - (b.decay_score || 0))
      .slice(0, limit);
    if (candidates.length < 2) {
      return {
        ok: true,
        peerId: pid,
        merged: null,
        removed: [],
        message: "可脱水条数不足",
      };
    }
    const system =
      "你是记忆库脱水员。把多条相近记忆合并成 1 条短记。" +
      "只输出 JSON：{\"content\":\"合并后一句\",\"keywords\":[\"词\"],\"importance\":1到10," +
      "\"drop_ids\":[\"应删除的原id\"]}。" +
      "drop_ids 填全部候选 id（至少 2 个）；content≤80字；不要 markdown。";
    const user =
      "候选：\n" +
      candidates
        .map(
          (m) =>
            m.id +
            " | " +
            (m.content || "").slice(0, 80) +
            " | kw=" +
            (m.keywords || []).slice(0, 4).join(",")
        )
        .join("\n");
    let raw;
    try {
      raw = await chatCompletion({
        system,
        user,
        think: false,
        replyKind: "chat",
      });
    } catch (e) {
      const err = new Error((e && e.message) || "脱水请求失败");
      err.code = (e && e.code) || "llm_failed";
      throw err;
    }
    const used =
      (Number(raw && raw.tokens_in) || 0) +
        (Number(raw && raw.tokens_out) || 0) || 400;
    addTokensUsed(used);
    let parsed = parseDehydrateJson(raw && raw.content);
    if (!parsed || !String(parsed.content || "").trim()) {
      return {
        ok: true,
        peerId: pid,
        merged: null,
        removed: [],
        message: "模型未给出可合并结果",
      };
    }
    const idSet = new Set(candidates.map((m) => m.id));
    let toDrop = Array.isArray(parsed.drop_ids)
      ? parsed.drop_ids.map(String).filter((id) => idSet.has(id))
      : [];
    /* 模型漏 drop：有正文就删掉全部候选（合并结果另存） */
    if (toDrop.length < 2) {
      toDrop = candidates.map((m) => m.id);
    }
    const srcStart = Math.min(
      ...candidates.map((m) => Number(m.source_start_ts) || m.ts || Date.now())
    );
    const srcEnd = Math.max(
      ...candidates.map((m) => Number(m.source_end_ts) || m.ts || Date.now())
    );
    const saved = addMemory(pid, {
      content: String(parsed.content).trim().slice(0, 80),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      importance: parsed.importance,
      category: "日常",
      tags: ["dehydrate"],
      source_start_ts: srcStart,
      source_end_ts: srcEnd,
      valence: 0,
      arousal: 0.35,
    });
    const removed = [];
    for (const id of toDrop) {
      try {
        deleteMemory(pid, id);
        removed.push(id);
      } catch (_) {}
    }
    return {
      ok: true,
      peerId: pid,
      merged: saved && saved.memory,
      removed,
    };
  });
}

/**
 * LLM 哨兵：规则版 instantSentinel 不够时，用短模型判是否该立刻记一条。
 */
async function llmSentinelRoute(peerId, text) {
  const q = String(text || "").trim().slice(0, 400);
  if (!q) return { ok: true, route: "skip", via: "empty" };
  const rule = instantSentinel(q);
  if (rule && rule.force) {
    return { ok: true, route: "write", via: "rule", rule };
  }
  try {
    const { chatCompletion } = require("../../共读app/gateway/llm");
    const { readSettings } = require("../../共读app/gateway/settings");
    const s = readSettings();
    const model = String(s.sentinel_model || "").trim() || undefined;
    const raw = await chatCompletion({
      system:
        '判断这句话是否值得立刻写入长期记忆。只输出 JSON：{"write":true或false,"reason":"短"}',
      user: q,
      think: false,
      replyKind: "chat",
      model,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(
        String((raw && raw.content) || "")
          .replace(/```json|```/g, "")
          .trim()
      );
    } catch (_) {
      parsed = null;
    }
    return {
      ok: true,
      route: parsed && parsed.write ? "write" : "skip",
      via: "llm",
      reason: parsed && parsed.reason,
      rule,
    };
  } catch (e) {
    return {
      ok: true,
      route: rule && rule.hint ? "hint" : "skip",
      via: "rule_fallback",
      rule,
      error: (e && e.message) || "llm",
    };
  }
}

module.exports = {
  listPeerMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  toggleUnresolved,
  recallTopK,
  recallForTurn,
  buildMemoryPrompt,
  instantSentinel,
  hydrateEmbedding,
  cosineSim,
  maybeExtractMemory,
  digestStatus,
  digestNewMemories,
  digestFromMessageIds,
  dehydrateMemories,
  parseDehydrateJson,
  traceMemorySource,
  llmSentinelRoute,
  getAnchorTs,
  setAnchorTs,
  parseDigestItems,
  tokenizeQuery,
  keywordHitScore,
  computeDecayScore,
  MEMORY_PATH,
  ANCHOR_PATH,
  TOP_K,
};
