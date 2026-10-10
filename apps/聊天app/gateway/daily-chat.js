/**
 * 日常短讯（D8 / D20）：单线程，与共看吐槽 / 共读 follow 分开。
 * 你侧先落库；家机短回复失败不回滚你侧（A-daily）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const CHAT_PATH = path.join(DATA_DIR, "chat.json");
const THREAD_ID = "daily";
const BODY_MAX = 800;
const HISTORY = 20;

const DAILY_SYSTEM_BASE =
  "你是同居室友「家机」，在小手机日常聊天里回短讯。" +
  "语气像室友短信：短、口语、轻松。" +
  "不要长篇剧情连载，不要章节目录，不要扮演系统通知。" +
  "若想建议加日程，只用一句话提一下让用户去日历确认，不要假装已经写进日历。";

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHAT_PATH)) {
    fs.writeFileSync(
      CHAT_PATH,
      JSON.stringify(
        { threadId: THREAD_ID, messages: [], tokens_used: 0, budget_tokens: 0 },
        null,
        2
      ),
      "utf8"
    );
  }
}

function normalizeMsg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const body = String(raw.body || "").trim();
  if (!id || !body) return null;
  const from = raw.from === "bot" ? "bot" : "you";
  return {
    id,
    threadId: THREAD_ID,
    from,
    body: body.slice(0, BODY_MAX),
    ts: Number(raw.ts) || Date.now(),
    read: true,
  };
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_PATH, "utf8"));
    const messages = Array.isArray(raw.messages)
      ? raw.messages.map(normalizeMsg).filter(Boolean)
      : [];
    messages.sort((a, b) => a.ts - b.ts);
    return {
      threadId: THREAD_ID,
      messages,
      tokens_used: Math.max(0, Math.floor(Number(raw.tokens_used) || 0)),
      budget_tokens: Math.max(0, Math.floor(Number(raw.budget_tokens) || 0)),
    };
  } catch {
    return { threadId: THREAD_ID, messages: [], tokens_used: 0, budget_tokens: 0 };
  }
}

function writeAll(data) {
  ensureFile();
  const messages = (data.messages || []).map(normalizeMsg).filter(Boolean);
  messages.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(
    CHAT_PATH,
    JSON.stringify(
      {
        threadId: THREAD_ID,
        messages,
        tokens_used: Math.max(0, Math.floor(Number(data.tokens_used) || 0)),
        budget_tokens: Math.max(0, Math.floor(Number(data.budget_tokens) || 0)),
      },
      null,
      2
    ),
    "utf8"
  );
  return {
    threadId: THREAD_ID,
    messages,
    tokens_used: Math.max(0, Math.floor(Number(data.tokens_used) || 0)),
    budget_tokens: Math.max(0, Math.floor(Number(data.budget_tokens) || 0)),
  };
}

/** 额度取共读 default_budget_rmb（0=不限）；已写过 budget_tokens 则沿用。 */
function ensureBudget() {
  const all = readAll();
  if (all.budget_tokens > 0 || all.tokens_used > 0) return all;
  try {
    const { readSettings, tokensFromBudgetRmb } = require("../../共读app/gateway/settings");
    const rmb = Number(readSettings().default_budget_rmb) || 0;
    const budget_tokens = tokensFromBudgetRmb(rmb);
    if (budget_tokens <= 0) return all;
    return writeAll({ ...all, budget_tokens });
  } catch {
    return all;
  }
}

function budgetExhausted(state) {
  const cap = Number(state && state.budget_tokens) || 0;
  if (cap <= 0) return false;
  return (Number(state.tokens_used) || 0) >= cap;
}

function addTokensUsed(n) {
  const all = readAll();
  const add = Math.max(0, Math.floor(Number(n) || 0));
  if (!add) return all;
  return writeAll({ ...all, tokens_used: (all.tokens_used || 0) + add });
}

function listMessages() {
  const all = readAll();
  return { ok: true, threadId: all.threadId, messages: all.messages };
}

function appendMessage(from, body) {
  const text = String(body || "").trim();
  if (!text) {
    const err = new Error("内容不能为空");
    err.code = "bad_chat_body";
    throw err;
  }
  const msg = normalizeMsg({
    id: randomUUID(),
    from: from === "bot" ? "bot" : "you",
    body: text,
    ts: Date.now(),
  });
  const all = readAll();
  all.messages.push(msg);
  writeAll(all);
  return msg;
}

function createMessage(patch) {
  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("内容不能为空");
    err.code = "bad_chat_body";
    throw err;
  }
  const msg = appendMessage("you", body);
  return { ok: true, message: msg };
}

