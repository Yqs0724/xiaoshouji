/**
 * 反查：用户翻看「家机的手机」虚拟壳 + 留痕，供下次开口时注入。
 * 种子按人设裁剪：丧母/丧父不出现父母会话；已 seed 的冲突剧本会升 ver 重刷。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DATA_PATH = path.join(__dirname, "..", "data", "bot-phone.json");
const SEED_VER = 2;

function emptyStore() {
  return {
    version: 1,
    seed_ver: 0,
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
      seed_ver: Number(raw.seed_ver) || 0,
    });
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
}

function familyFlags(persona) {
  const t = String(persona || "");
  return {
    motherDead:
      /丧母|母亲.{0,16}(去世|亡|离世|死了|过世)|父母双亡|双亡|没了妈|没有母亲/.test(
        t
      ),
    fatherDead:
      /丧父|父亲.{0,16}(去世|亡|离世|死了|过世)|父母双亡|双亡|继承.{0,40}遗产|父亲去世/.test(
        t
      ),
  };
}

function hasDeadParentClash(store, persona) {
  const f = familyFlags(persona);
  for (const c of store.chats || []) {
    const title = String((c && c.title) || "");
    if (f.motherDead && /妈妈|母亲|老妈|妈咪/.test(title)) return true;
    if (f.fatherDead && /爸爸|父亲|老爸/.test(title)) return true;
  }
  return false;
}

function ago(ms) {
  return Date.now() - ms;
}

function defaultMemos() {
  return [
    {
      id: "m1",
      title: "备忘",
      body: "周末带点薄荷巧克力。别忘了。",
      ts: ago(86400000 * 2),
    },
    {
      id: "m2",
      title: "密码备忘（勿给别人看）",
      body: "相册试了试 2580……好像不对。算了。",
      ts: ago(86400000 * 5),
    },
  ];
}

function defaultShop(userName) {
  const you = String(userName || "她").trim().slice(0, 12) || "她";
  return [
    {
      id: "s1",
      title: "薄荷巧克力礼盒",
      shop: "本地店",
      amount: "¥68.00",
      status: "已签收",
      note: "给" + you + "垫胃",
      ts: ago(500000000),
    },
    {
      id: "s2",
      title: "降噪耳机",
      shop: "某宝旗舰",
      amount: "¥899.00",
      status: "运输中",
      note: "加班用",
      ts: ago(200000000),
    },
  ];
}

/** 按人设拼通讯录：死人不能出现；默认搭档 + 工作 + 健身友 */
function buildPersonaChats(userName, persona) {
  const you = String(userName || "叶清时").trim().slice(0, 16) || "她";
  const f = familyFlags(persona);
  const chats = [
    {
      id: "c-partner",
      title: you,
      kind: "dm",
      preview: "到家抱你",
      messages: [
        {
          id: "p1",
          from: "me",
          text: "会议又拖了，还有二十来分钟。",
          ts: ago(2400000),
        },
        {
          id: "p2",
          from: "them",
          text: "别硬扛，先垫点东西。我在家等你。",
          ts: ago(2100000),
        },
        {
          id: "p3",
          from: "me",
          text: "好，到家抱你。",
          ts: ago(1800000),
        },
      ],
    },
    {
      id: "c-work",
      title: "助理·周予",
      kind: "dm",
      preview: "那份材料我放桌上了",
      messages: [
        {
          id: "b1",
          from: "them",
          text: "今晚聚餐去吗？客户那边问了。",
          ts: ago(7200000),
        },
        {
          id: "b2",
          from: "me",
          text: "不去了，有约。材料你先摆我桌上。",
          ts: ago(7000000),
        },
        {
          id: "b3",
          from: "them",
          text: "那份材料我放桌上了",
          ts: ago(6800000),
        },
      ],
    },
  ];
  if (!f.motherDead) {
    chats.push({
      id: "c-mom",
      title: "妈妈",
      kind: "dm",
      preview: "记得吃饭",
      messages: [
        { id: "a1", from: "them", text: "在忙吗？", ts: ago(86400000) },
        { id: "a2", from: "me", text: "嗯，有点。", ts: ago(86000000) },
        { id: "a3", from: "them", text: "记得吃饭", ts: ago(85000000) },
      ],
    });
  }
  if (!f.fatherDead) {
    chats.push({
      id: "c-dad",
      title: "爸爸",
      kind: "dm",
      preview: "周末回家一趟",
      messages: [
        {
          id: "d1",
          from: "them",
          text: "公司还顺吗。",
          ts: ago(172800000),
        },
        { id: "d2", from: "me", text: "还行。", ts: ago(172000000) },
        {
          id: "d3",
          from: "them",
          text: "有空周末回家一趟。",
          ts: ago(170000000),
        },
      ],
    });
  }
  if (chats.length < 3) {
    chats.push({
      id: "c-gym",
      title: "健身·老陈",
      kind: "dm",
      preview: "明早见",
      messages: [
        {
          id: "g1",
          from: "them",
          text: "明天深蹲日，来不来？",
          ts: ago(36000000),
        },
        {
          id: "g2",
          from: "me",
          text: "来。别排太满，我还得赶早会。",
          ts: ago(35000000),
        },
        { id: "g3", from: "them", text: "行，明早见。", ts: ago(34000000) },
      ],
    });
  }
  return chats;
}

