const fs = require("node:fs");
const path = require("node:path");
const { fetchBookmarks, fetchMyReviews } = require("./weread");
const { readBooks } = require("./books");

const DATA_DIR = path.join(__dirname, "..", "data");
const HIGHLIGHTS_PATH = path.join(DATA_DIR, "highlights.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HIGHLIGHTS_PATH)) {
    fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify({ byBook: {} }, null, 2), "utf8");
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(HIGHLIGHTS_PATH, "utf8"));
    return { byBook: raw.byBook && typeof raw.byBook === "object" ? raw.byBook : {} };
  } catch {
    return { byBook: {} };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function findBook(bookKey) {
  const books = readBooks().books;
  return (
    books.find((b) => b.id === bookKey) ||
    books.find((b) => String(b.weread_id) === String(bookKey)) ||
    null
  );
}

function getHighlights(bookKey) {
  const book = findBook(bookKey);
  const key = book ? book.id : String(bookKey);
  const all = readAll();
  return {
    book_id: key,
    weread_id: book ? book.weread_id || null : null,
    highlights: all.byBook[key] || [],
  };
}

function chapterTitleMap(chapters) {
  const map = {};
  for (const c of chapters || []) {
    if (c.chapterUid != null) map[String(c.chapterUid)] = c.title || "";
  }
  return map;
}

function mapBookmark(item, book, titles) {
  return {
    id: String(item.bookmarkId),
    book_id: book.id,
    weread_id: String(book.weread_id),
    weread_mark_id: String(item.bookmarkId),
    kind: "highlight",
    text: item.markText || "",
    idea: null,
    chapter_uid: item.chapterUid != null ? String(item.chapterUid) : null,
    chapter_title: titles[String(item.chapterUid)] || null,
    created_at: item.createTime || 0,
  };
}

function mapReview(item, book) {
  const r = item.review || item;
  return {
    id: "rv-" + String(r.reviewId || item.reviewId),
    book_id: book.id,
    weread_id: String(book.weread_id),
    weread_mark_id: String(r.reviewId || item.reviewId),
    kind: "idea",
    text: r.abstract || "",
    idea: r.content || "",
    chapter_uid: r.chapterUid != null ? String(r.chapterUid) : null,
    chapter_title: r.chapterName || null,
    created_at: r.createTime || 0,
  };
}

/**
 * 从微信读书同步一书的划线 + 想法，写入本机。
 * bookKey: 本地 id 或 weread_id
 */
async function syncHighlights(apiKey, bookKey) {
  const book = findBook(bookKey);
  if (!book || !book.weread_id) {
    const err = new Error("该书没有微信读书 bookId，无法同步划线");
    err.code = "no_weread_id";
    throw err;
  }

  const [bm, rv] = await Promise.all([
    fetchBookmarks(apiKey, book.weread_id),
    fetchMyReviews(apiKey, book.weread_id).catch(() => ({ reviews: [] })),
  ]);

  const titles = chapterTitleMap(bm.chapters);
  const highlights = (bm.updated || []).map((item) => mapBookmark(item, book, titles));
  const ideas = (rv.reviews || []).map((item) => mapReview(item, book));

  for (const idea of ideas) {
    if (!idea.text) continue;
    const hit = highlights.find((h) => h.text === idea.text);
    if (hit && idea.idea) hit.idea = idea.idea;
  }
  const orphanIdeas = ideas.filter((idea) => {
    if (!idea.idea) return false;
    if (!idea.text) return true;
    return !highlights.some((h) => h.text === idea.text);
  });

  const merged = [...highlights, ...orphanIdeas].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0)
  );

  const all = readAll();
  const prev = all.byBook[book.id] || [];
  const prevMap = Object.fromEntries(prev.map((h) => [h.id, h]));
  for (const h of merged) {
    const old = prevMap[h.id];
    if (old && old.follow) h.follow = old.follow;
    if (old && old.follow_error) h.follow_error = old.follow_error;
  }
  all.byBook[book.id] = merged;
  writeAll(all);

  return {
    book_id: book.id,
    weread_id: book.weread_id,
    count: merged.length,
    highlights: merged,
  };
}

module.exports = {
  getHighlights,
  syncHighlights,
  findBook,
  readAll,
  writeAll,
  HIGHLIGHTS_PATH,
};
