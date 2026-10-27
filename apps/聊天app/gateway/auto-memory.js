/**
 * H6 Auto Memory：「你对我的了解」档案（≠ 海马体记忆库）。
 * 按 peer 分桶；分类 / 优先级 / 字数预算 / 静默；聊天工具写入。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "auto-memory.json");

const BODY_MAX = 600;
const ALWAYS_MAX = 3;
const ENTRIES_MAX = 80;
const BUDGET_MIN = 300;
const BUDGET_MAX = 6000;
const BUDGET_DEFAULT = 2000;
const OPS_MAX_PER_REPLY = 3;

const CATEGORIES = new Set([
  "work",
  "personal",
  "top_of_mind",
  "history",
  "background",
  "instructions",
]);

const CATEGORY_LABELS = {
  work: "工作",
  personal: "个人",
  top_of_mind: "此刻",
  history: "履历",
  background: "背景",
  instructions: "叮嘱",
};

const PRIORITIES = new Set(["always", "normal", "low"]);

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
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

function clampBudget(n) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x <= 0) return BUDGET_DEFAULT;
  return Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, x));
}

function normalizeCategory(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const aliases = {
    工作: "work",
    个人: "personal",
    此刻: "top_of_mind",
    top: "top_of_mind",
    tom: "top_of_mind",
    履历: "history",
    背景: "background",
    叮嘱: "instructions",
    指令: "instructions",
  };
  const hit = aliases[s] || s;
  return CATEGORIES.has(hit) ? hit : "personal";
}

function normalizePriority(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "high" || s === "core" || s === "必记") return "always";
  if (s === "low" || s === "次要") return "low";
  if (PRIORITIES.has(s)) return s;
  return "normal";
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
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
    STORE_PATH,
    JSON.stringify({ version: 1, peers: store.peers || {} }, null, 2),
    "utf8"
  );
}

function peerBucket(store, peerId) {
  const pid = normalizePeerId(peerId);
  if (!store.peers[pid] || typeof store.peers[pid] !== "object") {
    store.peers[pid] = { entries: [] };
  }
  if (!Array.isArray(store.peers[pid].entries)) store.peers[pid].entries = [];
  return store.peers[pid];
}

function normalizeEntry(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  const body = String(raw.body || raw.content || "").trim().slice(0, BODY_MAX);
  if (!body) return null;
  const out = {
    id: id || String(raw.id || "").trim() || randomUUID(),
    category: normalizeCategory(raw.category),
    priority: normalizePriority(raw.priority),
    body,
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
  return out;
}

function countAlways(entries, exceptId) {
  return (entries || []).filter(
    (e) =>
      e &&
      e.priority === "always" &&
      (!exceptId || e.id !== exceptId)
  ).length;
}

function totalChars(entries) {
  return (entries || []).reduce(
    (n, e) => n + String((e && e.body) || "").length,
    0
  );
}

function listEntries(peerId, opts) {
  const store = readStore();
  const bucket = peerBucket(store, peerId);
  let entries = (bucket.entries || []).slice();
  const cat = opts && opts.category ? normalizeCategory(opts.category) : "";
  if (opts && opts.category) {
    entries = entries.filter((e) => e.category === cat);
  }
  const q = String((opts && opts.q) || "")
    .trim()
    .toLowerCase();
  if (q) {
    entries = entries.filter((e) => {
      const blob = (
        e.body +
        " " +
        e.category +
        " " +
        (CATEGORY_LABELS[e.category] || "") +
        " " +
        e.priority
      ).toLowerCase();
      return blob.includes(q);
    });
  }
  entries.sort((a, b) => {
    const pa = a.priority === "always" ? 0 : a.priority === "normal" ? 1 : 2;
    const pb = b.priority === "always" ? 0 : b.priority === "normal" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
  const limit = Math.max(1, Math.min(80, Math.floor(Number(opts && opts.limit) || 40)));
  return {
    ok: true,
    peerId: normalizePeerId(peerId),
    entries: entries.slice(0, limit),
    chars: totalChars(bucket.entries),
    always: countAlways(bucket.entries),
  };
}

function upsertEntry(peerId, patch) {
  const store = readStore();
  const bucket = peerBucket(store, peerId);
  const id = String((patch && patch.id) || "").trim();
  const now = Date.now();
  if (id) {
    const i = bucket.entries.findIndex((e) => e && e.id === id);
    if (i < 0) {
      const err = new Error("档案条目不存在");
      err.code = "auto_memory_missing";
      throw err;
    }
    const prev = bucket.entries[i];
    const next = normalizeEntry(
      {
        ...prev,
        category:
          patch.category != null ? patch.category : prev.category,
        priority:
          patch.priority != null ? patch.priority : prev.priority,
        body: patch.body != null ? patch.body : prev.body,
        created_at: prev.created_at,
        updated_at: now,
      },
      id
    );
    if (!next) {
      const err = new Error("档案正文不能为空");
      err.code = "bad_auto_memory";
      throw err;
    }
    if (
      next.priority === "always" &&
      countAlways(bucket.entries, id) >= ALWAYS_MAX
    ) {
      const err = new Error("核心事实最多 " + ALWAYS_MAX + " 条");
      err.code = "auto_memory_always_full";
      throw err;
    }
    bucket.entries[i] = next;
    writeStore(store);
    return { ok: true, entry: next, created: false };
  }
  if (bucket.entries.length >= ENTRIES_MAX) {
    const err = new Error("档案条数已满");
    err.code = "auto_memory_full";
    throw err;
  }
  const entry = normalizeEntry(
    {
      category: patch && patch.category,
      priority: patch && patch.priority,
      body: patch && patch.body,
      created_at: now,
      updated_at: now,
    },
    randomUUID()
  );
  if (!entry) {
    const err = new Error("档案正文不能为空");
    err.code = "bad_auto_memory";
    throw err;
  }
  if (
    entry.priority === "always" &&
    countAlways(bucket.entries) >= ALWAYS_MAX
  ) {
    const err = new Error("核心事实最多 " + ALWAYS_MAX + " 条");
    err.code = "auto_memory_always_full";
    throw err;
  }
  bucket.entries.push(entry);
  writeStore(store);
  return { ok: true, entry, created: true };
}

function deleteEntry(peerId, id) {
  const store = readStore();
  const bucket = peerBucket(store, peerId);
  const want = String(id || "").trim();
  const n = bucket.entries.length;
  bucket.entries = bucket.entries.filter((e) => e && e.id !== want);
  if (bucket.entries.length === n) {
    const err = new Error("档案条目不存在");
    err.code = "auto_memory_missing";
    throw err;
  }
  writeStore(store);
  return { ok: true, id: want };
}

/**
 * 注入 system：always 全带，其余按更新时间填满预算。
 * mute 时返回空。
 */
