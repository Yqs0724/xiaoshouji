const { readSettings } = require("./settings");

function chatCompletionsUrl(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "";
  if (b.endsWith("/chat/completions")) return b;
  return b + "/chat/completions";
}

function buildChatMessages({ system, user, messages, think, replyKind }) {
  const sys = withReplySuffix(system, { think, replyKind });
  if (Array.isArray(messages) && messages.length) {
    return [{ role: "system", content: sys }, ...messages.filter((m) => m.role !== "system")];
  }
  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

function resolveLlmCreds(modelOverride) {
  const s = readSettings();
  const base = s.llm_base.trim();
  const key = s.llm_key.trim();
  const model = String(modelOverride || s.llm_model || "").trim();
  if (!base || !key || !model) {
    const err = new Error("请先在设定里填写 LLM Base / Key / Model");
    err.code = "llm_not_configured";
    throw err;
  }
  return { url: chatCompletionsUrl(base), key, model };
}

function mergeToolCallDelta(bucket, pieces) {
  if (!Array.isArray(pieces)) return;
  for (const p of pieces) {
    if (!p || typeof p !== "object") continue;
    const idx = Number.isFinite(Number(p.index)) ? Number(p.index) : bucket.length;
    if (!bucket[idx]) {
      bucket[idx] = {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
    }
    const cur = bucket[idx];
    if (p.id) cur.id = String(p.id);
    if (p.type) cur.type = String(p.type);
    const fn = p.function || {};
    if (fn.name) cur.function.name += String(fn.name);
    if (fn.arguments != null) cur.function.arguments += String(fn.arguments);
  }
}

/**
 * OpenAI 兼容流式 chat.completions。
 * onDelta(textChunk) 每有正文增量调用一次。
 * tools 有值时附带 tool_calls（供网关工具循环）。
 * @returns {{ content, reasoning, tool_calls, tokens_in, tokens_out }}
 */
async function chatCompletionStream({
  system,
  user,
  messages,
  think,
  model: modelOverride,
  replyKind = "follow",
  tools,
  tool_choice,
  onDelta,
}) {
  const { url, key, model } = resolveLlmCreds(modelOverride);
  const isDeepseek = /deepseek/i.test(url) || /deepseek/i.test(model);
  /* DS 用原生 reasoning_content；带 tools 时也不要【思考】伪标签 */
  const useThink =
    !!(think && !(Array.isArray(tools) && tools.length) && !isDeepseek);
  const msgList = buildChatMessages({
    system,
    user,
    messages,
    think: useThink,
    replyKind,
  });

  const body = {
    model,
    stream: true,
    messages: msgList,
  };
  if (isDeepseek) {
    /* DS 默认开思考；带 tools 时也要开，且后续轮次回传 reasoning_content */
    body.thinking = { type: think === false ? "disabled" : "enabled" };
  } else {
    body.temperature = 0.7;
  }
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (tool_choice != null) body.tool_choice = tool_choice;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const msg =
      (data && data.error && (data.error.message || data.error)) ||
      (data && data.message) ||
      text.slice(0, 200) ||
      `LLM HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : "LLM 请求失败");
    err.code = "llm_http";
    err.status = res.status;
    throw err;
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    const err = new Error("LLM 流不可读");
    err.code = "llm_bad_response";
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  let reasoning = "";
  let tokens_in = 0;
  let tokens_out = 0;
  const toolBucket = [];

  const handleData = (payload) => {
    const s = String(payload || "").trim();
    if (!s || s === "[DONE]") return;
    let data;
    try {
      data = JSON.parse(s);
    } catch {
      return;
    }
    const usage = data.usage || {};
    if (usage.prompt_tokens) tokens_in = Number(usage.prompt_tokens) || tokens_in;
    if (usage.completion_tokens) tokens_out = Number(usage.completion_tokens) || tokens_out;
    const choice = data.choices && data.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    const piece = String(delta.content || "");
    if (piece) {
      content += piece;
      if (typeof onDelta === "function") onDelta(piece);
    }
    const r = String(delta.reasoning_content || delta.reasoning || "");
    if (r) reasoning += r;
    if (delta.tool_calls) mergeToolCallDelta(toolBucket, delta.tool_calls);
    /* 少数兼容接口把完整字段放在 message 上 */
    if (choice.message) {
      if (choice.message.tool_calls) {
        mergeToolCallDelta(toolBucket, choice.message.tool_calls);
      }
      const mr = String(
        choice.message.reasoning_content || choice.message.reasoning || ""
      );
      if (mr) reasoning = mr;
      const mc = String(choice.message.content || "");
      if (mc && !content) content = mc;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || "";
    for (const line of parts) {
      const t = line.trim();
      if (!t || t.startsWith(":")) continue;
      if (t.startsWith("data:")) handleData(t.slice(5).trim());
    }
  }
  if (buf.trim()) {
    const t = buf.trim();
    if (t.startsWith("data:")) handleData(t.slice(5).trim());
  }

  const tool_calls = toolBucket
    .filter((t) => t && t.function && t.function.name)
    .map((t, i) => ({
      id: t.id || "call_" + i,
      type: t.type || "function",
      function: {
        name: String(t.function.name || "").trim(),
        arguments: String(t.function.arguments || ""),
      },
    }));

  return {
    content: String(content || "").trim(),
    reasoning: String(reasoning || "").trim(),
    tool_calls,
    tokens_in,
    tokens_out,
  };
}

/**
 * 整段结果（内部仍走 stream:true 再拼齐，符合「接模型必流式」）。
 * UI 要边出边画请用 chatCompletionStream + onDelta。
 */
async function chatCompletion(opts) {
  return chatCompletionStream(opts);
}

function replyKindLabel(replyKind) {
  if (replyKind === "chat") return "回复";
  if (replyKind === "summary") return "小结";
  return "跟批";
}

/** 与真发时 system 尾缀一致（深思 / 非深思） */
function withReplySuffix(system, { think = false, replyKind = "follow" } = {}) {
  const label = replyKindLabel(replyKind);
  const base = String(system || "");
  if (think) {
    return (
      base +
      `\n输出格式必须严格如下（不要用 markdown 代码块）：\n【思考】\n（简短推理）\n【${label}】\n（正文）`
    );
  }
  return base + `\n直接输出${label}正文，不要输出思考过程，不要用 markdown 代码块。`;
}

function parseThinkBody(content, think) {
  if (!think) {
    return { think: "", body: content };
  }
  const m = content.match(/【思考】\s*([\s\S]*?)\s*【(?:跟批|回复|小结)】\s*([\s\S]*)$/);
  if (m) {
    return { think: m[1].trim(), body: m[2].trim() };
  }
  const m2 = content.match(/<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/i);
  if (m2) {
    return { think: m2[1].trim(), body: m2[2].trim() };
  }
  return { think: "", body: content };
}

/** 标签【思考】优先；否则用接口 reasoning_content */
function resolveThinkText(parsed, raw, thinkOn) {
  if (!thinkOn) return null;
  const t = String((parsed && parsed.think) || (raw && raw.reasoning) || "").trim();
  return t || null;
}

module.exports = {
  chatCompletion,
  chatCompletionStream,
  parseThinkBody,
  resolveThinkText,
  chatCompletionsUrl,
  withReplySuffix,
  replyKindLabel,
};
