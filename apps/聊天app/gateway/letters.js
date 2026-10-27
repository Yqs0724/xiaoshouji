/**
 * H8 Letters 邮局：异步写信 / 收信（≠ 主线聊天气泡）。
 * 按 peer 分桶；草稿可存；寄出后可请 TA 回信；收信可一键进记忆库。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "letters.json");

const BODY_MAX = 4000;
const SUBJECT_MAX = 48;
const LETTERS_MAX = 120;
const DRAFT_MAX = 8;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ version: 1, peers: {} }, null, 2),
      "utf8"
    );
  }
}

function normalizePeerId(raw) {
  const s = String(raw || "").trim();
  if (/^[a-zA-Z0-9_-]{1,32}$/.test(s)) return s;
  return "daily";
}

function clip(s, n) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, n);
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const peers =
      raw && raw.peers && typeof raw.peers === "object" ? raw.peers : {};
    return { version: 1, peers };
  } catch (_) {
    return { version: 1, peers: {} };
  }
}

function writeStore(store) {
  ensureFile();
  fs.writeFileSync(
    STORE_PATH,
    JSON.stringify({ version: 1, peers: store.peers || {} }, null, 2),
    "utf8"
  );
}

function peerBucket(store, peerId) {
  const pid = normalizePeerId(peerId);
  if (!store.peers[pid] || typeof store.peers[pid] !== "object") {
    store.peers[pid] = { letters: [] };
  }
  if (!Array.isArray(store.peers[pid].letters)) store.peers[pid].letters = [];
  return store.peers[pid];
}

function publicLetter(L) {
  if (!L) return null;
  return {
    id: L.id,
    peerId: L.peerId,
    direction: L.direction,
    status: L.status,
    subject: L.subject || "",
    body: L.body || "",
    parent_id: L.parent_id || "",
    parent_excerpt: L.parent_excerpt || "",
    created_at: L.created_at,
    updated_at: L.updated_at,
    opened_at: L.opened_at || 0,
    sent_at: L.sent_at || 0,
  };
}

function findLetter(bucket, id) {
  const sid = String(id || "").trim();
  if (!sid) return null;
  return (bucket.letters || []).find((x) => x && x.id === sid) || null;
}

function listLetters(peerId, opts) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const q = String((opts && opts.q) || "")
    .trim()
    .toLowerCase();
  let rows = (bucket.letters || []).map(publicLetter).filter(Boolean);
  if (q) {
    rows = rows.filter((L) => {
      const hay = (L.subject + " " + L.body).toLowerCase();
      return hay.includes(q);
    });
  }
  rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const limit = Math.max(1, Math.min(200, Number((opts && opts.limit) || 80)));
  return {
    ok: true,
    peerId: pid,
    letters: rows.slice(0, limit),
    unread: rows.filter(
      (L) => L.direction === "bot" && L.status === "inbox"
    ).length,
  };
}

function getLetter(peerId, id) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const hit = findLetter(bucket, id);
  if (!hit) {
    const err = new Error("信件不存在");
    err.code = "letter_missing";
    throw err;
  }
  return { ok: true, letter: publicLetter(hit) };
}

function saveDraft(peerId, patch) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const now = Date.now();
  const subject = clip(patch && patch.subject, SUBJECT_MAX);
  const body = clip(patch && patch.body, BODY_MAX);
  if (!body && !subject) {
    const err = new Error("草稿不能为空");
    err.code = "bad_letter";
    throw err;
  }
  let L = null;
  const sid = String((patch && patch.id) || "").trim();
  if (sid) {
    L = findLetter(bucket, sid);
    if (!L || L.direction !== "you" || L.status !== "draft") {
      const err = new Error("只能改自己的草稿");
      err.code = "letter_locked";
      throw err;
    }
    L.subject = subject;
    L.body = body;
    L.updated_at = now;
  } else {
    const drafts = bucket.letters.filter(
      (x) => x && x.direction === "you" && x.status === "draft"
    );
    if (drafts.length >= DRAFT_MAX) {
      const err = new Error("草稿太多，先寄出或删掉几封");
      err.code = "drafts_full";
      throw err;
    }
    if (bucket.letters.length >= LETTERS_MAX) {
      const err = new Error("信箱已满");
      err.code = "letters_full";
      throw err;
    }
    L = {
      id: randomUUID(),
      peerId: pid,
      direction: "you",
      status: "draft",
      subject,
      body,
      parent_id: "",
      parent_excerpt: "",
      created_at: now,
      updated_at: now,
      opened_at: 0,
      sent_at: 0,
    };
    bucket.letters.unshift(L);
  }
  writeStore(store);
  return { ok: true, letter: publicLetter(L) };
}

function sendLetter(peerId, patch) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const now = Date.now();
  const sid = String((patch && patch.id) || "").trim();
  let L = sid ? findLetter(bucket, sid) : null;
  const subject = clip(
    patch && patch.subject != null ? patch.subject : L && L.subject,
    SUBJECT_MAX
  );
  const body = clip(
    patch && patch.body != null ? patch.body : L && L.body,
    BODY_MAX
  );
  if (!body) {
    const err = new Error("正文不能为空");
    err.code = "bad_letter";
    throw err;
  }
  if (L) {
    if (L.direction !== "you" || (L.status !== "draft" && L.status !== "sent")) {
      const err = new Error("无法寄出这封信");
      err.code = "letter_locked";
      throw err;
    }
    L.subject = subject;
    L.body = body;
    L.status = "sent";
    L.sent_at = now;
    L.updated_at = now;
  } else {
    if (bucket.letters.length >= LETTERS_MAX) {
      const err = new Error("信箱已满");
      err.code = "letters_full";
      throw err;
    }
    L = {
      id: randomUUID(),
      peerId: pid,
      direction: "you",
      status: "sent",
      subject,
      body,
      parent_id: "",
      parent_excerpt: "",
      created_at: now,
      updated_at: now,
      opened_at: 0,
      sent_at: now,
    };
    bucket.letters.unshift(L);
  }
  writeStore(store);
  return { ok: true, letter: publicLetter(L) };
}

function openLetter(peerId, id) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const L = findLetter(bucket, id);
  if (!L) {
    const err = new Error("信件不存在");
    err.code = "letter_missing";
    throw err;
  }
  const now = Date.now();
  if (L.direction === "bot" && L.status === "inbox") {
    L.status = "opened";
    L.opened_at = now;
    L.updated_at = now;
    writeStore(store);
  }
  return { ok: true, letter: publicLetter(L) };
}

function deleteLetter(peerId, id) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  const sid = String(id || "").trim();
  const before = bucket.letters.length;
  bucket.letters = bucket.letters.filter((x) => !(x && x.id === sid));
  if (bucket.letters.length === before) {
    const err = new Error("信件不存在");
    err.code = "letter_missing";
    throw err;
  }
  writeStore(store);
  return { ok: true, id: sid };
}

/** 测试/内部：直接投一封 bot 信（不走 LLM） */
function deliverBotLetter(peerId, patch) {
  const store = readStore();
  const pid = normalizePeerId(peerId);
  const bucket = peerBucket(store, pid);
  if (bucket.letters.length >= LETTERS_MAX) {
    const err = new Error("信箱已满");
    err.code = "letters_full";
    throw err;
  }
  const now = Date.now();
  const parentId = String((patch && patch.parent_id) || "").trim();
  let parentExcerpt = "";
  if (parentId) {
    const parent = findLetter(bucket, parentId);
    if (parent && parent.direction === "you") {
      parentExcerpt = clip(parent.body, 280);
    }
  }
  const L = {
    id: randomUUID(),
    peerId: pid,
    direction: "bot",
    status: "inbox",
    subject: clip(patch && patch.subject, SUBJECT_MAX) || (parentId ? "Re" : "来信"),
    body: clip(patch && patch.body, BODY_MAX) || "……",
    parent_id: parentId,
    parent_excerpt: parentExcerpt,
    created_at: now,
    updated_at: now,
    opened_at: 0,
    sent_at: now,
  };
  bucket.letters.unshift(L);
  writeStore(store);
  return { ok: true, letter: publicLetter(L) };
}