function buildAutoMemoryPrompt(peerId, opts) {
  if (opts && opts.mute) return "";
  const listed = listEntries(peerId, { limit: ENTRIES_MAX });
  const entries = listed.entries || [];
  if (!entries.length) return "";
  const budget = clampBudget(opts && opts.budget);
  const picked = [];
  let used = 0;
  const always = entries.filter((e) => e.priority === "always");
  const rest = entries.filter((e) => e.priority !== "always");
  for (const e of always) {
    const line =
      "·[" +
      (CATEGORY_LABELS[e.category] || e.category) +
      "/核心] " +
      e.body;
    if (used + line.length > budget && picked.length) break;
    picked.push(line);
    used += line.length + 1;
  }
  for (const e of rest) {
    const tag = e.priority === "low" ? "/次" : "";
    const line =
      "·[" +
      (CATEGORY_LABELS[e.category] || e.category) +
      tag +
      "] " +
      e.body;
    if (used + line.length > budget) break;
    picked.push(line);
    used += line.length + 1;
  }
  if (!picked.length) return "";
  return (
    "[AUTO_MEMORY] 你对对方的长期了解（档案，≠会话记忆库；勿逐条复读，需要时自然用）：\n" +
    picked.join("\n")
  );
}

if (require.main === module) {
  const pid = "daily";
  const stamp = "am-" + Date.now();
  const a = upsertEntry(pid, {
    body: "喜欢薄巧 " + stamp,
    category: "personal",
    priority: "always",
  });
  console.assert(a.ok && a.created && a.entry.priority === "always");
  const b = upsertEntry(pid, {
    body: "在做 Ariadne " + stamp,
    category: "work",
    priority: "normal",
  });
  console.assert(b.ok && b.entry.category === "work");
  const listed = listEntries(pid, { q: stamp });
  console.assert(listed.entries.length >= 2);
  const prompt = buildAutoMemoryPrompt(pid, { budget: 2000 });
  console.assert(prompt.includes("薄巧") && prompt.includes("AUTO_MEMORY"));
  console.assert(buildAutoMemoryPrompt(pid, { mute: true }) === "");
  const upd = upsertEntry(pid, {
    id: a.entry.id,
    body: "很喜欢薄巧 " + stamp,
  });
  console.assert(upd.entry.body.startsWith("很喜欢"));
  deleteEntry(pid, a.entry.id);
  deleteEntry(pid, b.entry.id);
  console.assert(listEntries(pid, { q: stamp }).entries.length === 0);
  console.log("auto-memory ok");
}

module.exports = {
  BODY_MAX,
  ALWAYS_MAX,
  OPS_MAX_PER_REPLY,
  BUDGET_DEFAULT,
  CATEGORIES,
  CATEGORY_LABELS,
  PRIORITIES,
  listEntries,
  upsertEntry,
  deleteEntry,
  buildAutoMemoryPrompt,
  clampBudget,
  normalizeCategory,
  normalizePriority,
  normalizePeerId,
  STORE_PATH,
};
