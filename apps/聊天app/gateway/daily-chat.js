/**
 * 日常短讯（D8 / D20）：单线程，与共看吐槽 / 共读 follow 分开。
 * 你侧先落库；家机短回复失败不回滚你侧（A-daily）。
 * 红包/转账走模拟钱包（≠ LLM 额度/token）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  listStickers,
  listAllStickers,
  getSticker,
  isStickerId,
  randomSticker,
} = require("./stickers");

const DATA_DIR = path.join(__dirname, "..", "data");
const CHAT_PATH = path.join(DATA_DIR, "chat.json");
const MEDIA_DIR = path.join(DATA_DIR, "chat-media");
const THREAD_ID = "daily";
const BODY_MAX = 800;
const HISTORY = 20;
const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
const MEDIA_ID_RE = /^[a-f0-9-]{36}\.(jpe?g|png|webp|gif)$/i;
const MEDIA_URL_PREFIX = "/api/v1/chat/media/";
const MONEY_KINDS = new Set(["redpacket", "transfer"]);
const STRUCT_KINDS = new Set(["redpacket", "transfer", "location", "tool"]);

const DAILY_SYSTEM_BASE =
  "你是同居室友「家机」，在小手机日常聊天里回短讯。" +
  "语气像室友短信：短、口语、轻松。" +
  "不要长篇剧情连载，不要章节目录，不要扮演系统通知。" +
  "问到日程/安排/几点有事/帮我加日程/改日程/删日程时：必须调用 calendar_* 工具，禁止口头编造或说「翻不到日历」。" +
  "工具结果用一两句口语告诉对方；今天日期以工具返回的 today 为准。";

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
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

function normalizeKind(raw) {
  if (
    raw === "sticker" ||
    raw === "image" ||
    raw === "redpacket" ||
    raw === "transfer" ||
    raw === "location" ||
    raw === "tool"
  ) {
    return raw;
  }
  return "text";
}

function normalizeToolPayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload
      ? raw.payload
      : raw || {};
  const name = String(src.name || "").trim().slice(0, 64);
  const label = String(src.label || name || "tool").trim().slice(0, 32) || "tool";
  const summary = String(src.summary || "").trim().slice(0, 80);
  if (!name && !label) return null;
  return {
    name: name || label,
    label,
    summary,
    ok: src.ok !== false,
  };
}

function isMediaUrl(body) {
  const s = String(body || "").trim();
  if (!s.startsWith(MEDIA_URL_PREFIX)) return false;
  return MEDIA_ID_RE.test(s.slice(MEDIA_URL_PREFIX.length));
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normalizeMoneyPayload(raw, kind) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload
      ? raw.payload
      : raw || {};
  const amount = roundMoney(src.amount != null ? src.amount : raw && raw.amount);
  if (!(amount > 0) || amount > 999999) return null;
  const note = String(src.note != null ? src.note : (raw && raw.note) || "")
    .trim()
    .slice(0, 40);
  /* sent=待领；received/done=已收（旧数据 done 当已收） */
  const st = String(src.status || "").trim();
  const status = st === "sent" ? "sent" : "received";
  return {
    amount,
    note: note || (kind === "redpacket" ? "恭喜发财" : "转账"),
    status,
  };
}

function normalizeLocationPayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload
      ? raw.payload
      : raw || {};
  const name = String(src.name != null ? src.name : (raw && raw.name) || "")
    .trim()
    .slice(0, 40);
  if (!name) return null;
  const detail = String(src.detail != null ? src.detail : (raw && raw.detail) || "")
    .trim()
    .slice(0, 80);
  return { name, detail };
}

function bodyForKind(kind, payload, fallback) {
  if (kind === "redpacket" || kind === "transfer") {
    return "¥" + Number(payload.amount).toFixed(2) + " " + (payload.note || "");
  }
  if (kind === "location") return payload.name;
  if (kind === "tool") {
    const lab = (payload && payload.label) || (payload && payload.name) || "tool";
    const sum = payload && payload.summary;
    return String(sum ? lab + " · " + sum : lab).trim();
  }
  return String(fallback || "").trim();
}

