/**
 * 一书 × 一刷剧情摘要（落在 books.json 的 lore_by_pass）。
 * 生成：LLM 草稿不落盘；保存才写入。跟批注入当前刷摘要。
 */
const {
  readBooks,
  writeBooks,
  ensurePassOnBook,
} = require("./books");
const { getHighlights, findBook } = require("./highlights");
const { chatCompletion, parseThinkBody } = require("./llm");
const {
  readSettings,
  assertDoorOpen,
  effectiveDialogue,
  appendDialogueHints,
  formatSessionLoreBlock,
} = require("./settings");
const {
  getOpenSession,
  budgetExhausted,
  addOpenTokensUsed,
} = require("./sessions");

const PASS_LORE_STORE_MAX = 8000;
const PASS_LORE_INJECT_MAX = 2000;
const GENERATE_HL_CAP = 24;

function ensureLoreMap(book) {
  if (!book.lore_by_pass || typeof book.lore_by_pass !== "object") {
    book.lore_by_pass = {};
  }
  return book.lore_by_pass;
}

function resolvePassOrdinal(book, passKey) {
  ensurePassOnBook(book);
  const n = Number(passKey);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return Number(book.active_pass) || 1;
}

function clipStore(text) {
  let t = String(text || "").trim();
  if (t.length > PASS_LORE_STORE_MAX) {
    t = "…（更早摘要已省略）\n" + t.slice(-(PASS_LORE_STORE_MAX - 20));
  }
  return t;
}

function clipInject(text) {
  let t = String(text || "").trim();
  if (t.length > PASS_LORE_INJECT_MAX) {
    t = t.slice(0, PASS_LORE_INJECT_MAX) + "\n…（本刷摘要已截断）";
  }
  return t;
}

function findBookRow(bookId) {
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
  return { books, book: b };
}

function getPassLore(bookId, passKey) {
  const { book } = findBookRow(bookId);
  const pass = resolvePassOrdinal(book, passKey);
  const map = ensureLoreMap(book);
  const text = String(map[String(pass)] || "").trim();
  return {
    book_id: book.id,
    book_title: book.title || "未命名",
    pass_ordinal: pass,
    text,
    chars: text.length,
    store_max: PASS_LORE_STORE_MAX,
    inject_max: PASS_LORE_INJECT_MAX,
  };
}

function setPassLore(bookId, passKey, rawText) {
  const { books, book } = findBookRow(bookId);
  const pass = resolvePassOrdinal(book, passKey);
  const map = ensureLoreMap(book);
  const text = clipStore(rawText);
  if (text) map[String(pass)] = text;
  else delete map[String(pass)];
  book.lore_by_pass = map;
  writeBooks(books);
  return getPassLore(book.id, pass);
}

/** 跟批注入用（截断） */
function loreTextForInject(bookId, passKey) {
  return clipInject(getPassLore(bookId, passKey).text);
}

function appendSessionToPassLore(session) {
  if (!session || !session.book_id) {
    const err = new Error("无效场次");
    err.code = "bad_session";
    throw err;
  }
  const block = formatSessionLoreBlock(session);
  if (!block) return getPassLore(session.book_id, session.pass_ordinal);
  const cur = getPassLore(session.book_id, session.pass_ordinal);
  const next = cur.text ? cur.text + "\n\n" + block : block;
  return setPassLore(session.book_id, cur.pass_ordinal, next);
}

function formatHlForPassLore(h, i) {
  const bits = ["#" + (i + 1)];
  if (h.chapter_title) bits.push("章「" + String(h.chapter_title).trim() + "」");
  const quote = String(h.text || "").trim();
  const idea = String(h.idea || "").trim();
  if (quote) bits.push("划线：" + quote);
  if (idea) bits.push("想法：" + idea);
  let followBody = "";
  if (h.follow && h.follow.body) {
    const f = h.follow;
    if (Array.isArray(f.variants) && f.variants.length) {
      const idx = Math.max(
        0,
        Math.min(f.variants.length - 1, Number(f.active) || 0)
      );
      followBody = String(f.variants[idx].body || f.body || "").trim();
    } else {
      followBody = String(f.body || "").trim();
    }
  }
  if (followBody) bits.push("跟批：" + followBody);
  return bits.join("\n");
}

function pickPassHighlights(bookId, passOrdinal) {
  const list = getHighlights(bookId).highlights || [];
  const pass = Math.max(1, Number(passOrdinal) || 1);
  return list
    .filter((h) => (Number(h.pass_ordinal) || 1) === pass)
    .sort((a, b) => {
      const ta = Number(a.created_at) || 0;
      const tb = Number(b.created_at) || 0;
      const ma = ta > 0 && ta < 1e12 ? ta * 1000 : ta;
      const mb = tb > 0 && tb < 1e12 ? tb * 1000 : tb;
      return ma - mb;
    })
    .slice(-GENERATE_HL_CAP);
}

