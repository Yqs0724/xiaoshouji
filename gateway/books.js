const fs = require("node:fs");
const path = require("node:path");
const { fetchBookshelf, fetchProgress } = require("./weread");

const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKS_PATH = path.join(DATA_DIR, "books.json");

const SEED = {
  books: [
    {
      id: "seed-placeholder",
      title: "占位书",
      author: "待导入",
      progress: 0,
      source: "local",
      passes: [],
      active_pass: null,
      in_progress: false,
      updated_at: "—",
    },
  ],
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKS_PATH)) {
    fs.writeFileSync(BOOKS_PATH, JSON.stringify(SEED, null, 2), "utf8");
  }
}

function readBooks() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(BOOKS_PATH, "utf8"));
    const list = Array.isArray(raw.books) ? raw.books : Array.isArray(raw) ? raw : [];
    return { books: list };
  } catch {
    return { books: [...SEED.books] };
  }
}

function writeBooks(books) {
  ensureFile();
  fs.writeFileSync(BOOKS_PATH, JSON.stringify({ books }, null, 2), "utf8");
  return { books };
}

/** 刷次：书上 passes 为序号数组如 [1,2]，active_pass 为当前序号 */
function ensurePassOnBook(b) {
  if (!b || b.id === "seed-placeholder") return b;
  if (!Array.isArray(b.passes)) b.passes = [];
  const nums = b.passes
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  b.passes = [...new Set(nums)].sort((a, c) => a - c);
  if (!b.passes.length) {
    b.passes = [1];
    b.active_pass = 1;
  } else {
    const ap = Number(b.active_pass);
    b.active_pass = b.passes.includes(ap) ? ap : b.passes[b.passes.length - 1];
  }
  return b;
}

function ensureActivePass(bookId) {
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookId || String(x.weread_id) === String(bookId)
  );
  if (!b) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  ensurePassOnBook(b);
  writeBooks(books);
  return b;
}

function setActivePass(bookId, ordinal) {
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookId || String(x.weread_id) === String(bookId)
  );
  if (!b) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  ensurePassOnBook(b);
  const n = Number(ordinal);
  if (!b.passes.includes(n)) {
    const err = new Error("没有这一刷");
    err.code = "pass_not_found";
    throw err;
  }
  b.active_pass = n;
  writeBooks(books);
  return b;
}

function addNextPass(bookId) {
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookId || String(x.weread_id) === String(bookId)
  );
  if (!b) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  ensurePassOnBook(b);
  const next = Math.max(...b.passes) + 1;
  b.passes.push(next);
  b.active_pass = next;
  writeBooks(books);
  return b;
}

/** 按书写默认跟批方式（immersive | ideas | silent） */
function setBookDefaultMode(bookId, mode) {
  const { normalizeFollowMode } = require("./settings");
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookId || String(x.weread_id) === String(bookId)
  );
  if (!b) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  b.default_mode = normalizeFollowMode(mode);
  writeBooks(books);
  return b;
}

/** 按书写默认跟批语气（"" | short | ask | empathy） */
function setBookDefaultTone(bookId, tone) {
  const { normalizeFollowTone } = require("./settings");
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookId || String(x.weread_id) === String(bookId)
  );
  if (!b) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  b.default_tone = normalizeFollowTone(tone);
  writeBooks(books);
  return b;
}

/** 标一本为进行中（其余清掉） */
function setInProgress(bookId) {
  const { books } = readBooks();
  let hit = null;
  for (const b of books) {
    b.in_progress = b.id === bookId || String(b.weread_id) === String(bookId);
    if (b.in_progress) hit = b;
  }
  if (!hit) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  for (const b of books) b.in_progress = b.id === hit.id;
  ensurePassOnBook(hit);
  writeBooks(books);
  return hit;
}