function peerLabel(peerId) {
  try {
    const { listPeers, DEFAULT_PEER_ID } = require("./daily-chat");
    const pid = normalizePeerId(peerId);
    const hit = (listPeers().peers || []).find((p) => p && p.id === pid);
    if (hit && hit.name) return { name: hit.name, persona: hit.persona || "" };
    if (pid === DEFAULT_PEER_ID) return { name: "家机", persona: "" };
  } catch (_) {}
  return { name: "家机", persona: "" };
}

function gatherLetterContext(peerId) {
  const pid = normalizePeerId(peerId);
  const bits = [];
  try {
    const { withPeer, listMessages, llmContent } = require("./daily-chat");
    withPeer(pid, () => {
      const msgs = (listMessages().messages || []).slice(-12);
      for (const m of msgs) {
        const t = String(llmContent(m) || "").trim();
        if (!t) continue;
        bits.push((m.from === "bot" ? "TA" : "你") + "：" + t.slice(0, 160));
      }
    });
  } catch (_) {}
  try {
    const { listPeerMemories } = require("./memory");
    const listed = listPeerMemories(pid, { limit: 6 });
    for (const r of (listed && listed.memories) || []) {
      const c = String((r && r.content) || "").trim();
      if (c) bits.push("记忆：" + c.slice(0, 120));
    }
  } catch (_) {}
  try {
    const { listEntries } = require("./auto-memory");
    const listed = listEntries(pid, { limit: 8 });
    for (const e of (listed && listed.entries) || []) {
      const c = String(e.body || "").trim();
      if (c) bits.push("档案：" + c.slice(0, 100));
    }
  } catch (_) {}
  return bits.slice(0, 24).join("\n");
}

/**
 * 请 TA 写信投递；可选 reply_to=你已寄出的信 id。
 * 计额度；失败抛错。
 */