/**
 * 你侧落库后立刻请家机流式接一句（A-daily）。LLM / 额度失败不回滚你侧。
 * emit(obj) 写 SSE 事件：you → bot_start → bot_delta* → bot_done|bot_error → done
 */
async function createMessageWithReplyStream(patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const youRes = createMessage(patch);
  const you = youRes.message;
  await write({ type: "you", ok: true, message: you });

  const state = ensureBudget();
  if (budgetExhausted(state)) {
    const bot_error = {
      code: "budget_exhausted",
      message: "额度已用尽 · 你侧已留下",
    };
    await write({ type: "bot_error", ...bot_error });
    const messages = listMessages().messages;
    await write({
      type: "done",
      ok: true,
      message: you,
      bot_message: null,
      bot_error,
      messages,
    });
    return {
      ok: true,
      message: you,
      bot_message: null,
      bot_error,
      messages,
    };
  }

  let bot_message = null;
  let bot_error = null;
  try {
    const { chatCompletionStream, parseThinkBody } = require("../../共读app/gateway/llm");
    const { readSettings, effectiveDialogue } = require("../../共读app/gateway/settings");
    const dlg = effectiveDialogue(readSettings());
    let system = DAILY_SYSTEM_BASE;
    const persona = String((dlg && dlg.persona) || "").trim();
    if (persona) system += "\n人设（请遵守语气与关系）：" + persona;
    const nameBot = String((dlg && dlg.name_bot) || "").trim();
    if (nameBot) system += "\n你的显示名：" + nameBot + "。";

    const hist = listMessages().messages;
    const prior = [];
    for (const m of hist.slice(-HISTORY)) {
      if (m.id === you.id) continue;
      prior.push({
        role: m.from === "bot" ? "assistant" : "user",
        content: m.body,
      });
    }
    prior.push({ role: "user", content: you.body });

    await write({ type: "bot_start" });
    let deltaChain = Promise.resolve();
    const raw = await chatCompletionStream({
      system,
      messages: prior,
      think: false,
      replyKind: "chat",
      onDelta: (piece) => {
        if (!piece) return;
        deltaChain = deltaChain.then(() => write({ type: "bot_delta", text: piece }));
      },
    });
    await deltaChain;
    const parsed = parseThinkBody(raw.content, false);
    const text = String(parsed.body || raw.content || "").trim();
    if (!text) {
      const err = new Error("家机没说出话来");
      err.code = "llm_empty";
      throw err;
    }
    bot_message = appendMessage("bot", text);
    // ponytail: 流式偶发无 usage；粗估一条短讯 ≈400 token，升级=强制 stream_options
    let used = (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0);
    if (used <= 0) used = 400;
    addTokensUsed(used);
    await write({ type: "bot_done", message: bot_message });
  } catch (e) {
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "家机暂时接不上",
    };
    await write({ type: "bot_error", ...bot_error });
  }

  const messages = listMessages().messages;
  await write({
    type: "done",
    ok: true,
    message: you,
    bot_message,
    bot_error,
    messages,
  });
  return {
    ok: true,
    message: you,
    bot_message,
    bot_error,
    messages,
  };
}

/** 自检/兼容；实现走 Stream。 */
async function createMessageWithReply(patch) {
  return createMessageWithReplyStream(patch, null);
}

if (require.main === module) {
  const stamp = "selfcheck-" + Date.now();
  const created = createMessage({ body: stamp });
  console.assert(created.message && created.message.body === stamp);
  console.assert(created.message.from === "you");
  const listed = listMessages();
  console.assert(listed.messages.some((m) => m.id === created.message.id));
  const bot = appendMessage("bot", "家机自检");
  console.assert(bot.from === "bot");
  console.assert(listMessages().messages.some((m) => m.id === bot.id));
  try {
    createMessage({ body: "   " });
    throw new Error("expected bad_chat_body");
  } catch (e) {
    if (e.code !== "bad_chat_body") throw e;
  }
  const all = readAll();
  writeAll({
    messages: all.messages.filter(
      (m) => m.id !== created.message.id && m.id !== bot.id
    ),
    tokens_used: all.tokens_used,
    budget_tokens: all.budget_tokens,
  });
  console.log("daily-chat ok");
}

module.exports = {
  listMessages,
  createMessage,
  createMessageWithReply,
  createMessageWithReplyStream,
  appendMessage,
  readAll,
  writeAll,
  CHAT_PATH,
};
