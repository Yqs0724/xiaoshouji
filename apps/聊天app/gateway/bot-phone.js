/**
 * 反查：用户翻看「家机的手机」虚拟壳 + 留痕，供下次开口时注入。
 * ponytail: 剧本种子写死；以后可按人设/好感生成。升级：圈子真 peer、代发全流程。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DATA_PATH = path.join(__dirname, "..", "data", "bot-phone.json");

function emptyStore() {
  return {
    version: 1,
    seeded: false,
    memos: [],
    chats: [],
    shop: [],
    album_locked: true,
    traces: [],
  };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    return Object.assign(emptyStore(), raw, {
      memos: Array.isArray(raw.memos) ? raw.memos : [],
      chats: Array.isArray(raw.chats) ? raw.chats : [],
      shop: Array.isArray(raw.shop) ? raw.shop : [],
      traces: Array.isArray(raw.traces) ? raw.traces : [],
      album_locked: raw.album_locked !== false,
    });
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
}

function seedIfNeeded(store, botName) {
  if (store.seeded && store.chats.length) return store;
  const name = String(botName || "家机").trim().slice(0, 16) || "家机";
  store.seeded = true;
  store.memos = [
    {
      id: "m1",
      title: "备忘",
      body: "周末带点薄荷巧克力。别忘了。",
      ts: Date.now() - 86400000 * 2,
    },
    {
      id: "m2",
      title: "密码备忘（勿给别人看）",
      body: "相册试了试 2580……好像不对。算了。",
      ts: Date.now() - 86400000 * 5,
    },
  ];
  store.chats = [
    {
      id: "c-mom",
      title: "妈妈",
      kind: "dm",
      preview: "记得吃饭",
      messages: [
        { id: "a1", from: "them", text: "在忙吗？", ts: Date.now() - 86400000 },
        { id: "a2", from: "me", text: "嗯，有点。", ts: Date.now() - 86000000 },
        { id: "a3", from: "them", text: "记得吃饭", ts: Date.now() - 85000000 },
      ],
    },
    {
      id: "c-work",
      title: "同事·阿凯",
      kind: "dm",
      preview: "那份材料我放桌上了",
      messages: [
        {
          id: "b1",
          from: "them",
          text: "今晚聚餐去吗？",
          ts: Date.now() - 7200000,
        },
        {
          id: "b2",
          from: "me",
          text: "不去了，有约。",
          ts: Date.now() - 7000000,
        },
        {
          id: "b3",
          from: "them",
          text: "那份材料我放桌上了",
          ts: Date.now() - 6800000,
        },
      ],
    },
    {
      id: "c-secret",
      title: "不备注",
      kind: "dm",
      preview: "那瓶香水你喜欢吗",
      messages: [
        {
          id: "c1",
          from: "them",
          text: "上次说的男士香水到了。",
          ts: Date.now() - 172800000,
        },
        {
          id: "c2",
          from: "me",
          text: "……你买这个干什么。",
          ts: Date.now() - 172000000,
        },
        {
          id: "c3",
          from: "them",
          text: "那瓶香水你喜欢吗？想着送你来着。",
          ts: Date.now() - 170000000,
        },
        {
          id: "c4",
          from: "me",
          text: "先放着。别跟别人说。",
          ts: Date.now() - 169000000,
        },
      ],
    },
  ];
  store.shop = [
    {
      id: "s1",
      title: "男士淡香水 50ml",
      shop: "某宝旗舰",
      amount: "¥328.00",
      status: "已签收",
      note: "还没送出去",
      ts: Date.now() - 200000000,
    },
    {
      id: "s2",
      title: "薄荷巧克力礼盒",
      shop: "本地店",
      amount: "¥68.00",
      status: "已签收",
      note: "",
      ts: Date.now() - 500000000,
    },
  ];
  store.owner_name = name;
  return store;
}

function ensureStore(botName) {
  const store = seedIfNeeded(readStore(), botName);
  writeStore(store);
  return store;
}

function addTrace(store, kind, detail) {
  const row = {
    id: randomUUID(),
    kind: String(kind || "open").slice(0, 32),
    detail: String(detail || "").trim().slice(0, 160),
    ts: Date.now(),
    seen: false,
  };
  store.traces.push(row);
  if (store.traces.length > 80) store.traces = store.traces.slice(-80);
  return row;
}

function getOverview(botName) {
  const store = ensureStore(botName);
  return {
    ok: true,
    owner_name: store.owner_name || botName || "家机",
    album_locked: !!store.album_locked,
    apps: [
      { id: "wechat", label: "微信" },
      { id: "memo", label: "备忘录" },
      { id: "shop", label: "购物" },
      { id: "album", label: "相册" },
    ],
    chats: store.chats.map((c) => ({
      id: c.id,
      title: c.title,
      preview: c.preview || "",
      kind: c.kind || "dm",
    })),
    memos: store.memos.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      ts: m.ts,
    })),
    shop: store.shop.slice(),
    unread_traces: store.traces.filter((t) => !t.seen).length,
  };
}

function openApp(appId, botName) {
  const store = ensureStore(botName);
  const id = String(appId || "").trim();
  const labels = {
    wechat: "微信",
    memo: "备忘录",
    shop: "购物记录",
    album: "相册",
    home: "桌面",
  };
  if (id === "album" && store.album_locked) {
    addTrace(store, "album_locked", "试图打开相册，密码不对作罢");
    writeStore(store);
    return {
      ok: true,
      app: "album",
      locked: true,
      message: "有密码，打不开。",
    };
  }
  addTrace(store, "open_app", "打开了「" + (labels[id] || id || "未知") + "」");
  writeStore(store);
  if (id === "wechat") {
    return { ok: true, app: "wechat", chats: getOverview(botName).chats };
  }
  if (id === "memo") {
    return { ok: true, app: "memo", memos: getOverview(botName).memos };
  }
  if (id === "shop") {
    return { ok: true, app: "shop", shop: store.shop.slice() };
  }
  if (id === "album") {
    return {
      ok: true,
      app: "album",
      locked: false,
      message: "几张日常照片，没什么特别的。",
    };
  }
  return { ok: true, app: "home" };
}

function openChat(chatId, botName) {
  const store = ensureStore(botName);
  const id = String(chatId || "").trim();
  const chat = store.chats.find((c) => c.id === id);
  if (!chat) {
    return { ok: false, error: "chat_gone", message: "没有这个会话" };
  }
  addTrace(
    store,
    "read_chat",
    "翻看了和「" + chat.title + "」的聊天"
  );
  writeStore(store);
  return {
    ok: true,
    chat: {
      id: chat.id,
      title: chat.title,
      messages: (chat.messages || []).map((m) => ({
        id: m.id,
        from: m.from,
        text: m.text,
        ts: m.ts,
      })),
    },
  };
}

function updateMemo(memoId, body, botName) {
  const store = ensureStore(botName);
  const id = String(memoId || "").trim();
  const hit = store.memos.find((m) => m.id === id);
  if (!hit) {
    return { ok: false, error: "memo_gone", message: "备忘不存在" };
  }
  const prev = String(hit.body || "");
  hit.body = String(body || "").trim().slice(0, 800);
  hit.ts = Date.now();
  addTrace(
    store,
    "edit_memo",
    "改了备忘「" + hit.title + "」" + (prev !== hit.body ? "（内容变了）" : "")
  );
  writeStore(store);
  return { ok: true, memo: hit };
}

function listUnreadTraces() {
  const store = readStore();
  return (store.traces || []).filter((t) => t && !t.seen);
}

function formatUnreadTracesForSystem() {
  const unread = listUnreadTraces();
  if (!unread.length) return "";
  const lines = unread.slice(-6).map((t) => {
    const d = String(t.detail || t.kind || "翻过手机").trim();
    return d;
  });
  return (
    "[手机被动过·勿念出「系统提示」] 你察觉手机被翻过：" +
    lines.join("；") +
    "。按性格反应（心虚/吃醋/嘴硬/纵容均可）；可提具体翻到的内容；勿说「我监控了你」。"
  );
}

function markTracesSeen() {
  const store = readStore();
  let n = 0;
  for (const t of store.traces || []) {
    if (t && !t.seen) {
      t.seen = true;
      n += 1;
    }
  }
  if (n) writeStore(store);
  return { ok: true, marked: n };
}

function resetForTests() {
  try {
    if (fs.existsSync(DATA_PATH)) fs.unlinkSync(DATA_PATH);
  } catch (_) {}
}

if (require.main === module) {
  resetForTests();
  const ov = getOverview("薄巧");
  console.assert(ov.chats.length >= 2, "chats");
  openApp("wechat", "薄巧");
  openChat(ov.chats[0].id, "薄巧");
  openApp("album", "薄巧");
  const sys = formatUnreadTracesForSystem();
  console.assert(sys.includes("翻"), sys);
  markTracesSeen();
  console.assert(!formatUnreadTracesForSystem());
  console.log("bot-phone self-check ok");
}

module.exports = {
  getOverview,
  openApp,
  openChat,
  updateMemo,
  listUnreadTraces,
  formatUnreadTracesForSystem,
  markTracesSeen,
  resetForTests,
};
