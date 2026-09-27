const { chatCompletion, parseThinkBody } = require("./llm");
const { findBook, getHighlights } = require("./highlights");
const {
  readSettings,
  assertDoorOpen,
  effectiveDialogue,
  appendDialogueHints,
} = require("./settings");
const {
  getOpenSession,
  budgetExhausted,
  addOpenTokensUsed,
  appendOpenChats,
  listOpenChats,
} = require("./sessions");
const { PERSONA_CARD_FOLLOW_MAX } = require("./follow");

const CHAT_HISTORY = 8;

function buildShortChatSystem(book, open) {
  const sess = open || getOpenSession();
  const dlg = effectiveDialogue(sess);
  let system =
    "你是共读小屋里的陪伴读者，正在和用户短聊。语气自然、有温度，不要说教，回复控制在几句以内。";
  if (book && book.title) {
    system += `\n当前共读：《${book.title}》。`;
  }
  system = appendDialogueHints(system, dlg);
  if (dlg.persona_card_in_follow) {
    let card = String(dlg.persona_card || "").trim();
    if (card) {
      if (card.length > PERSONA_CARD_FOLLOW_MAX) {
        card =
          card.slice(0, PERSONA_CARD_FOLLOW_MAX) +
          "\n…（完整角色卡已截断，全文仅保存在设定里）";
      }
      system += "\n完整角色卡（补充设定，勿整段复述）：\n" + card;
    }
  }
  if (sess && sess.lore_light) {
    system +=
      "\n本场设定：少提设定。少提背景与剧情梗，多贴原文与当下感受。";
  }
  return system;
}

function resolveReplyContext(bookId, highlightId) {
  const hid = String(highlightId || "").trim();
  if (!hid) return null;
  const { highlights } = getHighlights(bookId);
  const h = (highlights || []).find((x) => x.id === hid);
  if (!h) {
    const err = new Error("找不到这条划线");
    err.code = "highlight_not_found";
    throw err;
  }
  const quote = String(h.text || "").trim();
  const idea = String(h.idea || "").trim();
  let followBody = "";
  if (h.follow && h.follow.body) {
    const f = h.follow;
    if (Array.isArray(f.variants) && f.variants.length) {
      const i = Math.max(0, Math.min(f.variants.length - 1, Number(f.active) || 0));
      followBody = String(f.variants[i].body || f.body || "").trim();
    } else {
      followBody = String(f.body || "").trim();
    }
  }
  const label = quote
    ? quote.length > 36
      ? quote.slice(0, 36) + "…"
      : quote
    : idea
      ? "想法"
      : "划线";
  const parts = [];
  if (quote) parts.push("划线原文：" + quote);
  if (idea) parts.push("读者想法：" + idea);
  if (followBody) parts.push("先前跟批：" + followBody);
  if (h.chapter_title) parts.push("章节：" + h.chapter_title);
  return {
    highlight_id: h.id,
    label,
    prompt_block: parts.join("\n"),
  };
}

/**
 * 本场短聊：须已开场；守额度；暂停跟批仍可短聊。
 * replyToHighlightId：就此展开 / 续聊，把该划线与跟批注入本轮。
 */
