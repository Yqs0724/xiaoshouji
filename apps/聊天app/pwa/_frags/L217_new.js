  let bot_message = null;
  let bot_error = null;
  try {
    const hist = listMessages().messages;
    const prior = buildChatPrior(hist, you);
    await write({ type: "bot_start" });
    const { text, thinkExtra, used } = await streamBotReply(write, prior);
    bot_message = appendMessage("bot", text, "text", thinkExtra);
    // ponytail: 流式偶发空 usage；粗估一条短讯 ≈400 token，升级=强制 stream_options
    addTokensUsed(used > 0 ? used : 400);
    await write({ type: "bot_done", message: bot_message });
    const bot_money = maybeBotMoney(you, text);
    if (bot_money) {
      /* 待你点击领取，不自动回执 */
      await write({ type: "bot_money", message: bot_money });
    }
    const bot_sticker = maybeBotSticker(you, text);
    if (bot_sticker) await write({ type: "bot_sticker", message: bot_sticker });
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

/** 构建 LLM prior；excludeId 跳过该条（重生时跳过旧家机气泡） */
function buildChatPrior(hist, youOrNull, excludeId) {
  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const toolsOn = settings.chat_tools_enabled !== false;
  const skip = excludeId ? String(excludeId) : "";
  const youId = youOrNull && youOrNull.id ? String(youOrNull.id) : "";
  const prior = [];
  const slice = Array.isArray(hist) ? hist.slice(-HISTORY) : [];
  for (const m of slice) {
    if (!m) continue;
    if (skip && m.id === skip) continue;
    if (youId && m.id === youId) continue;
    if (m.kind === "tool") continue;
    if (m.from === "bot") {
      const am = { role: "assistant", content: llmContent(m) };
      if (toolsOn) am.reasoning_content = m.think || "";
      prior.push(am);
    } else {
      prior.push({ role: "user", content: llmContent(m) });
    }
  }
  if (youOrNull) prior.push({ role: "user", content: llmContent(youOrNull) });
  return prior;
}

/**
 * 流式跑一轮家机文字（含工具）。emit bot_delta / bot_think / bot_tool*。
 * 不写库；调用方负责 append / appendVariant。
 */
async function streamBotReply(write, priorIn) {
  const { chatCompletionStream, parseThinkBody, resolveThinkText } = require(
    "../../共读app/gateway/llm"
  );
  const { readSettings, effectiveDialogue } = require("../../共读app/gateway/settings");
  const {
    MAX_TOOL_ROUNDS,
    runChatTool,
    resolveToolLabel,
    summarizeToolResult,
    getToolBundle,
  } = require("./chat-tools");
  const settings = readSettings();
  const dlg = effectiveDialogue(settings);
  const toolsOn = settings.chat_tools_enabled !== false;
  const toolLabels = settings.chat_tool_labels || {};
  let toolBundle = null;
  if (toolsOn) toolBundle = await getToolBundle(settings);
  const tools = toolBundle && toolBundle.defs.length ? toolBundle.defs : undefined;
  let system = DAILY_SYSTEM_BASE;
  system +=
    "对方可能发贴纸、图片、红包、转账或位置；用一两句口语接住即可。" +
    "不要每条都提表情包，也不要说「我发了贴纸/红包」（贴纸与红包由系统按气氛另发）。";
  if (!toolsOn) {
    system += "\n（工具已关闭：不要声称已查/已改日历，可请对方去日历 App 看。）";
  } else if (toolBundle && toolBundle.mcpMap.size) {
    system += "\n（另有外接 MCP 工具可用，名称见工具表。）";
  } else if (toolBundle && toolBundle.mcpError) {
    system += "\n（外接 MCP 暂不可用：" + String(toolBundle.mcpError).slice(0, 80) + "）";
  }
  const persona = String((dlg && dlg.persona) || "").trim();
  if (persona) system += "\n人设（请遵守语气与关系）：" + persona;
  const nameBot = String((dlg && dlg.name_bot) || "").trim();
  if (nameBot) system += "\n你的显示名：" + nameBot + "。";

  const prior = Array.isArray(priorIn) ? priorIn.slice() : [];
  let deltaChain = Promise.resolve();
  let used = 0;
  let text = "";
  let streamed = "";
  let thinkParts = [];
  let thinkSecTotal = 0;
  const toolMetas = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const t0 = Date.now();
    const roundStream = { buf: "" };
    const raw = await chatCompletionStream({
      system,
      messages: prior,
      think: true,
      replyKind: "chat",
      tools,
      onDelta: (piece) => {
        if (!piece) return;
        roundStream.buf += piece;
        streamed += piece;
        deltaChain = deltaChain.then(() => write({ type: "bot_delta", text: piece }));
      },
    });
    used += (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0);
    await deltaChain;
    deltaChain = Promise.resolve();

    const thinkText = resolveThinkText(parseThinkBody(raw.content, false), raw, true);
    if (thinkText) thinkParts.push(thinkText);
    const sec = Math.max(0.1, (Date.now() - t0) / 1000);
    thinkSecTotal += sec;
    await write({
      type: "bot_think",
      seconds: Math.round(sec * 10) / 10,
      text: thinkText || "",
    });

    const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    if (!calls.length) {
      const parsed = parseThinkBody(raw.content, false);
      text = String(parsed.body || raw.content || roundStream.buf || "").trim();
      break;
    }

    const amsg = {
      role: "assistant",
      content: raw.content || "",
      reasoning_content: raw.reasoning || "",
      tool_calls: calls,
    };
    prior.push(amsg);
    for (const tc of calls) {
      const name = (tc.function && tc.function.name) || "";
      const label = resolveToolLabel(name, toolLabels);
      await write({ type: "bot_tool", name, label });
      const ran = await runChatTool(name, tc.function && tc.function.arguments, {
        mcpMap: toolBundle && toolBundle.mcpMap,
        settings,
      });
      const summary = summarizeToolResult(ran.name, ran.result, !!ran.ok);
      const meta = { name: ran.name, label, summary, ok: !!ran.ok };
      toolMetas.push(meta);
      await write({
        type: "bot_tool_done",
        name: ran.name,
        label,
        ok: !!ran.ok,
        summary,
      });
      prior.push({
        role: "tool",
        tool_call_id: tc.id,
        content: ran.result,
      });
    }
  }

  if (!text) text = String(streamed || "").trim();
  if (!text && thinkParts.length) text = "嗯。";
  if (!text) {
    const err = new Error("家机没说出话来");
    err.code = "llm_empty";
    throw err;
  }
  const thinkJoined = thinkParts.filter(Boolean).join("\n---\n").slice(0, 12000);
  const thinkExtra = {};
  if (thinkJoined) thinkExtra.think = thinkJoined;
  else if (thinkSecTotal > 0) {
    thinkExtra.think = "（本轮已深度思考，模型未返回思考正文）";
  }
  if (thinkSecTotal > 0) {
    thinkExtra.think_sec = Math.round(thinkSecTotal * 10) / 10;
  }
  if (toolMetas.length) thinkExtra.tools = toolMetas;
  return { text, thinkExtra, used };
}