async function receiveLetter(peerId, opts) {
  const {
    withPeer,
    addTokensUsed,
    budgetExhausted,
    readAll,
  } = require("./daily-chat");
  const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
  const pid = normalizePeerId(peerId);
  const replyTo = String((opts && (opts.reply_to || opts.parent_id)) || "").trim();

  return withPeer(pid, async () => {
    const state = readAll();
    if (budgetExhausted(state)) {
      const err = new Error("额度不足，无法收信");
      err.code = "budget_exhausted";
      throw err;
    }
    if (replyTo) {
      const cur = getLetter(pid, replyTo).letter;
      if (!cur || cur.direction !== "you" || cur.status !== "sent") {
        const err = new Error("只能对已寄出的信请回信");
        err.code = "bad_reply_to";
        throw err;
      }
    }
    const meta = peerLabel(pid);
    const ctx = gatherLetterContext(pid);
    const system =
      "你是「" +
      meta.name +
      "」，正在给对方写一封异步书信（不是聊天气泡）。" +
      (meta.persona ? "人设：" + String(meta.persona).slice(0, 240) + "。" : "") +
      "语气真诚、有温度；不要工具调用、不要 markdown 代码块。" +
      '只输出 JSON：{"subject":"标题≤20字","body":"正文"}。正文 120～800 字。';
    let user =
      "请根据你对对方的了解写一封信投递到邮局。\n背景摘录：\n" +
      (ctx || "（暂无摘录，写一封温和的近况问候即可）");
    if (replyTo) {
      const parent = getLetter(pid, replyTo).letter;
      user =
        "对方先写了这封信给你，请写回信（信封抬头 Re）。\n" +
        "来信标题：" +
        (parent.subject || "（无）") +
        "\n来信正文：\n" +
        parent.body +
        "\n\n背景摘录：\n" +
        (ctx || "（无）");
    }
    let raw;
    try {
      raw = await chatCompletion({
        system,
        user,
        think: false,
        replyKind: "chat",
      });
    } catch (e) {
      const err = new Error((e && e.message) || "写信请求失败");
      err.code = (e && e.code) || "llm_failed";
      throw err;
    }
    const used =
      (Number(raw && raw.tokens_in) || 0) +
        (Number(raw && raw.tokens_out) || 0) || 800;
    addTokensUsed(used);
    const parsed = parseThinkBody(raw && raw.content, false);
    const text = String((parsed && parsed.body) || (raw && raw.content) || "");
    let subject = "";
    let body = "";
    try {
      const m = text.match(/\{[\s\S]*\}/);
      const j = JSON.parse(m ? m[0] : text);
      subject = clip(j.subject, SUBJECT_MAX);
      body = clip(j.body, BODY_MAX);
    } catch (_) {
      body = clip(text.replace(/^```[\s\S]*?```/g, ""), BODY_MAX);
    }
    if (!body) {
      const err = new Error("TA 没写出正文");
      err.code = "empty_letter";
      throw err;
    }
    return deliverBotLetter(pid, {
      subject: subject || (replyTo ? "Re" : "来信"),
      body,
      parent_id: replyTo,
    });
  });
}

function letterToMemory(peerId, id) {
  const { addMemory } = require("./memory");
  const pid = normalizePeerId(peerId);
  const { letter } = getLetter(pid, id);
  const who = letter.direction === "bot" ? "TA来信" : "我的信";
  const content = clip(
    "【邮局·" +
      who +
      "】" +
      (letter.subject ? letter.subject + " · " : "") +
      letter.body,
    500
  );
  return addMemory(pid, {
    content,
    keywords: ["邮局", "信件", letter.subject].filter(Boolean),
    category: "日常",
    importance: 6,
  });
}

if (require.main === module) {
  const pid = "daily";
  const d = saveDraft(pid, { subject: "H8草稿", body: "草稿正文-" + Date.now() });
  console.assert(d.ok && d.letter.status === "draft");
  const sent = sendLetter(pid, { id: d.letter.id, body: d.letter.body + "·寄" });
  console.assert(sent.letter.status === "sent");
  const bot = deliverBotLetter(pid, {
    subject: "回你",
    body: "收到了。",
    parent_id: sent.letter.id,
  });
  console.assert(bot.letter.direction === "bot" && bot.letter.parent_id === sent.letter.id);
  const opened = openLetter(pid, bot.letter.id);
  console.assert(opened.letter.status === "opened");
  const listed = listLetters(pid);
  console.assert(listed.letters.some((x) => x.id === sent.letter.id));
  deleteLetter(pid, d.letter.id);
  deleteLetter(pid, bot.letter.id);
  console.assert(!listLetters(pid).letters.some((x) => x.id === bot.letter.id));
  console.log("letters ok");
}

module.exports = {
  STORE_PATH,
  listLetters,
  getLetter,
  saveDraft,
  sendLetter,
  openLetter,
  deleteLetter,
  deliverBotLetter,
  receiveLetter,
  letterToMemory,
  normalizePeerId,
};
