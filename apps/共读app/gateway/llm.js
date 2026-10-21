const { readSettings } = require("./settings");

function chatCompletionsUrl(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "";
  if (b.endsWith("/chat/completions")) return b;
  return b + "/chat/completions";
}

function audioTranscriptionsUrl(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "";
  if (b.endsWith("/audio/transcriptions")) return b;
  if (b.endsWith("/chat/completions")) {
    return b.slice(0, -"/chat/completions".length) + "/audio/transcriptions";
  }
  return b + "/audio/transcriptions";
}

function embeddingsUrl(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "";
  if (b.endsWith("/embeddings")) return b;
  if (b.endsWith("/chat/completions")) {
    return b.slice(0, -"/chat/completions".length) + "/embeddings";
  }
  if (b.endsWith("/v1")) return b + "/embeddings";
  return b + "/embeddings";
}

/** 设定里填了 embed_model 且有 Base/Key 才可用 */
function embedConfigured() {
  const s = readSettings();
  return !!(
    String(s.embed_model || "").trim() &&
    String(s.llm_base || "").trim() &&
    String(s.llm_key || "").trim()
  );
}

/**
 * OpenAI 兼容 embeddings：POST {base}/embeddings
 * 复用 llm_base / llm_key；模型用 embed_model（如 BAAI/bge-m3）。
 * @returns {Promise<number[][] | null>} 未配置返回 null
 */
async function embedTexts(texts) {
  if (!embedConfigured()) return null;
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || "").trim().slice(0, 2000))
    .filter(Boolean);
  if (!list.length) return [];
  const s = readSettings();
  const base = String(s.llm_base || "").trim();
  const key = String(s.llm_key || "").trim();
  const model = String(s.embed_model || "").trim();
  const url = embeddingsUrl(base);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: list.length === 1 ? list[0] : list }),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = {};
  }
  if (!res.ok) {
    const detail =
      (data && data.error && (data.error.message || data.error)) ||
      (data && data.message) ||
      raw.slice(0, 160);
    const err = new Error(
      String(detail || "").trim() || "Embedding HTTP " + res.status
    );
    err.code = "embed_failed";
    throw err;
  }
  const rows = Array.isArray(data.data) ? data.data : [];
  rows.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const out = rows.map((r) => {
    const emb = r && r.embedding;
    if (!Array.isArray(emb) || !emb.length) return null;
    return emb.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  });
  if (out.some((v) => !v || !v.length)) {
    const err = new Error("Embedding 返回空向量");
    err.code = "embed_empty";
    throw err;
  }
  return out;
}

async function embedOne(text) {
  const vecs = await embedTexts([text]);
  if (!vecs || !vecs.length) return null;
  return vecs[0];
}

/**
 * OpenAI 兼容语音转写：POST {base}/audio/transcriptions
 * 复用设定里的 llm_base / llm_key；model 默认 whisper-1，可被 asr_model 覆盖。
 */
async function transcribeAudio({ buf, contentType, filename }) {
  const s = readSettings();
  const base = String(s.llm_base || "").trim();
  const key = String(s.llm_key || "").trim();
  const model =
    String(s.asr_model || "").trim() ||
    process.env.ASR_MODEL ||
    "whisper-1";
  if (!base || !key) {
    const err = new Error("请先在设定里填写 LLM Base / Key");
    err.code = "llm_not_configured";
    throw err;
  }
  const url = audioTranscriptionsUrl(base);
  if (!url) {
    const err = new Error("LLM Base 无效");
    err.code = "llm_not_configured";
    throw err;
  }
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!body.length) {
    const err = new Error("音频为空");
    err.code = "bad_audio";
    throw err;
  }
  const form = new FormData();
  const name = String(filename || "audio.webm").replace(/[/\\]/g, "") || "audio.webm";
  const type = String(contentType || "application/octet-stream");
  form.append("file", new Blob([body], { type }), name);
  form.append("model", model);
  form.append("language", "zh");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
    });
  } catch (e) {
    const err = new Error((e && e.message) || "转写请求失败");
    err.code = "asr_failed";
    throw err;
  }
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = {};
  }
  if (!res.ok) {
    const eObj = data && data.error;
    const detail =
      (typeof eObj === "string" && eObj) ||
      (eObj && eObj.message) ||
      (data && data.message) ||
      "";
    const err = new Error(
      String(detail || "").trim() ||
        "转写失败 HTTP " + res.status + "（请确认 Base 支持 /audio/transcriptions）"
    );
    err.code = res.status === 404 ? "asr_unsupported" : "asr_failed";
    throw err;
  }
  const text = String(
    (data && data.text) ||
      (typeof data === "string" ? data : "") ||
      ""
  ).trim();
  if (!text) {
    const err = new Error("未识别出文字");
    err.code = "asr_empty";
    throw err;
  }
  return { text: text.slice(0, 2000), model };
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
  audioTranscriptionsUrl,
  embeddingsUrl,
  embedConfigured,
  embedTexts,
  embedOne,
  transcribeAudio,
  withReplySuffix,
  replyKindLabel,
};