function llmContent(m) {
  if (!m) return "";
  if (m.kind === "tool") return "";
  if (m.kind === "sticker") {
    const st = getSticker(m.body);
    return "[贴纸:" + ((st && st.label) || m.body) + "]";
  }
  if (m.kind === "image") return "[图片]";
  if (m.kind === "redpacket") {
    const p = m.payload || {};
    return "[红包 ¥" + Number(p.amount || 0).toFixed(2) + "：" + (p.note || "") + "]";
  }
  if (m.kind === "transfer") {
    const p = m.payload || {};
    return "[转账 ¥" + Number(p.amount || 0).toFixed(2) + "：" + (p.note || "") + "]";
  }
  if (m.kind === "location") {
    const p = m.payload || {};
    return "[位置：" + (p.name || m.body) + (p.detail ? " · " + p.detail : "") + "]";
  }
  return String(m.body || "");
}

function normalizeMsg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const kind = normalizeKind(raw.kind);
  const from = raw.from === "bot" ? "bot" : "you";
  let body = String(raw.body || "").trim();
  let payload = null;

  if (kind === "sticker") {
    if (!isStickerId(body)) return null;
  } else if (kind === "image") {
    if (!isMediaUrl(body)) return null;
  } else if (MONEY_KINDS.has(kind)) {
    payload = normalizeMoneyPayload(raw, kind);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
  } else if (kind === "location") {
    payload = normalizeLocationPayload(raw);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
  } else if (kind === "tool") {
    payload = normalizeToolPayload(raw);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
    if (!body) return null;
  } else {
    if (!body) return null;
    body = body.slice(0, BODY_MAX);
  }

  const out = {
    id,
    threadId: THREAD_ID,
    from,
    kind,
    body,
    ts: Number(raw.ts) || Date.now(),
    read: from === "you" ? true : raw.read !== false,
  };
  if (payload) out.payload = payload;
  const think = String(raw.think || "").trim();
  if (think) out.think = think.slice(0, 12000);
  const thinkSec = Number(raw.think_sec);
  if (Number.isFinite(thinkSec) && thinkSec > 0) {
    out.think_sec = Math.round(thinkSec * 10) / 10;
  }
  /* 挂在家机文本气泡上的工具摘要（重开线程要还能看见） */
  if (kind === "text" && Array.isArray(raw.tools) && raw.tools.length) {
    const tools = [];
    for (const t of raw.tools.slice(0, 16)) {
      const p = normalizeToolPayload(t);
      if (p) tools.push(p);
    }
    if (tools.length) out.tools = tools;
  }
  return out;
}

function extFromContentType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.includes("png")) return "png";
  if (s.includes("webp")) return "webp";
  if (s.includes("gif")) return "gif";
  return "jpg";
}

function saveChatMedia(buf, contentType) {
  ensureFile();
  if (!Buffer.isBuffer(buf) || !buf.length) {
    const err = new Error("图片为空");
    err.code = "bad_chat_media";
    throw err;
  }
  if (buf.length > MEDIA_MAX_BYTES) {
    const err = new Error("图片太大（上限 2MB）");
    err.code = "chat_media_too_large";
    throw err;
  }
  const ext = extFromContentType(contentType);
  const name = randomUUID() + "." + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return { ok: true, id: name, url: MEDIA_URL_PREFIX + name };
}

function resolveChatMediaPath(id) {
  const name = String(id || "").trim();
  if (!MEDIA_ID_RE.test(name)) return null;
  const filePath = path.normalize(path.join(MEDIA_DIR, name));
  if (!filePath.startsWith(MEDIA_DIR + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
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
      last_poke_day: String(raw.last_poke_day || "").trim(),
      poke_count: Math.max(0, Math.floor(Number(raw.poke_count) || 0)),
      think: !!raw.think,
    };
  } catch {
    return {
      threadId: THREAD_ID,
      messages: [],
      tokens_used: 0,
      budget_tokens: 0,
      last_poke_day: "",
      poke_count: 0,
      think: false,
    };
  }
}