function formatTime(unix) {
  if (!unix) return "—";
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 读书架时补齐缺失刷次（写回） */
function listBooksNormalized() {
  const { books } = readBooks();
  let dirty = false;
  for (const b of books) {
    if (b.id === "seed-placeholder") continue;
    const before = JSON.stringify(b.passes) + "|" + b.active_pass;
    ensurePassOnBook(b);
    if (JSON.stringify(b.passes) + "|" + b.active_pass !== before) dirty = true;
  }
  if (dirty) writeBooks(books);
  return { books };
}

function mapWereadBook(b) {
  return {
    id: `wr-${b.bookId}`,
    weread_id: String(b.bookId),
    title: b.title || "未命名",
    author: b.author || "",
    cover: b.cover || "",
    progress: 0, // 小屋共读进度；微信读书进度见 weread_progress
    weread_progress: null,
    weread_read_seconds: null,
    source: "weread",
    passes: [],
    active_pass: null,
    in_progress: false,
    updated_at: formatTime(b.readUpdateTime),
    read_update_time: Number(b.readUpdateTime) || 0,
    finish_reading: Number(b.finishReading) === 1,
  };
}

async function enrichWithWereadProgress(apiKey, books) {
  await Promise.all(
    books.map(async (b) => {
      if (!b.weread_id) return;
      try {
        const data = await fetchProgress(apiKey, b.weread_id);
        const book = data.book || {};
        b.weread_progress = Number(book.progress) || 0;
        // 官方文档写 recordReadingTime；实测累计时常在 readingTime（秒）
        b.weread_read_seconds =
          Number(book.readingTime) || Number(book.recordReadingTime) || 0;
      } catch {
        // 单本失败不阻断整次同步
        b.weread_progress = null;
        b.weread_read_seconds = null;
      }
    })
  );
  return books;
}

/**
 * 按需刷新一书微信进度（共读轮询用）。失败保留旧值，不抹成 null。
 */
async function refreshBookProgress(apiKey, bookKey) {
  const { books } = readBooks();
  const b = books.find(
    (x) => x.id === bookKey || String(x.weread_id) === String(bookKey)
  );
  if (!b || !b.weread_id) return null;
  const data = await fetchProgress(apiKey, b.weread_id);
  const book = data.book || {};
  b.weread_progress = Number(book.progress) || 0;
  b.weread_read_seconds =
    Number(book.readingTime) || Number(book.recordReadingTime) || 0;
  writeBooks(books);
  return b;
}

/** getprogress 只打这些本，避免 800+ 本打爆微信 API */
const PROGRESS_RECENT = 10;

/**
 * 需要拉微信进度的书：最近 N 本 + 本机标在读。
 * @param {object[]} remote 已按 read_update_time 降序
 * @param {Record<string, object>} prevById
 */
function pickProgressTargets(remote, prevById, limit = PROGRESS_RECENT) {
  const want = new Set();
  for (const b of remote.slice(0, limit)) want.add(b.id);
  for (const b of remote) {
    const old = prevById[b.id];
    if (old && old.in_progress) want.add(b.id);
  }
  return remote.filter((b) => want.has(b.id));
}

/**
 * 用微信读书 /shelf/sync 合并本机书架：
 * - 远程书全量入库（元数据）
 * - getprogress 仅最近 N 本 + 在读（ponytail: 全量 progress = O(书架) API 风暴；要实时进度时再开按需补）
 * - 保留纯本地书；未刷新进度的书沿用上次 weread_* 缓存
 */
async function syncFromWeread(apiKey) {
  const shelf = await fetchBookshelf(apiKey);
  const remote = Array.isArray(shelf.books) ? shelf.books.map(mapWereadBook) : [];
  remote.sort((a, b) => b.read_update_time - a.read_update_time);

  const prev = readBooks().books;
  const prevById = Object.fromEntries(prev.map((b) => [b.id, b]));
  const localOnly = prev.filter((b) => b.source === "local" && !b.weread_id);

  const targets = pickProgressTargets(remote, prevById);
  const targetIds = new Set(targets.map((b) => b.id));
  await enrichWithWereadProgress(apiKey, targets);

  if (remote.length) remote[0].in_progress = true;

  for (const b of remote) {
    const old = prevById[b.id];
    if (old) {
      b.passes = Array.isArray(old.passes) ? old.passes.slice() : [];
      b.active_pass = old.active_pass || null;
      b.progress = old.progress || 0;
      if (old.default_mode) b.default_mode = old.default_mode;
      if (old.default_tone != null) b.default_tone = old.default_tone;
      if (!targetIds.has(b.id)) {
        b.weread_progress =
          old.weread_progress != null ? old.weread_progress : null;
        b.weread_read_seconds =
          old.weread_read_seconds != null ? old.weread_read_seconds : null;
      }
    }
    ensurePassOnBook(b);
  }
  for (const b of localOnly) ensurePassOnBook(b);
  const books = [...remote, ...localOnly];
  writeBooks(books);
  return {
    books,
    synced: remote.length,
    progress_enriched: targets.length,
    total_remote: remote.length,
    albums: Array.isArray(shelf.albums) ? shelf.albums.length : 0,
  };
}

module.exports = {
  readBooks,
  writeBooks,
  listBooksNormalized,
  setInProgress,
  syncFromWeread,
  refreshBookProgress,
  pickProgressTargets,
  PROGRESS_RECENT,
  ensurePassOnBook,
  ensureActivePass,
  setActivePass,
  addNextPass,
  setBookDefaultMode,
  setBookDefaultTone,
  BOOKS_PATH,
};

if (require.main === module) {
  const remote = Array.from({ length: 15 }, (_, i) => ({ id: "b" + i }));
  const prev = { b14: { in_progress: true }, b12: { in_progress: false } };
  const ids = pickProgressTargets(remote, prev, 10).map((b) => b.id);
  console.assert(ids.length === 11, ids); // b0–b9 + b14
  console.assert(ids.includes("b0") && ids.includes("b14") && !ids.includes("b12"), ids);
  const { normalizeFollowTone } = require("./settings");
  console.assert(normalizeFollowTone("ask") === "ask");
  console.log("books.js self-check ok");
}
