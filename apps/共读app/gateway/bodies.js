/**
 * 一书一份本地正文（M4.1 最小：.txt 入库 / 读回）。
 * 文件：data/bodies/{safeId}.txt；元数据写在 books.json 对应书上。
 */
const fs = require("node:fs");
const path = require("node:path");
const { readBooks, writeBooks } = require("./books");

const DATA_DIR = path.join(__dirname, "..", "data");
const BODIES_DIR = path.join(DATA_DIR, "bodies");
/** ponytail: 先挡离谱体积；大书/分卷再抬或改流式 */
const BODY_MAX_CHARS = 2 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(BODIES_DIR)) fs.mkdirSync(BODIES_DIR, { recursive: true });
}

function safeBodyKey(bookId) {
  return String(bookId || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function bodyPath(bookId) {
  const key = safeBodyKey(bookId);
  if (!key) {
    const err = new Error("无效的书 id");
    err.code = "bad_book_id";
    throw err;
  }
  return path.join(BODIES_DIR, key + ".txt");
}

function findBookIndex(books, bookId) {
  const id = String(bookId || "");
  return books.findIndex(
    (x) => x.id === id || String(x.weread_id) === id
  );
}

function normalizeText(raw) {
  return String(raw == null ? "" : raw).replace(/^\uFEFF/, "");
}

/** [{ title, offset }]；txt 可空；offset 夹在 [0, textLen] */
function normalizeChapters(chapters, textLen) {
  const lim = Math.max(0, Math.floor(Number(textLen)) || 0);
  if (!Array.isArray(chapters) || !chapters.length) return [];
  const out = [];
  for (const c of chapters) {
    if (!c || typeof c !== "object") continue;
    const title = String(c.title == null ? "" : c.title)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    let offset = Math.floor(Number(c.offset));
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    if (offset > lim) offset = lim;
    out.push({ title: title || "未命名", offset });
  }
  out.sort((a, b) => a.offset - b.offset || a.title.localeCompare(b.title, "zh"));
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].offset === c.offset) {
      dedup[dedup.length - 1] = c;
      continue;
    }
    dedup.push(c);
  }
  return dedup;
}

function fileExists(bookId) {
  try {
    return fs.existsSync(bodyPath(bookId));
  } catch {
    return false;
  }
}

/** 把磁盘真相刷到书对象上的 has_body / body_chars（不写盘） */
function syncBodyMeta(b) {
  if (!b || b.id === "seed-placeholder") {
    if (b) {
      b.has_body = false;
      b.body_chars = 0;
    }
    return b;
  }
  const p = bodyPath(b.id);
  if (!fs.existsSync(p)) {
    b.has_body = false;
    if (b.body_chars == null) b.body_chars = 0;
    return b;
  }
  b.has_body = true;
  if (b.body_chars == null || !Number.isFinite(Number(b.body_chars))) {
    try {
      const text = fs.readFileSync(p, "utf8");
      b.body_chars = text.length;
    } catch {
      b.body_chars = 0;
    }
  }
  return b;
}

function annotateBooksBody(books) {
  for (const b of books) syncBodyMeta(b);
  return books;
}

function putBookBody(bookId, textIn, { filename, chapters } = {}) {
  const { books } = readBooks();
  const i = findBookIndex(books, bookId);
  if (i < 0) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const b = books[i];
  if (b.id === "seed-placeholder") {
    const err = new Error("请先同步书架，再导入正文");
    err.code = "book_not_found";
    throw err;
  }
  const text = normalizeText(textIn);
  if (!text.trim()) {
    const err = new Error("正文是空的");
    err.code = "empty_body";
    throw err;
  }
  if (text.length > BODY_MAX_CHARS) {
    const err = new Error("正文太大（约上限 " + BODY_MAX_CHARS + " 字）");
    err.code = "body_too_large";
    throw err;
  }
  ensureDir();
  fs.writeFileSync(bodyPath(b.id), text, "utf8");
  b.has_body = true;
  b.body_chars = text.length;
  b.body_filename = filename ? String(filename).slice(0, 200) : null;
  b.body_updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  // chapters === undefined 时清空（重导 txt）；显式 [] 也清空
  b.body_chapters = normalizeChapters(chapters, text.length);
  b.has_chapters = b.body_chapters.length >= 2;
  writeBooks(books);
  return {
    book: b,
    chars: text.length,
    filename: b.body_filename,
    chapters: b.body_chapters,
  };
}

