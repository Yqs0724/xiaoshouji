const { readSettings } = require("./settings");

function chatCompletionsUrl(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "";
  if (b.endsWith("/chat/completions")) return b;
  return b + "/chat/completions";
}

/**
 * OpenAI 兼容 chat.completions
 * @returns {{ content: string, tokens_in: number, tokens_out: number }}
 */
async function chatCompletion({
  system,
  user,
  messages,
  think,
  model: modelOverride,
  replyKind = "follow",
}) {
  const s = readSettings();
  const base = s.llm_base.trim();
  const key = s.llm_key.trim();
  const model = String(modelOverride || s.llm_model || "").trim();
  if (!base || !key || !model) {
    const err = new Error("请先在设定里填写 LLM Base / Key / Model");
    err.code = "llm_not_configured";
    throw err;
  }

  const url = chatCompletionsUrl(base);
  const sys = withReplySuffix(system, { think, replyKind });

  const msgList = Array.isArray(messages) && messages.length
    ? [{ role: "system", content: sys }, ...messages.filter((m) => m.role !== "system")]
    : [
        { role: "system", content: sys },
        { role: "user", content: user },
      ];

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: msgList,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("LLM 返回无法解析");
    err.code = "llm_bad_response";
    throw err;
  }
  if (!res.ok) {
    const msg =
      (data.error && (data.error.message || data.error)) ||
      data.message ||
      `LLM HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : "LLM 请求失败");
    err.code = "llm_http";
    err.status = res.status;
    throw err;
  }

  const msg =
    (data.choices && data.choices[0] && data.choices[0].message) || {};
  const content = String(msg.content || "").trim();
  // DeepSeek 等把思维链放在 reasoning_content，正文只在 content
  const reasoning = String(
    msg.reasoning_content || msg.reasoning || ""
  ).trim();
  const usage = data.usage || {};
  return {
    content,
    reasoning,
    tokens_in: Number(usage.prompt_tokens) || 0,
    tokens_out: Number(usage.completion_tokens) || 0,
  };
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
  parseThinkBody,
  resolveThinkText,
  chatCompletionsUrl,
  withReplySuffix,
  replyKindLabel,
};
