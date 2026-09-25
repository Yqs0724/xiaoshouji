const { chatCompletion, parseThinkBody } = require("./llm");
const { getHighlights, findBook, readAll, writeAll } = require("./highlights");
const { readSettings } = require("./settings");

function saveHighlightPatch(bookId, highlightId, patch) {
  const all = readAll();
  const list = all.byBook[bookId] || [];
  const idx = list.findIndex((h) => h.id === highlightId);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  all.byBook[bookId] = list;
  writeAll(all);
  return list[idx];
}

async function followOne(book, highlight, { think, model }) {
  const userParts = [`书名：《${book.title || "未命名"}》`];
  if (highlight.text) userParts.push(`划线原文：${highlight.text}`);
  if (highlight.idea) userParts.push(`读者想法：${highlight.idea}`);
  if (highlight.chapter_title) userParts.push(`章节：${highlight.chapter_title}`);

  const system =
    "你是共读小屋里的陪伴读者，语气自然、有温度，贴合原文，不要说教，不要复述整段划线。跟批控制在 2～5 句。";

  const usedModel =
    String(model || readSettings().llm_model || "").trim() || undefined;
  const raw = await chatCompletion({
    system,
    user: userParts.join("\n"),
    think: !!think,
    model: usedModel,
  });
  const parsed = parseThinkBody(raw.content, !!think);
  return {
    think: parsed.think || null,
    body: parsed.body || raw.content,
    tokens_in: raw.tokens_in,
    tokens_out: raw.tokens_out,
    model: usedModel,
    at: Date.now(),
  };
}

/**
 * 对一书尚未跟批的划线生成跟批（默认最新 3 条，串行）。
 */
async function followPending(bookKey, { limit = 3, think = true, retry = false, model } = {}) {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }

  if (retry) {
    const all = readAll();
    const list = all.byBook[book.id] || [];
    let cleared = false;
    for (const h of list) {
      if (h.follow_error && !h.follow) {
        delete h.follow_error;
        cleared = true;
      }
    }
    if (cleared) {
      all.byBook[book.id] = list;
      writeAll(all);
    }
  }

  const { highlights } = getHighlights(book.id);
  const pending = highlights
    .filter((h) => h.kind !== "idea" && (h.text || h.idea) && !h.follow && !h.follow_error)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, Math.max(1, Math.min(limit, 5)));

  const done = [];
  for (const h of pending) {
    try {
      const follow = await followOne(book, h, { think, model });
      const updated = saveHighlightPatch(book.id, h.id, {
        follow,
        follow_error: null,
      });
      done.push(updated);
    } catch (e) {
      const updated = saveHighlightPatch(book.id, h.id, {
        follow_error: e.message || "跟批失败",
      });
      done.push(updated);
    }
  }

  return {
    book_id: book.id,
    followed: done.filter((h) => h && h.follow).length,
    failed: done.filter((h) => h && h.follow_error).length,
    highlights: getHighlights(book.id).highlights,
  };
}

module.exports = { followPending, followOne };