function seedIfNeeded(store, botName, opts) {
  const name = String(botName || "沈言之").trim().slice(0, 16) || "沈言之";
  const userName =
    String((opts && opts.userName) || "").trim().slice(0, 16) || "叶清时";
  const persona = String((opts && opts.persona) || "");
  const need =
    !store.seeded ||
    store.seed_ver !== SEED_VER ||
    hasDeadParentClash(store, persona);
  if (!need) {
    store.owner_name = name;
    return store;
  }
  store.seeded = true;
  store.seed_ver = SEED_VER;
  store.owner_name = name;
  store.chats = buildPersonaChats(userName, persona);
  store.shop = defaultShop(userName);
  if (!Array.isArray(store.memos) || !store.memos.length) {
    store.memos = defaultMemos();
  }
  return store;
}

function ensureStore(botName, opts) {
  const store = seedIfNeeded(readStore(), botName, opts);
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

function getOverview(botName, opts) {
  const store = ensureStore(botName, opts);
  return {
    ok: true,
    owner_name: store.owner_name || botName || "沈言之",
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

function openApp(appId, botName, opts) {
  const store = ensureStore(botName, opts);
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
    return { ok: true, app: "wechat", chats: getOverview(botName, opts).chats };
  }
  if (id === "memo") {
    return { ok: true, app: "memo", memos: getOverview(botName, opts).memos };
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

function openChat(chatId, botName, opts) {
  const store = ensureStore(botName, opts);
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

function updateMemo(memoId, body, botName, opts) {
  const store = ensureStore(botName, opts);
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
  const deadPersona =
    "成长背景:七岁丧母。故事节点：你的父亲去世当晚，你继承遗产。";
  const ov = getOverview("沈言之", {
    userName: "叶清时",
    persona: deadPersona,
  });
  console.assert(
    !ov.chats.some((c) => /妈妈|爸爸/.test(c.title)),
    "no dead parents"
  );
  console.assert(
    ov.chats.some((c) => c.title === "叶清时"),
    "partner chat"
  );
  openApp("wechat", "沈言之", { userName: "叶清时", persona: deadPersona });
  openChat(ov.chats[0].id, "沈言之", {
    userName: "叶清时",
    persona: deadPersona,
  });
  const alive = buildPersonaChats("小美", "普通家庭，父母都在。");
  console.assert(
    alive.some((c) => c.title === "妈妈"),
    "mom when alive"
  );
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
  familyFlags,
  buildPersonaChats,
};