async function sendShortChat(text, { think = false, model, replyToHighlightId } = {}) {
  assertDoorOpen();
  const body = String(text || "").trim();
  if (!body) {
    const err = new Error("请输入内容");
    err.code = "empty_message";
    throw err;
  }
  const open = getOpenSession();
  if (!open) {
    const err = new Error("请先进入共读（开场）");
    err.code = "no_open_session";
    throw err;
  }
  if (budgetExhausted(open)) {
    const err = new Error("本场额度已用尽");
    err.code = "budget_exhausted";
    throw err;
  }

  const book = findBook(open.book_id);
  const replyCtx = replyToHighlightId
    ? resolveReplyContext(open.book_id, replyToHighlightId)
    : null;

  const userMsg = {
    id: "c_" + Date.now().toString(36) + "_u",
    role: "user",
    kind: "chat",
    body,
    at: Date.now(),
  };
  if (replyCtx) {
    userMsg.reply_to = replyCtx.highlight_id;
    userMsg.reply_label = replyCtx.label;
  }

  const history = listOpenChats().slice(-CHAT_HISTORY);
  const prior = [];
  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") {
      prior.push({ role: m.role, content: m.body || "" });
    }
  }
  const userContent = replyCtx
    ? "用户想就下面这条内容继续聊。\n" +
      replyCtx.prompt_block +
      "\n\n用户现在说：" +
      body
    : body;
  prior.push({ role: "user", content: userContent });

  const system = buildShortChatSystem(book, open);
  const usedModel =
    String(model || readSettings().llm_model || "").trim() || undefined;

  const raw = await chatCompletion({
    system,
    messages: prior,
    think: !!think,
    replyKind: "chat",
    model: usedModel,
  });
  const parsed = parseThinkBody(raw.content, !!think);
  const asst = {
    id: "c_" + Date.now().toString(36) + "_a",
    role: "assistant",
    kind: "chat",
    body: parsed.body || raw.content,
    think: parsed.think || null,
    tokens_in: raw.tokens_in,
    tokens_out: raw.tokens_out,
    model: usedModel,
    at: Date.now(),
  };
  if (replyCtx) {
    asst.reply_to = replyCtx.highlight_id;
    asst.reply_label = replyCtx.label;
  }

  appendOpenChats([userMsg, asst]);
  addOpenTokensUsed((raw.tokens_in || 0) + (raw.tokens_out || 0));

  const openAfter = getOpenSession();
  return {
    messages: [userMsg, asst],
    chats: listOpenChats(),
    tokens_used: openAfter ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter ? openAfter.budget_tokens || 0 : 0,
    budget_exhausted: !!(openAfter && budgetExhausted(openAfter)),
  };
}

function toMs(t) {
  const n = Number(t) || 0;
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

const SUMMARY_DEFAULT_LIMIT = 8;

function formatHighlightForSummary(h, i) {
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
      const idx = Math.max(0, Math.min(f.variants.length - 1, Number(f.active) || 0));
      followBody = String(f.variants[idx].body || f.body || "").trim();
    } else {
      followBody = String(f.body || "").trim();
    }
  }
  if (followBody) bits.push("跟批：" + followBody);
  return bits.join("\n");
}

/** 本场优先；不够则本刷；再不够则全书最近。 */
function pickHighlightsForSummary(highlights, open, limit = SUMMARY_DEFAULT_LIMIT) {
  const n = Math.max(1, Math.min(30, Number(limit) || SUMMARY_DEFAULT_LIMIT));
  const list = Array.isArray(highlights) ? highlights.slice() : [];
  const start = Number(open && open.started_at) || 0;
  const pass = Math.max(1, Number(open && open.pass_ordinal) || 1);

  function take(pred) {
    return list
      .filter(pred)
      .sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
      .slice(-n);
  }

  let picked = start ? take((h) => toMs(h.created_at) >= start) : [];
  if (!picked.length) {
    picked = take((h) => (Number(h.pass_ordinal) || 1) === pass);
  }
  if (!picked.length) {
    picked = take(() => true);
  }
  return picked;
}

function buildSummarySystem(book, open) {
  const sess = open || getOpenSession();
  const dlg = effectiveDialogue(sess);
  let system =
    "你是共读小屋里的陪伴读者。用户要你「总结刚才」：把最近几条划线/想法/跟批收成一小段自然小结。" +
    "抓住要点与情绪，不要逐条编号复述，不要说教，几句到一小段即可。";
  if (book && book.title) {
    system += `\n当前共读：《${book.title}》。`;
  }
  system = appendDialogueHints(system, dlg);
  if (sess && sess.lore_light) {
    system +=
      "\n本场设定：少提设定。小结少提背景与长线剧情，多贴原文要点与当下感受。";
  }
  return system;
}