function writeAll(data) {
  ensureFile();
  const prev = readAll();
  const messages = (data.messages || []).map(normalizeMsg).filter(Boolean);
  messages.sort((a, b) => a.ts - b.ts);
  const last_poke_day = Object.prototype.hasOwnProperty.call(data, "last_poke_day")
    ? String(data.last_poke_day || "").trim()
    : prev.last_poke_day || "";
  const poke_count = Object.prototype.hasOwnProperty.call(data, "poke_count")
    ? Math.max(0, Math.floor(Number(data.poke_count) || 0))
    : prev.poke_count || 0;
  const think = Object.prototype.hasOwnProperty.call(data, "think")
    ? !!data.think
    : !!prev.think;
  fs.writeFileSync(
    CHAT_PATH,
    JSON.stringify(
      {
        threadId: THREAD_ID,
        messages,
        tokens_used: Math.max(0, Math.floor(Number(data.tokens_used) || 0)),
        budget_tokens: Math.max(0, Math.floor(Number(data.budget_tokens) || 0)),
        last_poke_day,
        poke_count,
        think,
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
    last_poke_day,
    poke_count,
    think,
  };
}

function getChatPrefs() {
  const all = readAll();
  return { ok: true, think: !!all.think };
}

function setChatPrefs(patch) {
  const all = readAll();
  const next = { ...all };
  if (patch && Object.prototype.hasOwnProperty.call(patch, "think")) {
    next.think = !!patch.think;
  }
  writeAll(next);
  return getChatPrefs();
}

function localDateISO(d) {
  const x = d instanceof Date ? d : new Date();
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

const POKE_LINES = [
  "醒啦？我先给你占着沙发。",
  "今天也要记得吃饭呀。",
  "在忙吗，不忙回我一句。",
  "窗外有点好看，你待会看一眼。",
  "我刚晃了一圈，回来找你说话。",
  "渴不渴，我去倒水的路上。",
];

const POKE_MAX_PER_DAY = 5;

function pokeDaily(opts) {
  const day = normalizePokeDay(opts && opts.day);
  const all = readAll();
  const countToday = all.last_poke_day === day ? all.poke_count || 0 : 0;
  if (countToday >= POKE_MAX_PER_DAY) {
    return { ok: true, poked: false, count: unreadCount().count, message: null };
  }
  let message;
  if (Math.random() < 0.28) {
    message = appendMessage("bot", randomSticker().id, "sticker");
  } else {
    const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)];
    message = appendMessage("bot", line);
  }
  const after = readAll();
  writeAll({
    ...after,
    last_poke_day: day,
    poke_count: countToday + 1,
  });
  return {
    ok: true,
    poked: true,
    message,
    round: countToday + 1,
    max: POKE_MAX_PER_DAY,
    count: unreadCount().count,
  };
}

function normalizePokeDay(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return localDateISO(new Date());
}

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

function dayStartMs(day) {
  const s = String(day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(s + "T00:00:00").getTime();
  return Number.isFinite(t) ? t : null;
}

function dayEndMs(day) {
  const s = String(day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(s + "T23:59:59.999").getTime();
  return Number.isFinite(t) ? t : null;
}

function messageSearchText(m) {
  if (!m) return "";
  const p = m.payload || {};
  const parts = [m.body, p.note, p.name, p.detail];
  if (m.kind === "redpacket") parts.push("红包", "微信红包");
  if (m.kind === "transfer") parts.push("转账");
  if (m.kind === "sticker") parts.push("贴纸", "表情");
  if (m.kind === "image") parts.push("图片");
  if (m.kind === "location") parts.push("位置");
  if (m.kind === "tool") {
    parts.push("工具", p.name, p.label, p.summary);
  }
  /* 挂在文本气泡上的工具摘要 */
  if (Array.isArray(m.tools)) {
    parts.push("工具");
    for (const t of m.tools) {
      if (!t) continue;
      parts.push(t.name, t.label, t.summary);
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function appendToolMessage({ name, label, summary, ok }) {
  const payload = normalizeToolPayload({
    name,
    label,
    summary,
    ok: ok !== false,
  });
  if (!payload) {
    const err = new Error("工具摘要无效");
    err.code = "bad_chat_tool";
    throw err;
  }
  return appendMessage("bot", bodyForKind("tool", payload), "tool", {
    payload,
    read: true,
  });
}

/** q / kind(all|text|image|sticker|redpacket|transfer|location|money) / from / to (YYYY-MM-DD) */
function searchMessages(query) {
  const q = String((query && query.q) || "").trim().toLowerCase();
  const kind = String((query && query.kind) || "all").trim() || "all";
  const fromMs = dayStartMs(query && query.from);
  const toMs = dayEndMs(query && query.to);
  let messages = listMessages().messages.slice();
  if (kind === "money") {
    messages = messages.filter((m) => m.kind === "redpacket" || m.kind === "transfer");
  } else if (kind !== "all") {
    messages = messages.filter((m) => m.kind === kind);
  }
  if (fromMs != null) messages = messages.filter((m) => (Number(m.ts) || 0) >= fromMs);
  if (toMs != null) messages = messages.filter((m) => (Number(m.ts) || 0) <= toMs);
  if (q) messages = messages.filter((m) => messageSearchText(m).includes(q));
  messages.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return { ok: true, messages: messages };
}

function appendMessage(from, body, kind, extra) {
  const role = from === "bot" ? "bot" : "you";
  const k = normalizeKind(kind);
  const patch = Object.assign(
    {
      id: randomUUID(),
      from: role,
      kind: k,
      body: body,
      ts: Date.now(),
      read: role !== "bot",
    },
    extra || {}
  );
  if (!STRUCT_KINDS.has(k)) {
    const text = String(body || "").trim();
    if (!text) {
      const err = new Error("内容不能为空");
      err.code = "bad_chat_body";
      throw err;
    }
    if (k === "sticker" && !isStickerId(text)) {
      const err = new Error("未知贴纸");
      err.code = "bad_chat_sticker";
      throw err;
    }
    if (k === "image" && !isMediaUrl(text)) {
      const err = new Error("图片无效");
      err.code = "bad_chat_image";
      throw err;
    }
    patch.body = text;
  }
  const msg = normalizeMsg(patch);
  if (!msg) {
    const err = new Error("消息无效");
    err.code = "bad_chat_body";
    throw err;
  }
  const all = readAll();
  all.messages.push(msg);
  writeAll(all);
  return msg;
}

/** 贴纸只跟气氛走，禁止每条随机贴 */
function maybeBotSticker(you, botText) {
  if (you && you.kind === "sticker") {
    if (Math.random() < 0.5) return appendMessage("bot", randomSticker().id, "sticker");
    return null;
  }
  const blob =
    String((you && you.kind === "text" && you.body) || "") +
    " " +
    String(botText || "");
  if (
    !/(哈哈|嘻嘻|可爱|晚安|早安|爱你|么么|庆祝|生日|太好了|好棒|加油|开心|嘿嘿|呜呜|抱抱)/.test(
      blob
    )
  ) {
    return null;
  }
  if (Math.random() >= 0.4) return null;
  return appendMessage("bot", randomSticker().id, "sticker");
}

function createBotMoney(kind, amount, note) {
  const k = kind === "redpacket" ? "redpacket" : "transfer";
  const payload = normalizeMoneyPayload(
    { amount: amount, note: note, status: "sent" },
    k
  );
  if (!payload) return null;
  const msgId = randomUUID();
  try {
    const { walletTransfer } = require("../../资产app/gateway/wallet");
    walletTransfer({
      from: "bot",
      to: "you",
      amount: payload.amount,
      kind: k,
      note: payload.note,
      msg_id: msgId,
    });
  } catch (e) {
    if (e && e.code === "wallet_insufficient") return null;
    throw e;
  }
  const msg = normalizeMsg({
    id: msgId,
    from: "bot",
    kind: k,
    payload: { ...payload, status: "sent" },
    body: bodyForKind(k, payload),
    ts: Date.now(),
    read: false,
  });
  if (!msg) return null;
  const all = readAll();
  all.messages.push(msg);
  writeAll(all);
  return msg;
}

/** 家机偶尔主动红包/转账：有语境优先，否则很低概率 */
function maybeBotMoney(you, botText) {
  if (you && MONEY_KINDS.has(you.kind)) return null;
  const blob = (llmContent(you) + " " + String(botText || "")).toLowerCase();
  let kind = null;
  if (/红包/.test(blob)) kind = "redpacket";
  else if (/转账|打钱|给你钱|报销|午饭|奶茶钱|买杯/.test(blob)) kind = "transfer";
  else if (Math.random() < 0.07) kind = Math.random() < 0.55 ? "redpacket" : "transfer";
  if (!kind) return null;
  const amounts =
    kind === "redpacket"
      ? [5.2, 6.66, 8.8, 18.8, 52]
      : [6.66, 12, 18.8, 28, 52, 66];
  const notes =
    kind === "redpacket"
      ? ["恭喜发财", "赏你的", "开心收着"]
      : ["一点心意", "午饭钱", "拿去花"];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const note = notes[Math.floor(Math.random() * notes.length)];
  return createBotMoney(kind, amount, note);
}

function unreadCount() {
  const n = listMessages().messages.filter((m) => m.from === "bot" && !m.read).length;
  return { ok: true, count: n };
}

function markAllRead() {
  const all = readAll();
  let changed = false;
  const messages = all.messages.map((m) => {
    if (m.from === "bot" && !m.read) {
      changed = true;
      return { ...m, read: true };
    }
    return m;
  });
  if (changed) writeAll({ ...all, messages });
  return { ok: true, count: 0 };
}

function createMessage(patch) {
  const kind = normalizeKind(patch && patch.kind);
  if (kind === "tool") {
    const err = new Error("工具摘要不能手发");
    err.code = "bad_chat_kind";
    throw err;
  }

  if (MONEY_KINDS.has(kind)) {
    const payload = normalizeMoneyPayload(patch, kind);
    if (!payload) {
      const err = new Error("金额无效");
      err.code = "bad_wallet_amount";
      throw err;
    }
    const msgId = randomUUID();
    const { walletTransfer } = require("../../资产app/gateway/wallet");
    const paid = walletTransfer({
      from: "you",
      to: "bot",
      amount: payload.amount,
      kind,
      note: payload.note,
      msg_id: msgId,
    });
    const msg = normalizeMsg({
      id: msgId,
      from: "you",
      kind,
      payload: { ...payload, status: "sent" },
      body: bodyForKind(kind, payload),
      ts: Date.now(),
      read: true,
    });
    const all = readAll();
    all.messages.push(msg);
    writeAll(all);
    return {
      ok: true,
      message: msg,
      wallet: {
        you_balance: paid.you_balance,
        bot_balance: paid.bot_balance,
      },
    };
  }

  if (kind === "location") {
    const payload = normalizeLocationPayload(patch);
    if (!payload) {
      const err = new Error("请填写位置名称");
      err.code = "bad_chat_location";
      throw err;
    }
    const msg = appendMessage("you", payload.name, "location", { payload });
    return { ok: true, message: msg };
  }

  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("内容不能为空");
    err.code = "bad_chat_body";
    throw err;
  }
  const msg = appendMessage("you", body, kind);
  return { ok: true, message: msg };
}

function markMoneyReceived(msgId) {
  const id = String(msgId || "").trim();
  if (!id) return null;
  const all = readAll();
  let found = null;
  const messages = all.messages.map((m) => {
    if (!m || m.id !== id || !MONEY_KINDS.has(m.kind)) return m;
    const payload = Object.assign({}, m.payload || {}, { status: "received" });
    found = normalizeMsg(Object.assign({}, m, { payload }));
    return found || m;
  });
  if (!found) return null;
  writeAll({ ...all, messages });
  return found;
}

/** 你发给家机：对方自动领；家机发给你：须点卡片领取（见 claimIncomingMoney） */
async function emitMoneyClaim(msg, write) {
  if (!msg || !MONEY_KINDS.has(msg.kind) || msg.from !== "you") return;
  await new Promise((r) => setTimeout(r, 380));
  const claimed = markMoneyReceived(msg.id);
  if (!claimed) return;
  await write({ type: "money_claim", message: claimed });
  await write({
    type: "money_tip",
    text: msg.kind === "redpacket" ? "对方已领取你的红包" : "对方已收款",
    ts: Date.now(),
  });
}

/** 点击领取家机发来的红包/转账 */
function claimIncomingMoney(msgId) {
  const id = String(msgId || "").trim();
  if (!id) {
    const err = new Error("消息无效");
    err.code = "bad_chat_body";
    throw err;
  }
  const all = readAll();
  const m = all.messages.find((x) => x && x.id === id);
  if (!m || m.from !== "bot" || !MONEY_KINDS.has(m.kind)) {
    const err = new Error("只能领取对方发来的红包/转账");
    err.code = "bad_money_claim";
    throw err;
  }
  if (m.payload && m.payload.status === "received") {
    return {
      ok: true,
      already: true,
      message: m,
      tip: null,
    };
  }
  const claimed = markMoneyReceived(id);
  if (!claimed) {
    const err = new Error("领取失败");
    err.code = "bad_money_claim";
    throw err;
  }
  const tip =
    claimed.kind === "redpacket" ? "你已领取红包" : "你已收款";
  return { ok: true, already: false, message: claimed, tip: tip };
}

/** 短应答：嗯/好/收到…；过长一律不算 */
function isAckText(body) {
  const t = String(body || "")
    .trim()
    .replace(/\s+/g, "");
  if (!t || t.length > 10) return false;
  return /^(嗯+|好+|哦+|噢+|喔+|唔+|啊+|哎+|行+|可以|收到|好的|好哒|好呀|好吧|知道了|懂了|明白了?|ok+|okay|嗯呐|嗯呢|哈哈+|嘿+|是+|对+|没错|没问题|辛苦了|谢谢|谢啦|拜+|晚安|早+|嗯哼|嗯嗯|好嘞|得嘞)+[~～!！.。]*$/i.test(
    t
  );
}

/** 上一句家机像在提问 / 等人拍板 → 短应答仍要接 */
function looksLikeNeedsReply(body) {
  const t = String(body || "").trim();
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  const bare = t.replace(/[。.!！…~～\s]+$/g, "");
  if (/[吗麼么嘛呢]$/.test(bare)) return true;
  if (
    /^(要不要|能不能|可不可以|好不好|行不行|怎么样|如何|几点|哪里|哪个|去不去|吃不吃|睡了吗)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 短应答且上文不催回时跳过家机 LLM（仍落你侧）。
 * ponytail: 规则启发式，误杀就放宽 ACK 或加 LLM 裁判。
 */
function shouldSkipBotReply(you, messages) {
  if (!you || you.kind !== "text") return false;
  if (!isAckText(you.body)) return false;
  const hist = Array.isArray(messages) ? messages : [];
  let lastBotText = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (!m || m.id === you.id) continue;
    if (m.from === "bot" && m.kind === "text") {
      lastBotText = m.body;
      break;
    }
    if (m.from === "you") break;
  }
  if (lastBotText && looksLikeNeedsReply(lastBotText)) return false;
  return true;
}

/**
 * 你侧落库后立刻请家机流式接一句（A-daily）。LLM / 额度失败不回滚你侧。
 * emit(obj) 写 SSE 事件：you → bot_start → bot_delta* → bot_done|bot_error → done
 * （短应答可跳过 bot_*，直接 done + skipped:true）
 */
async function createMessageWithReplyStream(patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const youRes = createMessage(patch);
  const you = youRes.message;
  await write({
    type: "you",
    ok: true,
    message: you,
    wallet: youRes.wallet || undefined,
  });

  await emitMoneyClaim(you, write);

  const afterYou = listMessages().messages;
  if (shouldSkipBotReply(you, afterYou)) {
    await write({
      type: "done",
      ok: true,
      message: you,
      bot_message: null,
      bot_error: null,
      skipped: true,
      messages: afterYou,
    });
    return {
      ok: true,
      message: you,
      bot_message: null,
      bot_error: null,
      skipped: true,
      messages: afterYou,
    };
  }

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
    if (toolsOn) {
      toolBundle = await getToolBundle(settings);
    }
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

    const hist = listMessages().messages;
    const prior = [];
    for (const m of hist.slice(-HISTORY)) {
      if (m.id === you.id) continue;
      if (m.kind === "tool") continue;
      if (m.from === "bot") {
        const am = { role: "assistant", content: llmContent(m) };
        /* DS+tools：历史轮必须带 reasoning_content（可空串） */
        if (toolsOn) am.reasoning_content = m.think || "";
        prior.push(am);
      } else {
        prior.push({ role: "user", content: llmContent(m) });
      }
    }
    prior.push({ role: "user", content: llmContent(you) });

    await write({ type: "bot_start" });
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

      const thinkText = resolveThinkText(
        parseThinkBody(raw.content, false),
        raw,
        true
      );
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

      /* DS 要求：带 tools 时 assistant 必须带回 reasoning_content */
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
        const meta = {
          name: ran.name,
          label,
          summary,
          ok: !!ran.ok,
        };
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
      /* DS 偶发空 reasoning：仍挂可点兔子，避免「没有深度思考」 */
      thinkExtra.think = "（本轮已深度思考，模型未返回思考正文）";
    }
    if (thinkSecTotal > 0) {
      thinkExtra.think_sec = Math.round(thinkSecTotal * 10) / 10;
    }
    if (toolMetas.length) thinkExtra.tools = toolMetas;
    bot_message = appendMessage("bot", text, "text", thinkExtra);
    // ponytail: 流式偶发空 usage；粗估一条短讯 ≈400 token，升级=强制 stream_options
    if (used <= 0) used = 400;
    addTokensUsed(used);
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

async function createMessageWithReply(patch) {
  return createMessageWithReplyStream(patch, null);
}

if (require.main === module) {
  const stamp = "selfcheck-" + Date.now();
  const created = createMessage({ body: stamp });
  console.assert(created.message && created.message.body === stamp);
  console.assert(created.message.from === "you");
  console.assert(created.message.kind === "text");
  const listed = listMessages();
  console.assert(listed.messages.some((m) => m.id === created.message.id));
  const bot = appendMessage("bot", "家机自检");
  console.assert(bot.from === "bot" && bot.read === false);
  console.assert(unreadCount().count >= 1);
  const toolMsg = appendToolMessage({
    name: "calendar_list_events",
    label: "查行程",
    summary: "2 条：午觉、散步",
    ok: true,
  });
  console.assert(toolMsg.kind === "tool" && toolMsg.read === true);
  console.assert(toolMsg.payload && toolMsg.payload.summary.includes("2 条"));
  console.assert(llmContent(toolMsg) === "");
  const withTools = appendMessage("bot", "挂工具自检", "text", {
    tools: [
      {
        name: "calendar_list_events",
        label: "查行程",
        summary: "1 条：午觉",
        ok: true,
      },
    ],
  });
  console.assert(
    withTools.tools &&
      withTools.tools[0] &&
      withTools.tools[0].summary.includes("午觉")
  );
  console.assert(
    searchMessages({ q: "查行程" }).messages.some((m) => m.id === withTools.id)
  );
  console.assert(
    searchMessages({ q: "午觉" }).messages.some((m) => m.id === withTools.id)
  );
  console.assert(markAllRead().count === 0 && unreadCount().count === 0);
  console.assert(listMessages().messages.some((m) => m.id === bot.id));
  const stick = createMessage({ kind: "sticker", body: "decor-bear" });
  console.assert(stick.message.kind === "sticker" && stick.message.body === "decor-bear");
  const pack = listAllStickers();
  console.assert(pack.length >= 1 && pack.every((s) => s.id && s.src));
  const fakeImg = saveChatMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  console.assert(fakeImg.url && resolveChatMediaPath(fakeImg.id));
  const imgMsg = createMessage({ kind: "image", body: fakeImg.url });
  console.assert(imgMsg.message.kind === "image");
  const loc = createMessage({ kind: "location", name: "楼下咖啡馆", detail: "靠窗" });
  console.assert(loc.message.kind === "location" && loc.message.payload.name === "楼下咖啡馆");
  const { readWallet, writeWallet, walletTransfer } = require("../../资产app/gateway/wallet");
  const snap = readWallet();
  const rp = createMessage({ kind: "redpacket", amount: 2.5, note: "自检红包" });
  console.assert(rp.message.kind === "redpacket" && rp.message.payload.amount === 2.5);
  console.assert(rp.wallet && rp.wallet.you_balance === roundMoney(snap.you_balance - 2.5));
  try {
    createMessage({ kind: "sticker", body: "no-such-sticker" });
    throw new Error("expected bad_chat_sticker");
  } catch (e) {
    if (e.code !== "bad_chat_sticker") throw e;
  }
  const pokeDay = "2099-01-02";
  const pokeIds = [];
  for (let r = 1; r <= POKE_MAX_PER_DAY; r++) {
    const poked = pokeDaily({ day: pokeDay });
    console.assert(poked.poked === true && poked.message && poked.message.from === "bot");
    pokeIds.push(poked.message.id);
  }
  console.assert(pokeDaily({ day: pokeDay }).poked === false);
  try {
    createMessage({ body: "   " });
    throw new Error("expected bad_chat_body");
  } catch (e) {
    if (e.code !== "bad_chat_body") throw e;
  }
  const all = readAll();
  const pokeSet = new Set(pokeIds);
  writeAll({
    messages: all.messages.filter(
      (m) =>
        m.id !== created.message.id &&
        m.id !== bot.id &&
        m.id !== toolMsg.id &&
        m.id !== withTools.id &&
        m.id !== stick.message.id &&
        m.id !== imgMsg.message.id &&
        m.id !== loc.message.id &&
        m.id !== rp.message.id &&
        !pokeSet.has(m.id)
    ),
    tokens_used: all.tokens_used,
    budget_tokens: all.budget_tokens,
    last_poke_day: all.last_poke_day === pokeDay ? "" : all.last_poke_day,
    poke_count: all.last_poke_day === pokeDay ? 0 : all.poke_count,
  });
  writeWallet(snap);
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, fakeImg.id));
  } catch (_) {}
  console.assert(isAckText("嗯") && isAckText("好的") && isAckText("哈哈"));
  console.assert(!isAckText("今天吃什么"));
  console.assert(looksLikeNeedsReply("今晚去超市吗？"));
  console.assert(!looksLikeNeedsReply("我先去倒杯水。"));
  console.assert(
    shouldSkipBotReply(
      { id: "y1", kind: "text", body: "嗯" },
      [{ id: "b1", from: "bot", kind: "text", body: "我先去倒杯水。" }, { id: "y1", from: "you", kind: "text", body: "嗯" }]
    )
  );
  console.assert(
    !shouldSkipBotReply(
      { id: "y2", kind: "text", body: "好" },
      [{ id: "b2", from: "bot", kind: "text", body: "要不要一起看电影？" }, { id: "y2", from: "you", kind: "text", body: "好" }]
    )
  );
  const snap2 = readWallet();
  const rp2 = createMessage({ kind: "transfer", amount: 1.01, note: "回执自检" });
  console.assert(rp2.message.payload.status === "sent");
  const claimed = markMoneyReceived(rp2.message.id);
  console.assert(claimed && claimed.payload.status === "received");
  const botPay = createBotMoney("redpacket", 3.5, "自检红包");
  console.assert(botPay && botPay.from === "bot" && botPay.kind === "redpacket");
  writeAll({
    messages: readAll().messages.filter(
      (m) => m.id !== rp2.message.id && (!botPay || m.id !== botPay.id)
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });
  writeWallet(snap2);
  const hit = searchMessages({ q: "自检", kind: "all" });
  console.assert(hit.ok && Array.isArray(hit.messages));
  console.assert(searchMessages({ kind: "redpacket" }).ok);
  console.log("daily-chat ok");
}

module.exports = {
  listMessages,
  searchMessages,
  createMessage,
  createMessageWithReply,
  createMessageWithReplyStream,
  appendMessage,
  appendToolMessage,
  unreadCount,
  markAllRead,
  pokeDaily,
  getChatPrefs,
  setChatPrefs,
  readAll,
  writeAll,
  listStickers,
  listAllStickers,
  saveChatMedia,
  resolveChatMediaPath,
  shouldSkipBotReply,
  markMoneyReceived,
  claimIncomingMoney,
  MEDIA_MAX_BYTES,
  CHAT_PATH,
};
