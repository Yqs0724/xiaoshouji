const fs = require("node:fs");
const path = require("node:path");
const { fetchBookmarks, fetchMyReviews } = require("./weread");
const { readBooks, ensureActivePass } = require("./books");

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

/** 归因刷次：用书上 active_pass（开场时与本场刷次对齐） */
function resolvePassOrdinal(book) {
  if (!book) return 1;
  try {
    const ready = ensureActivePass(book.id);
    return Math.max(1, Number(ready.active_pass) || 1);
  } catch {
    return Math.max(1, Number(book.active_pass) || 1);
  }
}

function passOfHighlight(h) {
  if (!h) return 1;
  const n = Number(h.pass_ordinal);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function getHighlights(bookKey) {
  const book = findBook(bookKey);
  const key = book ? book.id : String(bookKey);
  const all = readAll();
  const raw = all.byBook[key] || [];
  const highlights = raw.map((h) =>
    h && h.pass_ordinal != null ? h : { ...h, pass_ordinal: passOfHighlight(h) }
  );
  return {
    book_id: key,
    weread_id: book ? book.weread_id || null : null,
    highlights,
    active_pass: book ? resolvePassOrdinal(book) : 1,
  };
}

/** 笔记索引：书架各书的划线/跟批数量（只读本地） */
function listNotesIndex() {
  const { books } = readBooks();
  const all = readAll();
  const items = [];
  for (const b of books) {
    if (!b || b.id === "seed-placeholder") continue;
    const list = all.byBook[b.id] || [];
    const marks = list.filter((h) => h.kind !== "idea");
    const ideas = list.filter((h) => h.kind === "idea" || (h.idea && String(h.idea).trim()));
    const followed = list.filter((h) => h.follow && h.follow.body);
    items.push({
      id: b.id,
      title: b.title || "未命名",
      author: b.author || "",
      mark_count: marks.length,
      idea_count: ideas.length,
      follow_count: followed.length,
      total: list.length,
    });
  }
  items.sort((a, b) => b.total - a.total || String(a.title).localeCompare(String(b.title), "zh"));
  return { books: items };
}

function highlightSearchBlob(h) {
  return [h && h.text, h && h.idea, h && h.chapter_title, h && h.follow && h.follow.body]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * 笔记关键词搜索（本机）。空 query → 退回索引列表。
 * 命中：书名/作者，或划线/想法/章节/跟批正文。
 */
function searchNotes(query) {
  const q = String(query || "").trim();
  if (!q) return { query: "", mode: "index", ...listNotesIndex(), hits: [] };

  const needle = q.toLowerCase();
  const { books } = readBooks();
  const all = readAll();
  const hits = [];
  const bookHits = [];

  for (const b of books) {
    if (!b || b.id === "seed-placeholder") continue;
    const title = String(b.title || "未命名");
    const author = String(b.author || "");
    const bookMatch =
      title.toLowerCase().includes(needle) || author.toLowerCase().includes(needle);
    const list = all.byBook[b.id] || [];
    let contentHits = 0;
    for (const h of list) {
      if (!highlightSearchBlob(h).includes(needle)) continue;
      contentHits += 1;
      hits.push({
        book_id: b.id,
        book_title: title,
        id: h.id,
        kind: h.kind || "highlight",
        text: h.text || "",
        idea: h.idea || "",
        chapter_title: h.chapter_title || null,
        follow_body: (h.follow && h.follow.body) || null,
      });
    }
    if (!bookMatch && !contentHits) continue;
    const marks = list.filter((h) => h.kind !== "idea");
    const ideas = list.filter((h) => h.kind === "idea" || (h.idea && String(h.idea).trim()));
    const followed = list.filter((h) => h.follow && h.follow.body);
    bookHits.push({
      id: b.id,
      title,
      author,
      mark_count: marks.length,
      idea_count: ideas.length,
      follow_count: followed.length,
      total: list.length,
      hit_count: contentHits,
      title_match: bookMatch,
    });
  }

  bookHits.sort(
    (a, b) =>
      (b.hit_count || 0) - (a.hit_count || 0) ||
      String(a.title).localeCompare(String(b.title), "zh")
  );

  return { query: q, mode: "search", books: bookHits, hits };
}

function safeFilenamePart(s) {
  return String(s || "未命名")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function contentDispositionAttachment(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_") || "export";
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function notesToMarkdown(book, highlights) {
  const title = (book && book.title) || "未命名";
  const author = (book && book.author) || "";
  const list = Array.isArray(highlights) ? highlights.slice() : [];
  list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const marks = list.filter((h) => h.kind !== "idea").length;
  const ideas = list.filter(
    (h) => h.kind === "idea" || (h.idea && String(h.idea).trim())
  ).length;
  const followed = list.filter((h) => h.follow && h.follow.body).length;
  const lines = [
    `# 《${title}》· 笔记`,
    "",
    author ? `- 作者：${author}` : null,
    `- 划线 ${marks} · 想法 ${ideas} · 跟批 ${followed} · 共 ${list.length} 条`,
    "",
  ].filter((x) => x != null);

  if (!list.length) {
    lines.push("（暂无划线）", "");
  } else {
    let lastChap = null;
    for (const h of list) {
      const chap = h.chapter_title || null;
      if (chap && chap !== lastChap) {
        lines.push(`## ${chap}`, "");
        lastChap = chap;
      }
      if (h.kind === "idea") {
        const body = String(h.idea || h.text || "").trim();
        if (body) lines.push(`想法：${body}`);
      } else if (h.text) {
        lines.push(`> ${String(h.text).replace(/\n/g, "\n> ")}`);
        if (h.idea) lines.push(`想法：${h.idea}`);
      }
      if (h.follow && h.follow.body) {
        lines.push("", `跟批：${h.follow.body}`);
      }
      lines.push("");
    }
  }

  lines.push("---", "由共读小屋导出；不含 API Key。");
  return lines.join("\n");
}

function escapeHtmlNotes(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Word / WPS 可开的 .doc（HTML Word 文档，非二进制旧 DOC） */
function notesToWordDoc(book, highlights) {
  const title = (book && book.title) || "未命名";
  const author = (book && book.author) || "";
  const list = Array.isArray(highlights) ? highlights.slice() : [];
  list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const parts = [
    "<h1>《" + escapeHtmlNotes(title) + "》· 笔记</h1>",
    author ? "<p>作者：" + escapeHtmlNotes(author) + "</p>" : "",
    "<p>共 " + list.length + " 条 · 由共读小屋导出（不含 API Key）</p>",
    "<hr/>",
  ];
  if (!list.length) {
    parts.push("<p>（暂无划线）</p>");
  } else {
    let lastChap = null;
    for (const h of list) {
      const chap = h.chapter_title || null;
      if (chap && chap !== lastChap) {
        parts.push("<h2>" + escapeHtmlNotes(chap) + "</h2>");
        lastChap = chap;
      }
      if (h.kind === "idea") {
        const body = String(h.idea || h.text || "").trim();
        if (body) parts.push("<p><b>想法：</b>" + escapeHtmlNotes(body).replace(/\n/g, "<br/>") + "</p>");
      } else if (h.text) {
        parts.push(
          "<blockquote>" + escapeHtmlNotes(h.text).replace(/\n/g, "<br/>") + "</blockquote>"
        );
        if (h.idea) {
          parts.push("<p><b>想法：</b>" + escapeHtmlNotes(h.idea).replace(/\n/g, "<br/>") + "</p>");
        }
      }
      if (h.follow && h.follow.body) {
        parts.push(
          "<p><b>跟批：</b>" + escapeHtmlNotes(h.follow.body).replace(/\n/g, "<br/>") + "</p>"
        );
      }
      parts.push("<p></p>");
    }
  }
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
    "<head><meta charset=\"utf-8\"><title>" +
    escapeHtmlNotes(title) +
    "</title>" +
    "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->" +
    "</head><body>" +
    parts.filter(Boolean).join("\n") +
    "</body></html>"
  );
}

/**
 * 按书导出笔记。format: md | json | doc（Word 可开）
 * @returns {{ filename, contentType, body, contentDisposition }}
 */
function exportNotesBook(bookKey, format = "md") {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const { highlights } = getHighlights(book.id);
  const title = book.title || "未命名";
  const base = `笔记-${safeFilenamePart(title)}`;
  const fmt = String(format || "md").toLowerCase();
  if (fmt === "json") {
    const filename = base + ".json";
    const payload = {
      exported_at: Date.now(),
      book: { id: book.id, title, author: book.author || "" },
      count: highlights.length,
      highlights: highlights.map((h) => ({
        id: h.id,
        kind: h.kind || "highlight",
        text: h.text || "",
        idea: h.idea || "",
        chapter_title: h.chapter_title || null,
        created_at: h.created_at,
        follow:
          h.follow && h.follow.body
            ? { body: h.follow.body, at: h.follow.at }
            : null,
      })),
    };
    return {
      filename,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(payload, null, 2),
      contentDisposition: contentDispositionAttachment(filename),
    };
  }
  if (fmt === "doc" || fmt === "word") {
    const filename = base + ".doc";
    return {
      filename,
      contentType: "application/msword; charset=utf-8",
      body: notesToWordDoc(book, highlights),
      contentDisposition: contentDispositionAttachment(filename),
    };
  }
  const filename = base + ".md";
  return {
    filename,
    contentType: "text/markdown; charset=utf-8",
    body: notesToMarkdown(book, highlights),
    contentDisposition: contentDispositionAttachment(filename),
  };
}

/**
 * 有笔记的书全部打成 zip。format: md | doc
 * @returns {{ filename, contentType, body: Buffer, contentDisposition }}
 */
function exportNotesAll(format = "md") {
  const { zipStore } = require("./backup");
  const fmt = String(format || "md").toLowerCase();
  const useDoc = fmt === "doc" || fmt === "word";
  const idx = listNotesIndex();
  const books = (idx.books || []).filter((b) => (b.total || 0) > 0);
  if (!books.length) {
    const err = new Error("还没有可导出的笔记");
    err.code = "no_notes";
    throw err;
  }
  const entries = [];
  for (const b of books) {
    const file = exportNotesBook(b.id, useDoc ? "doc" : "md");
    entries.push({ name: file.filename, data: file.body });
  }
  const stamp = new Date();
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const tag =
    stamp.getFullYear() +
    pad(stamp.getMonth() + 1) +
    pad(stamp.getDate()) +
    "-" +
    pad(stamp.getHours()) +
    pad(stamp.getMinutes());
  const filename = `共读笔记全部-${useDoc ? "doc" : "md"}-${tag}.zip`;
  const body = zipStore(entries);
  return {
    filename,
    contentType: "application/zip",
    body,
    contentDisposition: contentDispositionAttachment(filename),
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
  const stampPass = resolvePassOrdinal(book);
  for (const h of merged) {
    const old = prevMap[h.id];
    if (old && old.follow) h.follow = old.follow;
    if (old && old.follow_error) h.follow_error = old.follow_error;
    if (old && old.pass_ordinal != null) {
      h.pass_ordinal = passOfHighlight(old);
    } else if (old) {
      // 旧数据无刷次：归到一刷，避免切换后「消失」
      h.pass_ordinal = 1;
    } else {
      h.pass_ordinal = stampPass;
    }
  }
  all.byBook[book.id] = merged;
  writeAll(all);

  return {
    book_id: book.id,
    weread_id: book.weread_id,
    count: merged.length,
    highlights: merged,
    active_pass: stampPass,
  };
}

/**
 * 手动改划线所属刷次。pass 须已在书的 passes 里（或等于当前 active）。
 */
function setHighlightPass(bookKey, highlightId, passOrdinal) {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const hid = String(highlightId || "");
  if (!hid) {
    const err = new Error("请指定划线");
    err.code = "highlight_required";
    throw err;
  }
  const want = Math.floor(Number(passOrdinal));
  if (!Number.isFinite(want) || want < 1) {
    const err = new Error("刷次无效");
    err.code = "pass_invalid";
    throw err;
  }
  ensureActivePass(book.id);
  const { books } = readBooks();
  const b = books.find((x) => x.id === book.id) || book;
  const allowed = Array.isArray(b.passes) && b.passes.length
    ? b.passes.map(Number)
    : [1];
  if (!allowed.includes(want)) {
    const err = new Error("该书没有这一刷，请先在书架开刷");
    err.code = "pass_not_on_book";
    throw err;
  }

  const all = readAll();
  const list = all.byBook[book.id] || [];
  const idx = list.findIndex((h) => h && String(h.id) === hid);
  if (idx < 0) {
    const err = new Error("找不到这条划线");
    err.code = "highlight_not_found";
    throw err;
  }
  list[idx] = { ...list[idx], pass_ordinal: want };
  all.byBook[book.id] = list;
  writeAll(all);
  return getHighlights(book.id);
}

if (require.main === module) {
  console.assert(passOfHighlight({}) === 1);
  console.assert(passOfHighlight({ pass_ordinal: 2 }) === 2);
  console.assert(passOfHighlight({ pass_ordinal: "3" }) === 3);
  // setHighlightPass：无书时应 book_not_found
  try {
    setHighlightPass("__no_book_xyz__", "h1", 1);
    throw new Error("expected book_not_found");
  } catch (e) {
    console.assert(e.code === "book_not_found", e.code);
  }
  const empty = searchNotes("");
  console.assert(empty.mode === "index" && Array.isArray(empty.books));
  const found = searchNotes("___no_such_token_xyz___");
  console.assert(found.mode === "search" && found.hits.length === 0);
  const idx = listNotesIndex();
  const withNotes = (idx.books || []).find((b) => b.total > 0);
  if (withNotes) {
    const md = exportNotesBook(withNotes.id, "md");
    console.assert(md.filename.endsWith(".md") && md.body.includes("笔记"));
    console.assert(md.body.includes(withNotes.title) || md.body.includes("《"));
    const doc = exportNotesBook(withNotes.id, "doc");
    console.assert(doc.filename.endsWith(".doc") && doc.body.includes("<html"), doc.filename);
    const all = exportNotesAll("md");
    console.assert(Buffer.isBuffer(all.body) && all.body[0] === 0x50 && all.filename.endsWith(".zip"));
  } else {
    try {
      exportNotesBook("__no_book__");
      throw new Error("expected book_not_found");
    } catch (e) {
      if (e.code !== "book_not_found") throw e;
    }
    try {
      exportNotesAll("md");
      throw new Error("expected no_notes");
    } catch (e) {
      if (e.code !== "no_notes") throw e;
    }
  }
  console.log("highlights ok");
}

module.exports = {
  getHighlights,
  listNotesIndex,
  searchNotes,
  exportNotesBook,
  exportNotesAll,
  syncHighlights,
  setHighlightPass,
  findBook,
  readAll,
  writeAll,
  passOfHighlight,
  resolvePassOrdinal,
  HIGHLIGHTS_PATH,
};
