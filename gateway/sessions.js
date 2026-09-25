const fs = require("node:fs");
const path = require("node:path");
const { getHighlights, findBook } = require("./highlights");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_PATH)) {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify({ sessions: [] }, null, 2), "utf8");
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
    return { sessions: Array.isArray(raw.sessions) ? raw.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function listSessions() {
  return readAll();
}

function getSession(id) {
  return readAll().sessions.find((s) => s.id === id) || null;
}

/** 本场：划线 created_at / 跟批 follow.at 落在 [startedAt, endedAt] */
function buildSummary(bookKey, startedAt, endedAt = Date.now()) {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const start = Number(startedAt) || endedAt;
  const end = Number(endedAt) || Date.now();
  const inRange = (t) => {
    const n = Number(t) || 0;
    return n >= start && n <= end;
  };

  const highlights = getHighlights(book.id).highlights || [];
  const hlNew = highlights.filter((h) => h.kind !== "idea" && inRange(h.created_at));
  const followed = highlights.filter((h) => h.follow && inRange(h.follow.at));
  let tokens_in = 0;
  let tokens_out = 0;
  for (const h of followed) {
    tokens_in += Number(h.follow.tokens_in) || 0;
    tokens_out += Number(h.follow.tokens_out) || 0;
  }

  return {
    book_id: book.id,
    book_title: book.title || "未命名",
    started_at: start,
    ended_at: end,
    duration_ms: Math.max(0, end - start),
    highlight_count: hlNew.length,
    follow_count: followed.length,
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
  };
}

function endSession(bookKey, startedAt) {
  const summary = buildSummary(bookKey, startedAt);
  const session = {
    id: "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    ...summary,
  };
  const all = readAll();
  all.sessions.unshift(session);
  writeAll(all);
  return session;
}

function formatDurationMs(ms) {
  const m = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (m < 60) return m + " 分钟";
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + " 小时" + (rm ? " " + rm + " 分" : "");
}

if (require.main === module) {
  console.assert(formatDurationMs(90 * 1000) === "2 分钟");
  console.assert(formatDurationMs(125 * 60000) === "2 小时 5 分");
  console.assert(formatDurationMs(0) === "0 分钟");
  console.log("sessions ok");
}

module.exports = {
  listSessions,
  getSession,
  buildSummary,
  endSession,
  formatDurationMs,
  SESSIONS_PATH,
};