function buildPassLoreSystem(book, open) {
  const dlg = effectiveDialogue(open);
  let system =
    "你是共读小屋里的陪伴读者。用户要点一份「本刷剧情摘要」草稿，供以后跟批注入用。" +
    "写成连贯短文：本书这一刷读到哪、关键论点/情节、与陪伴相关的约定；不要逐条编号复述，不要说教。" +
    "若已有旧摘要，在其基础上更新或重写，保持可读。";
  if (book && book.title) system += `\n书名：《${book.title}》。`;
  system = appendDialogueHints(system, dlg);
  return system;
}

/**
 * 生成草稿：不落盘。须已开场且为该书；计本场额度。
 */
async function generatePassLoreDraft(
  bookId,
  { passOrdinal, think = false, model } = {}
) {
  assertDoorOpen();
  const open = getOpenSession();
  if (!open) {
    const err = new Error("请先进入共读（开场）");
    err.code = "no_open_session";
    throw err;
  }
  const book = findBook(bookId);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  if (open.book_id !== book.id) {
    const err = new Error("请先进入这本书的共读再生成摘要");
    err.code = "book_mismatch";
    throw err;
  }
  if (budgetExhausted(open)) {
    const err = new Error("本场额度已用尽");
    err.code = "budget_exhausted";
    throw err;
  }

  const pass = resolvePassOrdinal(book, passOrdinal || open.pass_ordinal);
  const existing = getPassLore(book.id, pass).text;
  const picked = pickPassHighlights(book.id, pass);
  if (!picked.length && !existing) {
    const err = new Error("本刷还没有划线/想法，也没有旧摘要可改写");
    err.code = "nothing_to_summarize";
    throw err;
  }

  const parts = [];
  if (existing) {
    parts.push("【已有本刷摘要】\n" + existing);
  }
  if (picked.length) {
    parts.push(
      "【本刷摘录 " +
        picked.length +
        " 条】\n\n" +
        picked.map(formatHlForPassLore).join("\n\n")
    );
  }
  parts.push("请写出更新后的本刷剧情摘要草稿（直接给正文，不要标题套话）。");

  const usedModel =
    String(model || readSettings().llm_model || "").trim() || undefined;
  const raw = await chatCompletion({
    system: buildPassLoreSystem(book, open),
    messages: [{ role: "user", content: parts.join("\n\n") }],
    think: !!think,
    replyKind: "summary",
    model: usedModel,
  });
  const parsed = parseThinkBody(raw.content, !!think);
  const draft = String(parsed.body || raw.content || "").trim();
  addOpenTokensUsed((raw.tokens_in || 0) + (raw.tokens_out || 0));
  const openAfter = getOpenSession();
  return {
    book_id: book.id,
    book_title: book.title || "未命名",
    pass_ordinal: pass,
    draft,
    chars: draft.length,
    source_highlights: picked.length,
    had_existing: !!existing,
    tokens_in: raw.tokens_in || 0,
    tokens_out: raw.tokens_out || 0,
    tokens_used: openAfter ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter ? openAfter.budget_tokens || 0 : 0,
  };
}

if (require.main === module) {
  const prev = readBooks().books;
  const id = "lore-selfcheck-" + Date.now().toString(36);
  const { books } = readBooks();
  books.push({
    id,
    title: "摘要自检",
    author: "t",
    source: "local",
    passes: [1, 2],
    active_pass: 1,
    progress: 0,
    in_progress: false,
    updated_at: "—",
  });
  writeBooks(books);
  const a = setPassLore(id, 1, "一刷要点甲");
  console.assert(a.text === "一刷要点甲" && a.pass_ordinal === 1, a);
  const b = setPassLore(id, 2, "二刷要点乙");
  console.assert(getPassLore(id, 1).text === "一刷要点甲", getPassLore(id, 1));
  console.assert(b.text === "二刷要点乙", b);
  console.assert(loreTextForInject(id, 1) === "一刷要点甲");
  const long = "字".repeat(PASS_LORE_STORE_MAX + 50);
  const c = setPassLore(id, 1, long);
  console.assert(c.chars <= PASS_LORE_STORE_MAX && c.text.includes("省略"), c.chars);
  const inj = loreTextForInject(id, 1);
  console.assert(inj.length <= PASS_LORE_INJECT_MAX + 20, inj.length);
  writeBooks(prev);
  console.log("pass-lore ok");
}

module.exports = {
  getPassLore,
  setPassLore,
  loreTextForInject,
  appendSessionToPassLore,
  generatePassLoreDraft,
  PASS_LORE_STORE_MAX,
  PASS_LORE_INJECT_MAX,
};