/**
 * 同气泡重生：SSE bot_start → … → bot_done（同一 id）→ done；失败不删旧版。
 */
async function regenerateMessageStream(id, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const { messages, idx, msg } = assertRegenTarget(id);

  const state = ensureBudget();
  if (budgetExhausted(state)) {
    const bot_error = {
      code: "budget_exhausted",
      message: "额度已用尽 · 旧版仍在",
    };
    await write({ type: "bot_error", ...bot_error });
    await write({
      type: "done",
      ok: true,
      message: msg,
      bot_message: msg,
      bot_error,
      messages: listMessages().messages,
    });
    return { ok: true, message: msg, bot_error };
  }

  /* prior：该气泡之前的历史；若紧前是 you，当作本轮用户句 */
  let you = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].from === "you") {
      you = messages[i];
      break;
    }
    if (messages[i].from === "bot" && messages[i].kind === "text") break;
  }
  const histBefore = messages.slice(0, idx);
  const prior = buildChatPrior(histBefore, you, msg.id);

  let bot_message = msg;
  let bot_error = null;
  try {
    await write({ type: "bot_start", regen: true, id: msg.id });
    const { text, thinkExtra, used } = await streamBotReply(write, prior);
    bot_message = appendVariantToMessage(msg.id, {
      body: text,
      ts: Date.now(),
      think: thinkExtra.think,
      think_sec: thinkExtra.think_sec,
      tools: thinkExtra.tools,
    });
    addTokensUsed(used > 0 ? used : 400);
    await write({ type: "bot_done", message: bot_message, regen: true });
  } catch (e) {
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "家机暂时接不上",
    };
    await write({ type: "bot_error", ...bot_error });
  }

  const all = listMessages().messages;
  await write({
    type: "done",
    ok: true,
    message: bot_message,
    bot_message,
    bot_error,
    messages: all,
  });
  return { ok: true, message: bot_message, bot_error, messages: all };
}

async function createMessageWithReply(patch) {
  return createMessageWithReplyStream(patch, null);
}