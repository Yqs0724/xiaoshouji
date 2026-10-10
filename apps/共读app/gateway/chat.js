const { chatCompletion, chatCompletionStream, parseThinkBody, resolveThinkText, withReplySuffix } = require("./llm");
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
const { PERSONA_CARD_FOLLOW_MAX, buildOpenFollowSystem } = require("./follow");

const CHAT_HISTORY = 8;

/** 精确字数标签：↑500 / ↑1.5K / ↑12K（底栏不带「字」） */
function formatCtxLabel(chars) {
  const n = Math.max(0, Math.round(Number(chars) || 0));
  if (n < 1000) return "↑" + n;
  const k = n / 1000;
  if (k < 10) {
    const one = Math.round(k * 10) / 10;
    return "↑" + (one % 1 === 0 ? String(one) : one.toFixed(1)) + "K";
  }
  return "↑" + Math.round(k) + "K";
}

/**
 * 本场对话上下文体量（字数精确）：短聊将发送的 system（含深思尾缀）+ 近 CHAT_HISTORY 条；
 * 附带跟批基线 system（不含当条划线原文）。
 */
function estimateDialogueContext({ think = false } = {}) {
  const open = getOpenSession();
  if (!open) {
    const err = new Error("请先进入共读（开场）");
    err.code = "no_open_session";
    throw err;
  }
  const book = findBook(open.book_id);
  const thinkOn = !!think;
  const chatSystem = withReplySuffix(buildShortChatSystem(book, open), {
    think: thinkOn,
    replyKind: "chat",
  });
  const history = listOpenChats().slice(-CHAT_HISTORY);
  let historyChars = 0;
  for (const m of history) {
    historyChars += String((m && m.body) || "").length;
  }
  const chatSystemChars = chatSystem.length;
  const chatChars = chatSystemChars + historyChars;

  const followSystem = withReplySuffix(buildOpenFollowSystem(book, open, null), {
    think: thinkOn,
    replyKind: "follow",
  });
  const followChars = followSystem.length;

  return {
    book_id: open.book_id,
    book_title: open.book_title || (book && book.title) || null,
    lore_light: !!open.lore_light,
    think: thinkOn,
    unit: "chars",
    label: formatCtxLabel(chatChars),
    chars: chatChars,
    chat: {
      system_chars: chatSystemChars,
      history_chars: historyChars,
      history_msgs: history.length,
      history_cap: CHAT_HISTORY,
      chars: chatChars,
      label: formatCtxLabel(chatChars),
    },
    follow: {
      system_chars: followChars,
      chars: followChars,
      label: formatCtxLabel(followChars),
      note: "不含当条划线/想法原文",
    },
  };
}

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
 * emit 可选：流式事件（you / bot_start / bot_delta / bot_done / bot_error / done）。
 * 你侧先落盘；家机失败不回滚你侧。
 */
async function sendShortChatStream(text, { think = false, model, replyToHighlightId } = {}, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
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

  appendOpenChats([userMsg]);
  await write({ type: "you", ok: true, message: userMsg, chats: listOpenChats() });

  let asst = null;
  let bot_error = null;
  try {
    await write({ type: "bot_start" });
    let deltaChain = Promise.resolve();
    const raw = await chatCompletionStream({
      system,
      messages: prior,
      think: !!think,
      replyKind: "chat",
      model: usedModel,
      onDelta: (piece) => {
        if (!piece) return;
        deltaChain = deltaChain.then(() => write({ type: "bot_delta", text: piece }));
      },
    });
    await deltaChain;
    const parsed = parseThinkBody(raw.content, !!think);
    const textOut = String(parsed.body || raw.content || "").trim();
    if (!textOut) {
      const err = new Error("家机没说出话来");
      err.code = "llm_empty";
      throw err;
    }
    asst = {
      id: "c_" + Date.now().toString(36) + "_a",
      role: "assistant",
      kind: "chat",
      body: textOut,
      think: resolveThinkText(parsed, raw, !!think),
      tokens_in: raw.tokens_in,
      tokens_out: raw.tokens_out,
      model: usedModel,
      at: Date.now(),
    };
    if (replyCtx) {
      asst.reply_to = replyCtx.highlight_id;
      asst.reply_label = replyCtx.label;
    }
    appendOpenChats([asst]);
    addOpenTokensUsed((raw.tokens_in || 0) + (raw.tokens_out || 0));
    await write({ type: "bot_done", message: asst });
  } catch (e) {
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "短聊失败",
    };
    await write({ type: "bot_error", ...bot_error });
  }

  const openAfter = getOpenSession();
  const result = {
    ok: true,
    messages: asst ? [userMsg, asst] : [userMsg],
    chats: listOpenChats(),
    bot_error,
    tokens_used: openAfter ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter ? openAfter.budget_tokens || 0 : 0,
    budget_exhausted: !!(openAfter && budgetExhausted(openAfter)),
  };
  await write({ type: "done", ...result });
  return result;
}

/** 整段等待兼容；内部走流式。 */
async function sendShortChat(text, opts = {}) {
  return sendShortChatStream(text, opts, null);
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
    think: resolveThinkText(parsed, raw, !!think),
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
  console.assert(formatCtxLabel(500) === "↑500");
  console.assert(formatCtxLabel(12000) === "↑12K");
  console.assert(formatCtxLabel(1500) === "↑1.5K");
  {
    const { withReplySuffix, resolveThinkText, parseThinkBody } = require("./llm");
    const a = withReplySuffix("基", { think: false, replyKind: "chat" });
    const b = withReplySuffix("基", { think: true, replyKind: "chat" });
    console.assert(a.includes("直接输出回复") && b.includes("【思考】") && b.length > a.length);
    const tagged = parseThinkBody("【思考】想一想\n【回复】正文", true);
    console.assert(resolveThinkText(tagged, { reasoning: "接口链" }, true) === "想一想");
    console.assert(
      resolveThinkText(parseThinkBody("只有正文", true), { reasoning: "接口链" }, true) ===
        "接口链"
    );
    console.assert(resolveThinkText(tagged, { reasoning: "x" }, false) === null);
  }
  try {
    estimateDialogueContext({ think: true });
    const ctx = estimateDialogueContext({ think: false });
    console.assert(ctx && ctx.chat && ctx.unit === "chars" && typeof ctx.label === "string");
  } catch (e) {
    console.assert(e.code === "no_open_session", e);
  }
  console.log("chat ok");
}

module.exports = {
  sendShortChat,
  sendShortChatStream,
  summarizeRecent,
  listOpenChats,
  buildShortChatSystem,
  buildSummarySystem,
  pickHighlightsForSummary,
  formatHighlightForSummary,
  resolveReplyContext,
  estimateDialogueContext,
  formatCtxLabel,
  CHAT_HISTORY,
  SUMMARY_DEFAULT_LIMIT,
};