/**
 * 总结刚才：须已开场；守额度与门锁。
 */
async function summarizeRecent({ limit = SUMMARY_DEFAULT_LIMIT, think = false, model } = {}) {
  assertDoorOpen();
  const open = getOpenSession();
  if (!open) {
    const err = new Error("请先进入共读（开场）");
    err.code = "no_open_session";
    throw err;
  }
  if (budgetExhausted(open)) {
    const err = new Error("本场额度已用尽");
    err.code = "budget_exhausted";
    throw err;
  }

  const book = findBook(open.book_id);
  const { highlights } = getHighlights(open.book_id);
  const picked = pickHighlightsForSummary(highlights, open, limit);
  if (!picked.length) {
    const err = new Error("还没有可总结的划线");
    err.code = "nothing_to_summarize";
    throw err;
  }

  const excerpt = picked.map(formatHighlightForSummary).join("\n\n");
  const userContent =
    "请总结刚才这 " +
    picked.length +
    " 条共读摘录：\n\n" +
    excerpt;

  const usedModel =
    String(model || readSettings().llm_model || "").trim() || undefined;
  const raw = await chatCompletion({
    system: buildSummarySystem(book, open),
    messages: [{ role: "user", content: userContent }],
    think: !!think,
    replyKind: "summary",
    model: usedModel,
  });
  const parsed = parseThinkBody(raw.content, !!think);
  const stamp = Date.now();
  const userMsg = {
    id: "c_" + stamp.toString(36) + "_su",
    role: "user",
    kind: "summary_request",
    body: "总结刚才（最近 " + picked.length + " 条）",
    at: stamp,
  };
  const asst = {
    id: "c_" + stamp.toString(36) + "_sa",
    role: "assistant",
    kind: "summary",
    body: parsed.body || raw.content,
    think: parsed.think || null,
    tokens_in: raw.tokens_in,
    tokens_out: raw.tokens_out,
    model: usedModel,
    at: stamp + 1,
    summary_count: picked.length,
  };

  appendOpenChats([userMsg, asst]);
  addOpenTokensUsed((raw.tokens_in || 0) + (raw.tokens_out || 0));

  const openAfter = getOpenSession();
  return {
    messages: [userMsg, asst],
    chats: listOpenChats(),
    picked: picked.length,
    tokens_used: openAfter ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter ? openAfter.budget_tokens || 0 : 0,
    budget_exhausted: !!(openAfter && budgetExhausted(openAfter)),
  };
}

if (require.main === module) {
  const sys = buildShortChatSystem({ title: "测试书" });
  console.assert(sys.includes("短聊") && sys.includes("测试书"));
  console.assert(buildShortChatSystem(null).includes("陪伴读者"));
  const fake = resolveReplyContext;
  console.assert(typeof fake === "function");
  const open = { started_at: 100000, pass_ordinal: 1 };
  const hls = [
    { id: "1", created_at: 50, text: "old", pass_ordinal: 1 },
    { id: "2", created_at: 200000, text: "new1", pass_ordinal: 1 },
    { id: "3", created_at: 300000, text: "new2", idea: "想", pass_ordinal: 1 },
  ];
  const picked = pickHighlightsForSummary(hls, open, 8);
  console.assert(picked.length === 2 && picked[0].id === "2", picked);
  console.assert(formatHighlightForSummary(picked[1], 1).includes("想法"), formatHighlightForSummary(picked[1], 1));
  console.assert(buildSummarySystem({ title: "A" }).includes("总结刚才"));
  console.log("chat ok");
}

module.exports = {
  sendShortChat,
  summarizeRecent,
  listOpenChats,
  buildShortChatSystem,
  buildSummarySystem,
  pickHighlightsForSummary,
  formatHighlightForSummary,
  resolveReplyContext,
  SUMMARY_DEFAULT_LIMIT,
};