function getBookBody(bookId) {
  const { books } = readBooks();
  const i = findBookIndex(books, bookId);
  if (i < 0) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const b = books[i];
  const p = bodyPath(b.id);
  if (!fs.existsSync(p)) {
    const err = new Error("这本书还没有本地正文");
    err.code = "no_body";
    throw err;
  }
  const text = fs.readFileSync(p, "utf8");
  syncBodyMeta(b);
  let dirty = false;
  if (b.body_chars !== text.length) {
    b.body_chars = text.length;
    b.has_body = true;
    dirty = true;
  }
  const chapters = normalizeChapters(b.body_chapters, text.length);
  if (JSON.stringify(chapters) !== JSON.stringify(b.body_chapters || [])) {
    b.body_chapters = chapters;
    dirty = true;
  }
  b.has_chapters = chapters.length >= 2;
  if (dirty) writeBooks(books);
  return {
    book_id: b.id,
    text,
    chars: text.length,
    filename: b.body_filename || null,
    updated_at: b.body_updated_at || null,
    chapters,
  };
}

/** 删正文文件（书条目可已不在）；不存在则忽略 */
function deleteBookBodyFile(bookId) {
  try {
    const p = bodyPath(bookId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

/** 微信同步合并时保留正文元数据 */
function copyBodyFields(from, to) {
  if (!from || !to) return to;
  if (from.has_body) to.has_body = true;
  if (from.body_chars != null) to.body_chars = from.body_chars;
  if (from.body_filename) to.body_filename = from.body_filename;
  if (from.body_updated_at) to.body_updated_at = from.body_updated_at;
  if (Array.isArray(from.body_chapters)) {
    to.body_chapters = from.body_chapters.slice();
    to.has_chapters = from.body_chapters.length >= 2;
  }
  return to;
}

module.exports = {
  BODY_MAX_CHARS,
  BODIES_DIR,
  putBookBody,
  getBookBody,
  deleteBookBodyFile,
  annotateBooksBody,
  syncBodyMeta,
  copyBodyFields,
  normalizeChapters,
  fileExists,
  safeBodyKey,
};

if (require.main === module) {
  console.assert(safeBodyKey("wr-123") === "wr-123");
  console.assert(safeBodyKey("../x") === ".._x" || safeBodyKey("../x").indexOf("..") >= 0);
  console.assert(!safeBodyKey("../x").includes("/") && !safeBodyKey("../x").includes("\\"));
  const tmpId = "selfcheck-body-" + Date.now();
  const { writeBooks, readBooks } = require("./books");
  const prev = readBooks().books;
  writeBooks([
    ...prev.filter((b) => b.id !== tmpId),
    {
      id: tmpId,
      title: "自检",
      author: "",
      source: "local",
      passes: [1],
      active_pass: 1,
      in_progress: false,
    },
  ]);
  const sample = "第一行\n第二行";
  const put = putBookBody(tmpId, "\uFEFF" + sample, { filename: "a.txt" });
  console.assert(put.chars === sample.length, put);
  console.assert(Array.isArray(put.chapters) && put.chapters.length === 0, put.chapters);
  const withCh = putBookBody(tmpId, "AAA\n\nBBB", {
    filename: "a.epub",
    chapters: [
      { title: "一", offset: 0 },
      { title: "二", offset: 5 },
    ],
  });
  console.assert(withCh.chapters.length === 2 && withCh.book.has_chapters, withCh);
  const got = getBookBody(tmpId);
  console.assert(got.text === "AAA\n\nBBB", got.text);
  console.assert(got.chapters[1].title === "二" && got.chapters[1].offset === 5, got.chapters);
  try {
    fs.unlinkSync(bodyPath(tmpId));
  } catch (_) {}
  writeBooks(prev);
  console.log("bodies.js self-check ok");
}
