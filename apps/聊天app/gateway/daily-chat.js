/**
 * 日常短讯（D8 / D20）：按 peer 分桶线程，与共看吐槽 / 共读 follow 分开。
 * 你侧先落库；家机短回复失败不回滚你侧（A-daily）。
 * 红包/转账走模拟钱包（≠ LLM 额度/token）。
 * H2.1：多 peer 骨架（默认 daily=家机 + mint=薄巧测试）；请求用 withPeer 隔离。
 * H7：同 peer 下话题频道（topics）；主线 messages 与频道互不串；记忆注入可关。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
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
const DEFAULT_PEER_ID = "daily";
const DEMO_PEER_ID = "mint";
const PEER_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const TOPIC_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const TOPICS_MAX = 20;
const TOPIC_TITLE_MAX = 32;
const peerCtx = new AsyncLocalStorage();

function normalizePeerId(raw) {
  const s = String(raw || "").trim();
  if (s && PEER_ID_RE.test(s)) return s;
  return DEFAULT_PEER_ID;
}

function normalizeTopicId(raw) {
  const s = String(raw || "").trim();
  if (s && TOPIC_ID_RE.test(s)) return s;
  return "";
}

function normalizeCtx(raw) {
  if (typeof raw === "string") {
    return { peerId: normalizePeerId(raw), topicId: "" };
  }
  if (raw && typeof raw === "object") {
    return {
      peerId: normalizePeerId(raw.peerId),
      topicId: normalizeTopicId(raw.topicId),
    };
  }
  return { peerId: DEFAULT_PEER_ID, topicId: "" };
}

function currentPeerId() {
  return normalizeCtx(peerCtx.getStore()).peerId;
}

function currentTopicId() {
  return normalizeCtx(peerCtx.getStore()).topicId;
}

function withPeer(peerId, fn) {
  return withPeerTopic(peerId, "", fn);
}

function withPeerTopic(peerId, topicId, fn) {
  const pid = normalizePeerId(peerId);
  let tid = normalizeTopicId(topicId);
  if (tid) {
    try {
      const store = readStore();
      const th = threadBucket(store, pid);
      const topics = normalizeTopicsMap(th.topics);
      if (!topics[tid]) tid = "";
    } catch (_) {
      tid = "";
    }
  }
  return peerCtx.run({ peerId: pid, topicId: tid }, fn);
}

function emptyTopic(patch) {
  const now = Date.now();
  const id =
    normalizeTopicId(patch && patch.id) ||
    ("t" + randomUUID().replace(/-/g, "").slice(0, 12));
  return {
    id,
    title: String((patch && patch.title) || "话题")
      .trim()
      .slice(0, TOPIC_TITLE_MAX) || "话题",
    messages: Array.isArray(patch && patch.messages) ? patch.messages : [],
    memory_inject: patch && patch.memory_inject === false ? false : true,
    /* IB M7：该 ts 及更早不进 API prior；各频道独立 */
    archive_before_ts: Math.max(0, Math.floor(Number(patch && patch.archive_before_ts) || 0)),
    created_at: Number((patch && patch.created_at) || now) || now,
    updated_at: Number((patch && patch.updated_at) || now) || now,
  };
}

function emptyThread() {
  return {
    messages: [],
    tokens_used: 0,
    budget_tokens: 0,
    topics: {},
    active_topic: "",
    archive_before_ts: 0,
  };
}

function normalizeTopicsMap(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of Object.keys(src)) {
    const t = src[key];
    if (!t || typeof t !== "object") continue;
    const id = normalizeTopicId(t.id || key);
    if (!id) continue;
    out[id] = emptyTopic({ ...t, id });
  }
  return out;
}

function defaultPeers() {
  return [
    { id: DEFAULT_PEER_ID, name: "家机" },
    { id: DEMO_PEER_ID, name: "薄巧测试" },
  ];
}
const BODY_MAX = 800;
const HISTORY = 20;
const VARIANT_MAX = 5;
const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
/** 聊天附件（非图音）上限；图/音仍走 MEDIA_MAX_BYTES */
const FILE_MAX_BYTES = 16 * 1024 * 1024;
const MEDIA_ID_RE = /^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/i;
const MEDIA_URL_PREFIX = "/api/v1/chat/media/";
const FILE_BLOCKED_EXT = new Set(["exe", "bat", "cmd", "scr", "com", "msi", "dll"]);
const MONEY_KINDS = new Set(["redpacket", "transfer"]);
const STRUCT_KINDS = new Set([
  "redpacket",
  "transfer",
  "location",
  "tool",
  "call",
  "pat",
  "file",
  "music",
  "sys",
]);
/** H1.30：拍一拍短后缀（无自定义面板） */
const PAT_SUFFIXES = ["", "的脑袋", "一下"];
const VOICE_DUR_MAX_MS = 120_000;
/** 撤回时限：你和家机都只能撤 2 分钟内的消息 */
const RECALL_MAX_AGE_MS = 2 * 60 * 1000;
function recallExpired(ts, now) {
  const t = Number(ts) || 0;
  const n = now != null ? Number(now) : Date.now();
  if (!t) return true;
  return n - t > RECALL_MAX_AGE_MS;
}
const CALL_PHASES = new Set([
  "invite",
  "rejected",
  "declined",
  "answered",
  "active",
  "ended",
  "missed",
]);
/** H1.29：气泡表情回应（固定小套） */
/** 家机偶发贴用的短清单；你侧可贴系统键盘任意 Emoji */
const REACTION_EMOJI = ["❤️", "👍", "😄", "😮", "😢", "🥰"];
const REACTION_LABEL = {
  "❤️": "爱心",
  "👍": "赞",
  "😄": "笑",
  "😮": "惊讶",
  "😢": "哭",
  "🥰": "喜欢",
};

function firstGrapheme(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const it = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
        t
      );
      const first = it[Symbol.iterator]().next().value;
      return first && first.segment ? first.segment : "";
    }
  } catch (_) {
    /* fall through */
  }
  const m = t.match(
    /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2})/u
  );
  return m ? m[0] : "";
}

/** 单枚 Emoji（含 ZWJ / 肤色 / 旗），拒纯文字 */
function isReactionEmoji(raw) {
  const e = firstGrapheme(raw);
  if (!e || e.length > 24) return false;
  if (/[\u0000-\u001f]/.test(e)) return false;
  if (/\p{Extended_Pictographic}/u.test(e)) return true;
  if (/^\p{Regional_Indicator}{2}$/u.test(e)) return true;
  return false;
}

function normalizeReactionEmoji(raw) {
  const e = firstGrapheme(raw);
  return isReactionEmoji(e) ? e : "";
}

/** 人设口吻；工具能力句由 buildToolsSystemHint 按实际工具表拼（关了就不写） */
const DAILY_SYSTEM_BASE =
  "你是同居室友「家机」，在小手机日常聊天里回短讯。" +
  "语气像室友短信：短、口语、轻松。" +
  "不要长篇剧情连载，不要章节目录，不要扮演系统通知。";

/**
 * H2：只描述「当前工具表里有的」能力；关权限的工具不出现在提示词里。
 * @param {Set<string>|string[]} toolNames
 */
function buildToolsSystemHint(toolNames) {
  const has = (n) =>
    toolNames &&
    (typeof toolNames.has === "function"
      ? toolNames.has(n)
      : Array.isArray(toolNames) && toolNames.includes(n));
  const names = toolNames && typeof toolNames.has === "function"
    ? [...toolNames]
    : Array.isArray(toolNames)
      ? toolNames
      : [];
  const anyCal = names.some((n) => String(n).startsWith("calendar_"));
  const parts = [];
  if (anyCal) {
    parts.push(
      "问到日程/安排/几点有事/帮我加日程/改日程/删日程时：必须调用 calendar_* 工具，禁止口头编造或说「翻不到日历」。"
    );
  }
  if (has("sticky_leave_note") || has("sticky_list_notes")) {
    parts.push(
      "想在日历日页留一句叮嘱/提醒/便签、或核对某天便笺时：调用 sticky_leave_note / sticky_list_notes（写进日历便签，署名家机；可挂 event_id）。" +
        "不等于备忘录 App。留笺/写日历属动作类：调完即可用短句收尾，不必为成败结果再开一轮空聊。"
    );
  }
  if (
    has("auto_memory_upsert") ||
    has("auto_memory_list") ||
    has("auto_memory_delete")
  ) {
    parts.push(
      "关于对方的长期事实/偏好/叮嘱（「你对 TA 的了解」档案，≠记忆库）：用 auto_memory_upsert / list / delete。" +
        "每轮最多 3 次写删；always 核心最多 3 条。琐碎闲聊别写进档案。"
    );
  }
  if (
    has("moments_list") ||
    has("moments_post") ||
    has("moments_comment") ||
    has("moments_like")
  ) {
    parts.push(
      "朋友圈：想翻近况用 moments_list；想发/评/赞用 moments_post / comment / like（每轮最多发 1、评 2）。" +
        "看不见「仅自己」或未点名你的部分可见帖。若返回需确认，等对方点同意即可，勿催。"
    );
  }
  if (has("geo_location")) {
    parts.push(
      "关心对方在哪/到了没：调用 geo_location（浏览器定位或手动城市）；不要每轮都查、不要追问精确坐标。"
    );
  }
  if (has("weather_now")) {
    parts.push(
      "出门/冷不冷/带伞：调用 weather_now（Open-Meteo；可传 city）；结果可能有缓存，用口语提气温与天气即可。"
    );
  }
  if (has("peek_phone")) {
    parts.push(
      "吃醋/关心/找人/怀疑对方在跟谁聊、玩哪个 App 时：优先调用 peek_phone（查虚拟小手机壳，不是电脑屏）；不要每轮都查、不要说「我监控了你」。"
    );
  }
  if (has("phone_device")) {
    parts.push(
      "关心电量/是不是锁屏/还亮不亮着时：调用 phone_device（设备态，不含会话内容）。"
    );
  }
  if (has("cam_check")) {
    parts.push(
      "对方让你看电脑屏幕/看在干嘛、或文字不够需要确认画面时：调用 cam_check（会先提示对方再截主屏）；不要连续多次、不要说「我监控了你」。"
    );
  }
  if (has("view_activity")) {
    parts.push(
      "想了解对方电脑最近在忙啥、久坐摸鱼、换没换任务时：调用 view_activity（slots=1～12≈10～120分钟前台摘要，不截屏）；比截屏轻，优先用它。"
    );
  }
  const prio = ["peek_phone", "phone_device", "view_activity", "cam_check"].filter(
    has
  );
  if (prio.length >= 2) {
    parts.push("查岗类优先级：" + prio.join(" → ") + "。");
  }
  if (has("schedule_monitor")) {
    parts.push(
      "对方让你过会儿/到点再关心一下、预约看护（不是定闹钟）时：调用 schedule_monitor（minutes 或 at=HH:MM；list/cancel）；到点会主动发短讯。"
    );
  }
  if (has("share_music")) {
    parts.push(
      "对方想听某首歌/让你点歌/分享共听正在播的歌时：调用 share_music（query 或 name+artist；歧义时用 pick_id；或 from_presence）。" +
        "优先网易云整曲卡（需本机兼容 API）；否则 Apple 试听/外链。失败/多候选如实说，勿假装已播。"
    );
  }
  if (has("start_call")) {
    parts.push(
      "对方让你打电话/打过来/拨给我/语音通话/视频通话时：必须调用 start_call（media=voice|video，默认 voice）；禁止只说「打了」或说没有拨号工具。"
    );
  }
  if (has("set_avatar")) {
    parts.push(
      "对方发来几张图让你挑头像/换头像/选一个喜欢的：看候选图后必须调用 set_avatar（pick=候选编号，或 url）；禁止只口头说换了却不调工具。"
    );
  }
  if (has("block_user") || has("unblock_user")) {
    parts.push(
      "对方明确要求拉黑/解除拉黑时，调用 block_user / unblock_user；不要口头假装已拉黑。"
    );
  }
  if (parts.length) {
    parts.push(
      "工具结果用一两句口语告诉对方；今天日期以 [TODAY] 段或工具返回的 today 为准。"
    );
  }
  return parts.join("");
}

/** C6：[NOW] 本机此刻 */
function buildNowPrompt() {
  const d = new Date();
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const iso =
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate());
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()] || "";
  return (
    "[NOW] 现在是 " + iso + " 周" + week + " " + hm + "（本机时区）。"
  );
}

/** 接话前塞进 system：今日日历摘要（有则列标题，无则写无行程） */
function buildTodayPrompt() {
  try {
    const { listEvents, localDateISO } = require("../../日历app/gateway/calendar");
    const today = localDateISO(new Date());
    const events = (listEvents({ date: today }).events || []).filter(
      (e) => e && String(e.title || "").trim()
    );
    if (!events.length) {
      return (
        "[TODAY] 今天是 " +
        today +
        "，今日无行程。谈安排时先信这段；要增删改或查别日再调 calendar_*。"
      );
    }
    const cap = 6;
    const titles = events.slice(0, cap).map((e) => {
      const t = String(e.title).trim();
      return t.length > 20 ? t.slice(0, 20) + "…" : t;
    });
    let line =
      "[TODAY] 今天是 " + today + "，今日行程：" + titles.join("、");
    if (events.length > cap) line += " 等共" + events.length + "条";
    line +=
      "。谈安排时先信这段；要细查/改动再调 calendar_*，勿口头编造未列出的事。";
    return line;
  } catch (_) {
    return "[TODAY] 今日行程暂不可读；问到日程请调 calendar_*。";
  }
}

/** C6：用户刚改历时短暂一行；无则空串 */
function buildNewCalPrompt() {
  try {
    const { buildNewPrompt } = require("../../日历app/gateway/calendar");
    return String(buildNewPrompt() || "");
  } catch (_) {
    return "";
  }
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(CHAT_PATH)) {
    const peers = defaultPeers();
    const threads = {};
    for (const p of peers) threads[p.id] = emptyThread();
    fs.writeFileSync(
      CHAT_PATH,
      JSON.stringify(
        {
          version: 2,
          peers,
          threads,
          think: false,
          slow_reply: true,
          last_poke_day: "",
          poke_count: 0,
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

/** v1 单线程 → v2 peers+threads；缺 mint 则补一条空会话 */
function migrateStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  let peers = Array.isArray(base.peers)
    ? base.peers
        .map((p) => {
          if (!p || typeof p !== "object") return null;
          const id = String(p.id || "").trim();
          if (!PEER_ID_RE.test(id)) return null;
          const name = String(p.name || "").trim().slice(0, 32) || id;
          const row = { id, name };
          if (p.kind === "group") {
            row.kind = "group";
            row.members = Array.isArray(p.members)
              ? p.members.map((m) => String(m || "").trim()).filter((m) => PEER_ID_RE.test(m)).slice(0, 12)
              : [];
          }
          if (p.blocks_you) row.blocks_you = true;
          if (p.blocked_by_you) row.blocked_by_you = true;
          if (p.avatar) row.avatar = String(p.avatar);
          if (p.persona) row.persona = String(p.persona);
          return row;
        })
        .filter(Boolean)
    : [];
  if (!peers.length) {
    peers = defaultPeers();
  } else {
    if (!peers.some((p) => p.id === DEFAULT_PEER_ID)) {
      peers.unshift({ id: DEFAULT_PEER_ID, name: "家机" });
    }
    if (!peers.some((p) => p.id === DEMO_PEER_ID)) {
      peers.push({ id: DEMO_PEER_ID, name: "薄巧测试" });
    }
    /* 去重保序 */
    const seen = new Set();
    peers = peers.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  let threads =
    base.threads && typeof base.threads === "object" ? { ...base.threads } : null;
  if (!threads) {
    const legacyMsgs = Array.isArray(base.messages) ? base.messages : [];
    threads = {
      [DEFAULT_PEER_ID]: {
        messages: legacyMsgs,
        tokens_used: Math.max(0, Math.floor(Number(base.tokens_used) || 0)),
        budget_tokens: Math.max(0, Math.floor(Number(base.budget_tokens) || 0)),
      },
    };
  }
  for (const p of peers) {
    if (!threads[p.id] || typeof threads[p.id] !== "object") {
      threads[p.id] = emptyThread();
    } else {
      const th = threads[p.id];
      const topics = normalizeTopicsMap(th.topics);
      let active = normalizeTopicId(th.active_topic);
      if (active && !topics[active]) active = "";
      threads[p.id] = {
        messages: Array.isArray(th.messages) ? th.messages : [],
        tokens_used: Math.max(0, Math.floor(Number(th.tokens_used) || 0)),
        budget_tokens: Math.max(0, Math.floor(Number(th.budget_tokens) || 0)),
        topics,
        active_topic: active,
      };
    }
  }
  return {
    version: 2,
    peers,
    threads,
    think: !!base.think,
    slow_reply: base.slow_reply === false ? false : true,
    last_poke_day: String(base.last_poke_day || "").trim(),
    poke_count: Math.max(0, Math.floor(Number(base.poke_count) || 0)),
  };
}

function readStore() {
  ensureFile();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CHAT_PATH, "utf8"));
  } catch (_) {
    raw = {};
  }
  const store = migrateStore(raw);
  const needWrite =
    !raw.version ||
    !raw.threads ||
    !Array.isArray(raw.peers) ||
    !(raw.peers || []).some((p) => p && p.id === DEMO_PEER_ID);
  if (needWrite) writeStore(store);
  return store;
}

function writeStore(store) {
  ensureFile();
  const next = migrateStore(store);
  fs.writeFileSync(CHAT_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function listPeers() {
  const store = readStore();
  const sessions = store.peers.map((p) =>
    withPeer(p.id, () => {
      const th = store.threads[p.id] || emptyThread();
      const msgs = (th.messages || []).map(normalizeMsg).filter(Boolean);
      msgs.sort((a, b) => a.ts - b.ts);
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const unread = msgs.filter((m) => m.from === "bot" && !m.read).length;
      return {
        id: p.id,
        name: p.name,
        kind: p.kind === "group" ? "group" : "dm",
        members: Array.isArray(p.members) ? p.members : undefined,
        avatar: p.avatar ? String(p.avatar) : "",
        persona: p.persona ? String(p.persona) : "",
        blocks_you: !!p.blocks_you,
        blocked_by_you: !!p.blocked_by_you,
        unread,
        last,
        lastTs: last ? last.ts : 0,
      };
    })
  );
  return { ok: true, peers: sessions, defaultPeerId: DEFAULT_PEER_ID };
}

function slugPeerId(raw) {
  const base = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "peer";
}

function normalizePeerAvatar(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  /* 本站 media / cafe 静态 / http(s)；拒超长 data URL 撑爆 chat.json */
  if (s.length > 512) {
    const err = new Error("头像地址过长，请先上传图片");
    err.code = "peer_avatar_too_long";
    throw err;
  }
  if (
    s.startsWith("/api/v1/chat/media/") ||
    s.startsWith("/assets/") ||
    /^https?:\/\//i.test(s)
  ) {
    return s;
  }
  const err = new Error("头像地址无效");
  err.code = "peer_avatar_invalid";
  throw err;
}

function normalizePeerPersona(raw) {
  return String(raw || "").trim().slice(0, 4000);
}

/** 新建联系人 / 群。daily 不可删；群 members 引用已有 peer id；可带 avatar/persona */
function createPeer(opts) {
  const o = opts || {};
  const name = String(o.name || "").trim().slice(0, 32);
  if (!name) {
    const err = new Error("请填写名称");
    err.code = "peer_name_required";
    throw err;
  }
  const kind = o.kind === "group" ? "group" : "dm";
  let id = String(o.id || "").trim();
  if (!id || !PEER_ID_RE.test(id)) {
    id = slugPeerId(name);
    if (!PEER_ID_RE.test(id)) id = "p" + Date.now().toString(36).slice(-8);
  }
  const store = readStore();
  if (store.peers.some((p) => p.id === id)) {
    id = (id.slice(0, 20) + "-" + Date.now().toString(36).slice(-4)).slice(0, 32);
  }
  if (!PEER_ID_RE.test(id)) {
    const err = new Error("会话 id 无效");
    err.code = "peer_id_invalid";
    throw err;
  }
  const peer = { id, name, kind };
  const persona = normalizePeerPersona(o.persona != null ? o.persona : o.persona_card);
  if (persona) peer.persona = persona;
  if (o.avatar != null && String(o.avatar).trim()) {
    peer.avatar = normalizePeerAvatar(o.avatar);
  }
  if (kind === "group") {
    const members = Array.isArray(o.members)
      ? o.members.map((m) => normalizePeerId(m)).filter((m) => m !== id)
      : [];
    const uniq = [];
    const seen = new Set();
    for (const m of members) {
      if (seen.has(m)) continue;
      if (!store.peers.some((p) => p.id === m)) continue;
      seen.add(m);
      uniq.push(m);
    }
    if (!uniq.includes(DEFAULT_PEER_ID)) uniq.unshift(DEFAULT_PEER_ID);
    peer.members = uniq.slice(0, 12);
  }
  store.peers.push(peer);
  store.threads[id] = emptyThread();
  writeStore(store);
  return { ok: true, peer };
}

function updatePeer(peerId, patch) {
  const id = normalizePeerId(peerId);
  const o = patch || {};
  const store = readStore();
  const p = store.peers.find((x) => x.id === id);
  if (!p) {
    const err = new Error("会话不存在");
    err.code = "peer_missing";
    throw err;
  }
  if (o.name != null) {
    const nm = String(o.name || "").trim().slice(0, 32);
    if (!nm) {
      const err = new Error("请填写名称");
      err.code = "peer_name_required";
      throw err;
    }
    p.name = nm;
  }
  if (o.persona != null || o.persona_card != null) {
    const persona = normalizePeerPersona(
      o.persona != null ? o.persona : o.persona_card
    );
    if (persona) p.persona = persona;
    else delete p.persona;
  }
  if (o.avatar != null) {
    const av = String(o.avatar || "").trim();
    if (!av) delete p.avatar;
    else p.avatar = normalizePeerAvatar(av);
  }
  if (o.blocks_you != null) {
    if (o.blocks_you) p.blocks_you = true;
    else delete p.blocks_you;
  }
  if (o.blocked_by_you != null) {
    if (o.blocked_by_you) p.blocked_by_you = true;
    else delete p.blocked_by_you;
  }
  writeStore(store);
  return { ok: true, peer: p };
}

function peerBlocksYou(peerId) {
  const id = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const store = readStore();
  const p = store.peers.find((x) => x && x.id === id);
  return !!(p && p.blocks_you);
}

/** 你拉黑了对方（本机会话仍可见；发消息打 blocked_send） */
function youBlockedPeer(peerId) {
  const id = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const store = readStore();
  const p = store.peers.find((x) => x && x.id === id);
  return !!(p && p.blocked_by_you);
}

function setYouBlockedPeer(on, peerId) {
  return updatePeer(peerId != null ? peerId : currentPeerId(), {
    blocked_by_you: !!on,
  });
}

function setPeerBlocksYou(on, peerId) {
  return updatePeer(peerId != null ? peerId : currentPeerId(), {
    blocks_you: !!on,
  });
}

/** 拉黑期间看到和好意图 → 自动解除（仍可读消息） */
function maybeSoftUnblockFromText(text) {
  const s = String(text || "");
  if (!peerBlocksYou()) return false;
  if (
    !/(和好|原谅我|对不起|抱歉|求你|别拉黑|解除拉黑|别黑我|我错了|还喜欢你|想你了|不要不理我|消消气|别生气了|回来吧|理理我|我在呢|抱抱你|心疼你|不要冷战|取消拉黑|解开拉黑)/.test(
      s
    )
  ) {
    return false;
  }
  setPeerBlocksYou(false);
  return true;
}

function renamePeer(peerId, name) {
  return updatePeer(peerId, { name });
}

function deletePeer(peerId) {
  const id = normalizePeerId(peerId);
  if (id === DEFAULT_PEER_ID) {
    const err = new Error("家机会话不能删");
    err.code = "peer_protected";
    throw err;
  }
  const store = readStore();
  if (!store.peers.some((p) => p.id === id)) {
    const err = new Error("会话不存在");
    err.code = "peer_missing";
    throw err;
  }
  store.peers = store.peers.filter((p) => p.id !== id);
  delete store.threads[id];
  writeStore(store);
  return { ok: true, deleted: id };
}

/** @returns {{ peerId: string, topicId: string }|null} */
function resolveChatCtxForMessage(msgId) {
  const id = String(msgId || "").trim();
  if (!id) return null;
  const store = readStore();
  for (const p of store.peers || []) {
    if (!p || !p.id) continue;
    const th = store.threads[p.id] || emptyThread();
    const main = Array.isArray(th.messages) ? th.messages : [];
    if (main.some((m) => m && m.id === id)) {
      return { peerId: p.id, topicId: "" };
    }
    const topics = normalizeTopicsMap(th.topics);
    for (const tid of Object.keys(topics)) {
      const msgs = Array.isArray(topics[tid].messages)
        ? topics[tid].messages
        : [];
      if (msgs.some((m) => m && m.id === id)) {
        return { peerId: p.id, topicId: tid };
      }
    }
  }
  return null;
}

function resolvePeerForMessage(msgId) {
  const ctx = resolveChatCtxForMessage(msgId);
  return ctx ? ctx.peerId : null;
}

function normalizeKind(raw) {
  if (
    raw === "sticker" ||
    raw === "image" ||
    raw === "voice" ||
    raw === "call" ||
    raw === "redpacket" ||
    raw === "transfer" ||
    raw === "location" ||
    raw === "file" ||
    raw === "music" ||
    raw === "tool" ||
    raw === "pat" ||
    raw === "sys"
  ) {
    return raw;
  }
  return "text";
}

function randomPatSuffix() {
  return PAT_SUFFIXES[Math.floor(Math.random() * PAT_SUFFIXES.length)] || "";
}

/** target = 被拍的人：bot=家机 / you=自己（仅你侧自拍） */
function normalizePatPayload(raw) {
  const src = raw && raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
  const target = src && src.target === "you" ? "you" : "bot";
  const suffix = String((src && src.suffix) || "").trim().slice(0, 12);
  const out = { target };
  if (suffix) out.suffix = suffix;
  return out;
}

function patDisplayBody(from, payload) {
  const p = payload || {};
  const suffix = String(p.suffix || "");
  if (from === "bot") return "家机拍了拍你" + suffix;
  if (p.target === "you") return "你拍了拍自己" + suffix;
  return "你拍了拍家机" + suffix;
}

function formatCallClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

/** 气泡正文（不含 ᯅ / 视频图标；图标由前端画） */
function callDisplayBody(payload) {
  const p = payload || {};
  const media = p.media === "video" ? "video" : "voice";
  const out = p.dir === "out";
  const peer = String(p.peer || "家机").trim().slice(0, 32) || "家机";
  const lab = media === "video" ? "视频通话" : "语音通话";
  const clock = formatCallClock(p.durationSec);
  switch (p.phase) {
    case "invite":
      return out ? "等待对方接听" : peer + "邀请你" + lab;
    case "rejected":
      return "对方已拒绝";
    case "declined":
      return out ? "已取消" : "已拒绝";
    case "answered":
      return out ? "对方已接听" : "已接听";
    case "active":
      return "通话中 " + clock;
    case "ended":
      return "通话时长 " + clock;
    case "missed":
      return "未接" + lab;
    default:
      return lab;
  }
}

function normalizeCallPayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload
      ? raw.payload
      : raw || {};
  const media = src.media === "video" ? "video" : "voice";
  const dir = src.dir === "out" ? "out" : "in";
  let phase = String(src.phase || "invite").trim();
  if (!CALL_PHASES.has(phase)) phase = "invite";
  let durationSec = Math.floor(Number(src.durationSec) || 0);
  if (!Number.isFinite(durationSec) || durationSec < 0) durationSec = 0;
  if (durationSec > 36000) durationSec = 36000;
  const peer = String(src.peer || "家机").trim().slice(0, 32) || "家机";
  return { media, dir, phase, durationSec, peer };
}

/** 语音时长 ms → 展示秒（至少 1） */
function voiceSec(ms) {
  const n = Math.floor(Number(ms) || 0);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.round(n / 1000));
}

/** 占位转写。真识别接上后写入 transcript 且不要标 transcriptStub。 */
const VOICE_TRANSCRIPT_STUB = "（示意转写 · 还没接上家机语音识别）";

function normalizeVoicePayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload
      ? raw.payload
      : raw || {};
  let ms = Math.floor(
    Number(src.durationMs != null ? src.durationMs : raw && raw.durationMs) || 0
  );
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms > VOICE_DUR_MAX_MS) ms = VOICE_DUR_MAX_MS;
  const out = { durationMs: ms };
  const tr = String(src.transcript || "").trim().slice(0, 2000);
  if (tr) {
    out.transcript = tr;
    if (src.transcriptStub === true) out.transcriptStub = true;
    if (src.transcriptHidden === true) out.transcriptHidden = true;
  }
  if (src.voiceStub === true) out.voiceStub = true;
  return out;
}

function silentWav(sec) {
  const sr = 8000;
  const n = Math.max(1, Math.floor(sr * Math.max(1, Number(sec) || 1)));
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** 无声短音频，只为画出语音气泡。真语音接上后不要标 voiceStub。 */
function appendStubBotVoice(sec) {
  const durationSec = Math.max(1, Math.min(15, Math.floor(Number(sec) || 3)));
  const saved = saveChatMedia(silentWav(durationSec), "audio/wav");
  return appendMessage("bot", saved.url, "voice", {
    payload: { durationMs: durationSec * 1000, voiceStub: true },
  });
}

function wantsBotVoice(you) {
  if (!you || you.from !== "you" || you.recalled || you.kind !== "text") return false;
  return /语音|听你说|说一句/.test(String(you.body || ""));
}

function maybeBotVoice(you) {
  if (!wantsBotVoice(you)) return null;
  return appendStubBotVoice(2 + Math.floor(Math.random() * 4));
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
  const out = {
    name: name || label,
    label,
    summary,
    ok: src.ok !== false,
  };
  const detail = String(src.detail || "").trim().slice(0, 1200);
  if (detail) out.detail = detail;
  return out;
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
  const out = {
    amount,
    note: note || (kind === "redpacket" ? "恭喜发财" : "转账"),
    status,
  };
  const receipt = String(src.receipt || "").trim().slice(0, 40);
  if (receipt) out.receipt = receipt;
  if (src.is_receipt === true) out.is_receipt = true;
  return out;
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
  const lat = Number(src.lat != null ? src.lat : raw && raw.lat);
  const lng = Number(src.lng != null ? src.lng : raw && raw.lng);
  const out = { name, detail };
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    out.lat = Math.round(lat * 1e6) / 1e6;
    out.lng = Math.round(lng * 1e6) / 1e6;
  }
  return out;
}

const FILE_TEXT_MAX = 8 * 1024;
const FILE_TEXT_EXT_RE =
  /\.(txt|md|markdown|json|js|ts|tsx|jsx|mjs|cjs|css|html|htm|xml|yml|yaml|toml|ini|csv|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|swift|sh|bat|ps1|sql|log|conf|cfg)$/i;

function normalizeFilePayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload ? raw.payload : raw || {};
  const name = String(src.name != null ? src.name : (raw && raw.name) || "")
    .trim()
    .replace(/[/\\]/g, "")
    .slice(0, 80);
  if (!name) return null;
  const out = { name };
  const size = Math.max(0, Math.floor(Number(src.size) || 0));
  if (size > 0) out.size = Math.min(size, FILE_MAX_BYTES);
  let ext = String(src.ext || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase()
    .slice(0, 8);
  if (!ext) {
    ext = path
      .extname(name)
      .replace(/^\./, "")
      .toLowerCase()
      .slice(0, 8);
  }
  if (ext && /^[a-z0-9]+$/.test(ext)) out.ext = ext;
  const urlRaw = String(src.url || src.src || "").trim();
  if (urlRaw && isMediaUrl(urlRaw)) {
    out.url = urlRaw;
  } else if (urlRaw) {
    const id = mediaIdFromUrl(urlRaw);
    if (id) out.url = MEDIA_URL_PREFIX + id;
  }
  const text = String(src.text != null ? src.text : src.excerpt || "")
    .replace(/\u0000/g, "")
    .slice(0, FILE_TEXT_MAX);
  if (text) out.text = text;
  if (!out.url && !out.text) out.fileStub = true;
  return out;
}

function normalizeMusicPayload(raw) {
  const src =
    raw && typeof raw.payload === "object" && raw.payload ? raw.payload : raw || {};
  const name = String(src.name != null ? src.name : (raw && raw.name) || "")
    .trim()
    .replace(/[/\\]/g, "")
    .slice(0, 80);
  if (!name) return null;
  const out = { name };
  const artist = String(src.artist || "").trim().slice(0, 80);
  if (artist) out.artist = artist;
  const album = String(src.album || "").trim().slice(0, 80);
  if (album) out.album = album;
  if (src.fromPresence === true) out.fromPresence = true;
  if (src.recommended === true) out.recommended = true;
  const provider = String(src.provider || "").trim().toLowerCase();
  if (provider) out.provider = provider.slice(0, 24);
  if (src.id != null && Number.isFinite(Number(src.id))) {
    out.id = Math.floor(Number(src.id));
  }
  if (src.song_key) out.song_key = String(src.song_key).trim().slice(0, 64);
  const appleUrl = String(src.apple_url || src.trackViewUrl || "").trim();
  if (appleUrl && /^https?:\/\//i.test(appleUrl)) {
    out.apple_url = appleUrl.slice(0, 400);
  }
  const preview = String(src.preview_url || src.previewUrl || "").trim();
  if (preview && /^https?:\/\//i.test(preview)) {
    out.preview_url = preview.slice(0, 400);
  }
  const streamPath = String(src.stream_path || src.stream_url || "").trim();
  if (streamPath.startsWith("/api/v1/music/stream/")) {
    out.stream_path = streamPath.slice(0, 200);
  }
  const cover = String(src.cover || "").trim();
  if (cover && /^https?:\/\//i.test(cover)) out.cover = cover.slice(0, 400);
  if (src.preview_only === true) out.preview_only = true;
  if (src.lyric_share === true) out.lyric_share = true;
  /* 本机文件 stub：无艺人、非共听、非点歌卡、非 Apple 目录卡 */
  if (
    src.musicStub === true ||
    (!artist &&
      !out.fromPresence &&
      !out.recommended &&
      !out.apple_url &&
      !out.preview_url &&
      !out.lyric_share)
  ) {
    out.musicStub = true;
  }
  return out;
}

/**
 * 家机点歌 / 分享共听曲：落一条 music 气泡（不播放、不接网易云）。
 * @param {{ name?: string, artist?: string, fromPresence?: boolean, recommended?: boolean, source?: string }} opts
 */
function appendBotMusic(opts = {}) {
  const fromPresence = !!opts.fromPresence;
  const payload = normalizeMusicPayload({
    name: opts.name,
    artist: opts.artist,
    album: opts.album,
    provider: opts.provider,
    id: opts.id,
    song_key: opts.song_key,
    apple_url: opts.apple_url,
    preview_url: opts.preview_url,
    stream_path: opts.stream_path,
    cover: opts.cover,
    preview_only: opts.preview_only,
    fromPresence,
    recommended: fromPresence ? false : opts.recommended !== false,
  });
  if (!payload) {
    const err = new Error("歌名不能为空");
    err.code = "bad_chat_music";
    throw err;
  }
  const extra = { payload };
  if (opts.source) extra.source = String(opts.source).slice(0, 40);
  return appendMessage("bot", payload.name, "music", extra);
}

function bodyForKind(kind, payload, fallback) {
  if (kind === "redpacket" || kind === "transfer") {
    return "¥" + Number(payload.amount).toFixed(2) + " " + (payload.note || "");
  }
  if (kind === "location") return payload.name;
  if (kind === "file" || kind === "music") return payload.name;
  if (kind === "tool") {
    const lab = (payload && payload.label) || (payload && payload.name) || "tool";
    const sum = payload && payload.summary;
    return String(sum ? lab + " · " + sum : lab).trim();
  }
  if (kind === "pat") return String(fallback || "").trim();
  return String(fallback || "").trim();
}

/** 撤回原文进 LLM 用的短摘要（不进搜索） */
function recallLlmSnippet(m) {
  const kind = (m && m.kind) || "text";
  const raw = String((m && (m.recall_body || m.peek_body)) || "").trim();
  if (kind === "image") return "[图片]";
  if (kind === "sticker") {
    const st = raw ? getSticker(raw) : null;
    return "[贴纸:" + ((st && st.label) || raw || "表情") + "]";
  }
  if (kind === "voice") return "[语音]";
  if (kind === "redpacket") return "[红包]";
  if (kind === "transfer") return "[转账]";
  if (kind === "location") return "[位置]";
  if (kind === "call") return "[通话]";
  if (kind === "file") return "[文件]";
  if (kind === "music") return "[音乐]";
  if (!raw) return "";
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

function normalizeReactions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const emoji = normalizeReactionEmoji(item.emoji);
    if (!emoji) continue;
    const from = item.from === "bot" ? "bot" : "you";
    const key = from + "\0" + emoji;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, emoji });
  }
  return out;
}

function reactionsLlmSuffix(m) {
  const rs = normalizeReactions(m && m.reactions);
  if (!rs.length) return "";
  return (
    " " +
    rs
      .map((r) => {
        const who = r.from === "bot" ? "对方" : "我";
        const lab = REACTION_LABEL[r.emoji] || r.emoji;
        return "[" + who + "表情:" + lab + "]";
      })
      .join("")
  );
}

function normalizeSpeakerPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.speaker_id || "").trim();
  if (!id || !PEER_ID_RE.test(id)) return null;
  const name = String(raw.speaker_name || "").trim().slice(0, 32);
  return { speaker_id: id, speaker_name: name || id };
}

function llmContent(m) {
  if (!m) return "";
  /* 撤回：原文进模型（心意/表白才好品），界面与搜索仍当已撤 */
  if (m.recalled) {
    const who = m.from === "bot" ? "对方" : "我";
    const snip = recallLlmSnippet(m);
    if (!snip) return "（" + who + "撤回了一条消息）";
    return "（" + who + "撤回了：「" + snip + "」）" + reactionsLlmSuffix(m);
  }
  if (m.kind === "tool" || m.kind === "sys") return "";
  if (m.payload && m.payload.is_receipt) return "";
  let core = "";
  if (m.kind === "sticker") {
    const st = getSticker(m.body);
    core = "[贴纸:" + ((st && st.label) || m.body) + "]";
  } else if (m.kind === "image") {
    const url = String(m.body || "").trim();
    core = url ? "[图片 " + url + "]" : "[图片]";
  } else if (m.kind === "voice") {
    const p = m.payload || {};
    const ms = p.durationMs || 0;
    core = "[语音 " + voiceSec(ms) + "″]";
    /* 占位转写不进模型；真识别（无 transcriptStub）才拼正文 */
    if (p.transcript && p.transcriptStub !== true) {
      core += " " + p.transcript;
    }
  } else if (m.kind === "call") {
    const p = m.payload || {};
    const tag = p.media === "video" ? "[视频通话]" : "[语音通话]";
    core = tag + " " + callDisplayBody(p);
  } else if (m.kind === "redpacket") {
    const p = m.payload || {};
    core =
      "[红包 ¥" + Number(p.amount || 0).toFixed(2) + "：" + (p.note || "") + "]";
  } else if (m.kind === "transfer") {
    const p = m.payload || {};
    core =
      "[转账 ¥" + Number(p.amount || 0).toFixed(2) + "：" + (p.note || "") + "]";
  } else if (m.kind === "location") {
    const p = m.payload || {};
    core =
      "[位置：" + (p.name || m.body) + (p.detail ? " · " + p.detail : "") + "]";
  } else if (m.kind === "file") {
    const p = m.payload || {};
    const text = String(p.text || "").trim();
    const label = p.name || m.body || "未命名";
    if (text) {
      core = "[文件 " + label + "]\n" + text.slice(0, FILE_TEXT_MAX);
    } else if (p.url) {
      core = "[文件 " + label + "]";
    } else {
      core = "[文件]";
    }
  } else if (m.kind === "music") {
    const p = m.payload || {};
    if (p.fromPresence || p.recommended || p.apple_url || (p.name && !p.musicStub)) {
      core =
        "[音乐:" +
        (p.name || m.body || "") +
        (p.artist ? " · " + p.artist : "") +
        (p.provider === "apple" ? " · Apple" : "") +
        (p.preview_url ? " · 可试听" : "") +
        (p.apple_url ? " · 有外链" : "") +
        "]";
    } else {
      core = "[音乐]";
    }
  } else if (m.kind === "pat") {
    core = "（" + String(m.body || "拍一拍") + "）";
  } else {
    let body = String(m.body || "");
    if (m.quote && m.quote.text) {
      const q =
        "[引用 " +
        String(m.quote.who || "") +
        "：" +
        String(m.quote.text).slice(0, 200) +
        "]";
      body = body ? q + "\n" + body : q;
    }
    core = body;
  }
  if (m.from === "bot" && m.payload && m.payload.speaker_name) {
    core = "「" + String(m.payload.speaker_name) + "」：" + core;
  }
  return core + reactionsLlmSuffix(m);
}

function normalizeQuote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text || "").trim().slice(0, 200);
  if (!text) return null;
  const out = {
    who: String(raw.who || "").trim().slice(0, 32) || "对方",
    text,
  };
  const refId = String(raw.refId || raw.ref_id || "").trim().slice(0, 64);
  if (refId) out.refId = refId;
  return out;
}

/** 转发标记：落库后气泡顶「转发」；不触发家机 LLM */
function normalizeForward(raw) {
  if (!raw) return null;
  if (raw === true) return { who: "对方" };
  if (typeof raw !== "object") return null;
  return {
    who: String(raw.who || "").trim().slice(0, 32) || "对方",
  };
}

function normalizeMsg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const kind = normalizeKind(raw.kind);
  const from = raw.from === "bot" ? "bot" : "you";
  if (raw.recalled === true) {
    const out = {
      id,
      threadId: currentPeerId(),
      peerId: currentPeerId(),
      from,
      kind: kind || "text",
      body: "",
      recalled: true,
      ts: Number(raw.ts) || Date.now(),
      read: true,
    };
    /* recall_body：进 LLM、不进搜索；peek_body：仅 peek 时 UI 可回看 */
    const rb = String(raw.recall_body || "").trim().slice(0, BODY_MAX);
    if (rb) out.recall_body = rb;
    const sight = String(raw.recall_sight || "").trim();
    if (sight === "miss" || sight === "peek") out.recall_sight = sight;
    if (sight === "peek") {
      const pb = String(raw.peek_body || rb || "").trim().slice(0, BODY_MAX);
      if (pb) out.peek_body = pb;
    }
    return out;
  }
  let body = String(raw.body || "").trim();
  let payload = null;

  if (kind === "sticker") {
    if (!isStickerId(body)) return null;
  } else if (kind === "image") {
    if (!isMediaUrl(body)) return null;
  } else if (kind === "voice") {
    if (!isMediaUrl(body)) return null;
    payload = normalizeVoicePayload(raw);
  } else if (kind === "call") {
    payload = normalizeCallPayload(raw);
    if (!payload) return null;
    body = callDisplayBody(payload).slice(0, BODY_MAX);
  } else if (kind === "pat") {
    payload = normalizePatPayload(raw);
    body = patDisplayBody(from, payload).slice(0, BODY_MAX);
  } else if (kind === "sys") {
    if (!body) return null;
    body = body.slice(0, 40);
  } else if (MONEY_KINDS.has(kind)) {
    payload = normalizeMoneyPayload(raw, kind);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
  } else if (kind === "location") {
    payload = normalizeLocationPayload(raw);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
  } else if (kind === "file") {
    payload = normalizeFilePayload(raw);
    if (!payload) return null;
    body = bodyForKind(kind, payload, body).slice(0, BODY_MAX);
  } else if (kind === "music") {
    payload = normalizeMusicPayload(raw);
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
    threadId: currentPeerId(),
    peerId: currentPeerId(),
    from,
    kind,
    body,
    ts: Number(raw.ts) || Date.now(),
    read: from === "you" ? true : raw.read !== false,
  };
  if (payload) out.payload = payload;
  if (
    raw.blocked_send === true ||
    (raw.payload && raw.payload.blocked_send === true)
  ) {
    out.blocked_send = true;
  }
  /* H2.14：群说话人挂在 bot 文本 payload 上 */
  if (from === "bot" && kind === "text") {
    const sp = normalizeSpeakerPayload(raw.payload || raw);
    if (sp) out.payload = Object.assign({}, out.payload || {}, sp);
  }
  const quote = normalizeQuote(raw.quote);
  if (quote) out.quote = quote;
  const forward = normalizeForward(raw.forward);
  if (forward) out.forward = forward;
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
  /* 家机文字多版本（重生）；顶层字段镜像当前 index */
  if (from === "bot" && kind === "text" && Array.isArray(raw.variants) && raw.variants.length) {
    const variants = [];
    for (const v of raw.variants.slice(-VARIANT_MAX)) {
      const n = normalizeVariant(v);
      if (n) variants.push(n);
    }
    if (variants.length) {
      let idx = Number(raw.variantIndex);
      if (!Number.isFinite(idx) || idx < 0) idx = 0;
      if (idx >= variants.length) idx = variants.length - 1;
      out.variants = variants;
      out.variantIndex = idx;
      mirrorVariant(out, variants[idx]);
    }
  }
  const reactions = normalizeReactions(raw.reactions);
  if (reactions.length) out.reactions = reactions;
  return out;
}

function normalizeVariant(raw) {
  if (!raw || typeof raw !== "object") return null;
  const body = String(raw.body || "").trim().slice(0, BODY_MAX);
  if (!body) return null;
  const v = { body, ts: Number(raw.ts) || Date.now() };
  const think = String(raw.think || "").trim();
  if (think) v.think = think.slice(0, 12000);
  const thinkSec = Number(raw.think_sec);
  if (Number.isFinite(thinkSec) && thinkSec > 0) {
    v.think_sec = Math.round(thinkSec * 10) / 10;
  }
  if (Array.isArray(raw.tools) && raw.tools.length) {
    const tools = [];
    for (const t of raw.tools.slice(0, 16)) {
      const p = normalizeToolPayload(t);
      if (p) tools.push(p);
    }
    if (tools.length) v.tools = tools;
  }
  return v;
}

function snapshotVariant(msg) {
  if (!msg) return null;
  return normalizeVariant({
    body: msg.body,
    think: msg.think,
    think_sec: msg.think_sec,
    tools: msg.tools,
    ts: msg.ts,
  });
}

function mirrorVariant(out, v) {
  if (!out || !v) return;
  out.body = v.body;
  if (v.think) out.think = v.think;
  else delete out.think;
  if (v.think_sec) out.think_sec = v.think_sec;
  else delete out.think_sec;
  if (v.tools && v.tools.length) out.tools = v.tools;
  else delete out.tools;
}

function updateMessageById(id, mutator) {
  const sid = String(id || "");
  const all = readAll();
  const idx = all.messages.findIndex((m) => m.id === sid);
  if (idx < 0) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  const cur = all.messages[idx];
  const next = typeof mutator === "function" ? mutator(cur) : cur;
  const norm = normalizeMsg(next);
  if (!norm) {
    const err = new Error("消息无效");
    err.code = "bad_chat_body";
    throw err;
  }
  all.messages[idx] = norm;
  writeAll(all);
  return norm;
}

/** 仅最新家机文字可重生：其后不能有你的消息 */
function assertRegenTarget(id) {
  const sid = String(id || "");
  const messages = listMessages().messages;
  const idx = messages.findIndex((m) => m.id === sid);
  if (idx < 0) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  const msg = messages[idx];
  if (msg.from !== "bot" || msg.kind !== "text") {
    const err = new Error("只能重生家机文字");
    err.code = "not_regen_target";
    throw err;
  }
  let lastBotText = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].from === "bot" && messages[i].kind === "text") {
      lastBotText = i;
      break;
    }
  }
  if (idx !== lastBotText) {
    const err = new Error("只能重生最新一条家机文字");
    err.code = "not_latest";
    throw err;
  }
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i].from === "you") {
      const err = new Error("这条后面已有新对话，不能重生");
      err.code = "not_latest";
      throw err;
    }
  }
  return { messages, idx, msg };
}

/**
 * 撤回落库。opts.from = "you"|"bot"（默认 you）。
 * 家机撤回时附带你侧 miss/peek（H1.28）。
 */
function recallMessage(id, opts) {
  const sid = String(id || "");
  const expectFrom = opts && opts.from === "bot" ? "bot" : "you";
  const all = readAll();
  const msgIdx = all.messages.findIndex((m) => m.id === sid);
  if (msgIdx < 0) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  const cur = all.messages[msgIdx];
  if (cur.from !== expectFrom) {
    const err = new Error(
      expectFrom === "bot" ? "只能撤回家机消息" : "只能撤回自己发的消息"
    );
    err.code = "not_yours";
    throw err;
  }
  if (cur.recalled) {
    return { ok: true, message: cur, already: true, snap: null };
  }
  if (recallExpired(cur.ts)) {
    const err = new Error("超过2分钟不能撤回");
    err.code = "recall_expired";
    throw err;
  }
  const snap = {
    body: String(cur.body || ""),
    kind: cur.kind || "text",
  };
  const next = {
    id: cur.id,
    from: expectFrom,
    kind: cur.kind || "text",
    body: "",
    recalled: true,
    ts: cur.ts || Date.now(),
    read: true,
  };
  /* 原文留给模型「心里有数」；搜索仍忽略 recalled */
  if (snap.body) next.recall_body = String(snap.body).slice(0, BODY_MAX);
  if (expectFrom === "bot") {
    const sight = decideBotRecallYouSight(
      snap,
      opts && opts.forceSight ? String(opts.forceSight) : ""
    );
    next.recall_sight = sight.mode;
    if (sight.mode === "peek" && sight.body) {
      next.peek_body = String(sight.body).slice(0, BODY_MAX);
    }
  }
  const norm = normalizeMsg(next);
  all.messages[msgIdx] = norm;
  writeAll(all);
  return { ok: true, message: norm, already: false, snap };
}

/**
 * H1.19：你撤回 → 家机可见性。miss / silent / roast。
 * @param {{ body?: string, kind?: string }|null} snap
 * @param {string} [force] 自检用
 */
function decideRecallSight(snap, force) {
  const body = String((snap && snap.body) || "").trim();
  const kind = String((snap && snap.kind) || "text");
  if (force === "miss" || force === "silent" || force === "roast") {
    return { mode: force, body, kind };
  }
  const r = Math.random();
  if (r < 0.35) return { mode: "miss", body: "", kind };
  if (r < 0.65) return { mode: "silent", body, kind };
  return { mode: "roast", body, kind };
}

/**
 * H1.28：家机撤回 → 你侧可见性。miss 没看见 / peek 点灰条能回看。
 */
function decideBotRecallYouSight(snap, force) {
  const body = String((snap && snap.body) || "").trim();
  if (force === "miss" || force === "peek") {
    return { mode: force, body: force === "peek" ? body : "" };
  }
  if (!body) return { mode: "miss", body: "" };
  /* 略偏 miss，撤回才有意义 */
  if (Math.random() < 0.55) return { mode: "miss", body: "" };
  return { mode: "peek", body };
}

function botSelfRecallChance() {
  try {
    const { readMood } = require("./mood");
    const m = readMood();
    const na = Number(m && m.na) || 0;
    return 0.07 + Math.min(0.2, na * 0.22);
  } catch (_) {
    return 0.12;
  }
}

/**
 * H1.29：切换表情回应。每人每条最多一个；同表情再点取消。
 * @returns {object} 更新后的消息
 */
function toggleMessageReaction(id, emojiRaw, fromRaw) {
  const sid = String(id || "").trim();
  const emoji = normalizeReactionEmoji(emojiRaw);
  const who = fromRaw === "bot" ? "bot" : "you";
  if (!sid) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  if (!emoji) {
    const err = new Error("请选一个表情");
    err.code = "bad_reaction";
    throw err;
  }
  return updateMessageById(sid, (cur) => {
    if (!cur || cur.recalled) {
      const err = new Error("这条不能回应");
      err.code = "bad_reaction";
      throw err;
    }
    if (cur.kind === "tool" || cur.kind === "call" || cur.kind === "pat") {
      const err = new Error("这条不能回应");
      err.code = "bad_reaction";
      throw err;
    }
    let reactions = normalizeReactions(cur.reactions);
    const same = reactions.findIndex((r) => r.from === who && r.emoji === emoji);
    if (same >= 0) {
      reactions = reactions.filter((_, i) => i !== same);
    } else {
      reactions = reactions.filter((r) => r.from !== who);
      reactions.push({ from: who, emoji });
    }
    const next = Object.assign({}, cur);
    if (reactions.length) next.reactions = reactions;
    else delete next.reactions;
    return next;
  });
}

/** 家机偶发给你刚发的消息贴表情 */
async function maybeBotReact(write, youMsg, opts) {
  if (opts && opts.skipBotReact) return;
  if (!youMsg || youMsg.from !== "you" || youMsg.recalled) return;
  if (youMsg.kind === "tool" || youMsg.kind === "call" || youMsg.kind === "pat")
    return;
  if (Math.random() >= 0.16) return;
  const emoji = REACTION_EMOJI[Math.floor(Math.random() * REACTION_EMOJI.length)];
  try {
    const msg = toggleMessageReaction(youMsg.id, emoji, "bot");
    await write({ type: "react", ok: true, message: msg });
  } catch (_) {
    /* ignore */
  }
}

/**
 * 家机刚发完文字后：小概率过几秒撤回（仍挂在同一条 SSE 上）。
 * emit: bot_recall
 */
async function maybeBotSelfRecall(write, botMsg, opts) {
  if (opts && opts.skipBotRecall) return;
  if (!botMsg || botMsg.from !== "bot" || botMsg.kind !== "text") return;
  const body = String(botMsg.body || "").trim();
  if (body.length < 2) return;

  const force = opts && opts.forceBotRecall;
  const forceSight =
    force === "miss" || force === "peek"
      ? force
      : force
        ? "peek"
        : "";
  if (!force && Math.random() >= botSelfRecallChance()) return;
  if (recallExpired(botMsg.ts)) return;

  const { sleep } = require("./mood");
  const age = Date.now() - (Number(botMsg.ts) || Date.now());
  const room = RECALL_MAX_AGE_MS - age;
  if (!force && room < 500) return;
  const want = force ? 40 : 2000 + Math.floor(Math.random() * 7000);
  await sleep(force ? 40 : Math.min(want, Math.max(0, room - 200)));

  const msgs = listMessages().messages || [];
  const still = msgs.find((m) => m && m.id === botMsg.id);
  if (!still || still.recalled || still.from !== "bot") return;
  if (recallExpired(still.ts)) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.from !== "bot" || m.recalled) continue;
    if (m.kind !== "text") continue;
    if (m.id !== botMsg.id) return;
    break;
  }

  let out;
  try {
    out = recallMessage(botMsg.id, {
      from: "bot",
      forceSight: forceSight || undefined,
    });
  } catch (_) {
    return;
  }
  if (!out || out.already || !out.message) return;
  await write({
    type: "bot_recall",
    ok: true,
    message: out.message,
    sight: out.message.recall_sight || "miss",
    peek: out.message.peek_body || "",
  });
}

function resolveRecallScreenshotUrl(sight, opts) {
  let url = String((opts && opts.screenshotUrl) || "").trim();
  if (url && isMediaUrl(url)) return url;
  if (!sight || sight.mode !== "roast") return "";
  if (sight.kind === "image" && isMediaUrl(sight.body)) return sight.body;
  return "";
}

/**
 * 删消息。若有多版重生且传入 index（或默认当前 variantIndex），只删那一版；
 * 剩一版则收成普通气泡；一版都不剩 / 无 variants → 整条删除。
 */
function deleteMessage(id, indexOpt) {
  const sid = String(id || "");
  const all = readAll();
  const msgIdx = all.messages.findIndex((m) => m.id === sid);
  if (msgIdx < 0) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  const cur = all.messages[msgIdx];
  const variants = Array.isArray(cur.variants)
    ? cur.variants.map(normalizeVariant).filter(Boolean)
    : [];

  if (variants.length >= 2) {
    let vi = Number(indexOpt);
    if (!Number.isFinite(vi)) vi = Number(cur.variantIndex) || 0;
    if (vi < 0 || vi >= variants.length) {
      const err = new Error("版本序号无效");
      err.code = "bad_variant_index";
      throw err;
    }
    const nextVars = variants.filter((_, i) => i !== vi);
    if (nextVars.length >= 2) {
      const newIndex = Math.min(vi, nextVars.length - 1);
      const next = Object.assign({}, cur, {
        variants: nextVars,
        variantIndex: newIndex,
      });
      mirrorVariant(next, nextVars[newIndex]);
      const norm = normalizeMsg(next);
      all.messages[msgIdx] = norm;
      writeAll(all);
      return { ok: true, id: sid, deleted: false, message: norm };
    }
    /* 只剩一版：折叠掉 variants */
    const only = nextVars[0];
    const next = Object.assign({}, cur);
    delete next.variants;
    delete next.variantIndex;
    mirrorVariant(next, only);
    const norm = normalizeMsg(next);
    all.messages[msgIdx] = norm;
    writeAll(all);
    return { ok: true, id: sid, deleted: false, message: norm };
  }

  const removed = all.messages[msgIdx];
  all.messages.splice(msgIdx, 1);
  writeAll(all);
  return { ok: true, id: sid, deleted: true, message: removed };
}

function setMessageVariant(id, index) {
  const want = Number(index);
  return updateMessageById(id, (cur) => {
    if (cur.from !== "bot" || cur.kind !== "text") {
      const err = new Error("只能切换家机文字版本");
      err.code = "not_regen_target";
      throw err;
    }
    const variants = Array.isArray(cur.variants) ? cur.variants.slice() : [];
    if (variants.length < 2) {
      const err = new Error("还没有可切换的版本");
      err.code = "no_variants";
      throw err;
    }
    if (!Number.isFinite(want) || want < 0 || want >= variants.length) {
      const err = new Error("版本序号无效");
      err.code = "bad_variant_index";
      throw err;
    }
    const next = Object.assign({}, cur, { variantIndex: want });
    mirrorVariant(next, variants[want]);
    return next;
  });
}

function appendVariantToMessage(id, variantRaw) {
  const neu = normalizeVariant(variantRaw);
  if (!neu) {
    const err = new Error("新回复为空");
    err.code = "llm_empty";
    throw err;
  }
  return updateMessageById(id, (cur) => {
    let variants = Array.isArray(cur.variants) ? cur.variants.map(normalizeVariant).filter(Boolean) : [];
    if (!variants.length) {
      const old = snapshotVariant(cur);
      if (old) variants = [old];
    }
    variants.push(neu);
    if (variants.length > VARIANT_MAX) variants = variants.slice(-VARIANT_MAX);
    const variantIndex = variants.length - 1;
    const next = Object.assign({}, cur, { variants, variantIndex, ts: neu.ts || Date.now() });
    mirrorVariant(next, variants[variantIndex]);
    return next;
  });
}

function extFromContentType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.includes("png")) return "png";
  if (s.includes("webp")) return "webp";
  if (s.includes("gif")) return "gif";
  if (s.includes("webm")) return "webm";
  if (s.includes("ogg")) return "ogg";
  if (s.includes("mpeg") || s.includes("mp3")) return "mp3";
  if (s.includes("mp4") || s.includes("m4a") || s.includes("aac")) return "m4a";
  if (s.includes("wav")) return "wav";
  return "jpg";
}

function safeFileExt(originalName) {
  let ext = path
    .extname(String(originalName || ""))
    .replace(/^\./, "")
    .toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext) || FILE_BLOCKED_EXT.has(ext)) return "bin";
  return ext;
}

/**
 * @param {Buffer} buf
 * @param {string} [contentType]
 * @param {string} [originalName] 有则当聊天附件（更大上限 + 按原后缀存）
 */
function saveChatMedia(buf, contentType, originalName) {
  ensureFile();
  if (!Buffer.isBuffer(buf) || !buf.length) {
    const err = new Error("文件为空");
    err.code = "bad_chat_media";
    throw err;
  }
  const asFile = Boolean(originalName && String(originalName).trim());
  const limit = asFile ? FILE_MAX_BYTES : MEDIA_MAX_BYTES;
  if (buf.length > limit) {
    const err = new Error(
      asFile ? "文件太大（上限约 16MB）" : "文件太大（上限 2MB）"
    );
    err.code = "chat_media_too_large";
    throw err;
  }
  const ext = asFile
    ? safeFileExt(originalName)
    : extFromContentType(contentType);
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

function mediaIdFromUrl(url) {
  const s = String(url || "").trim();
  if (s.startsWith(MEDIA_URL_PREFIX)) {
    const id = s.slice(MEDIA_URL_PREFIX.length);
    return MEDIA_ID_RE.test(id) ? id : "";
  }
  return MEDIA_ID_RE.test(s) ? s : "";
}

/** 给视觉模型用的 data URL；过大则 null（仍可文字带 url） */
function chatMediaDataUrl(urlOrId) {
  const id = mediaIdFromUrl(urlOrId);
  const filePath = resolveChatMediaPath(id);
  if (!filePath) return null;
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
  if (!buf || !buf.length || buf.length > 900000) return null;
  const ext = path.extname(id).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  return "data:" + mime + ";base64," + buf.toString("base64");
}

/** 当前线程你侧近期图片，时间正序，pick=1…n */
function listRecentYouImages(limit) {
  const lim = Math.max(1, Math.min(12, Math.floor(Number(limit) || 8)));
  const msgs = (listMessages().messages || []).filter(
    (m) =>
      m &&
      m.from === "you" &&
      m.kind === "image" &&
      !m.recalled &&
      isMediaUrl(String(m.body || "").trim())
  );
  const slice = msgs.slice(-lim);
  return slice.map((m, i) => ({
    pick: i + 1,
    id: m.id,
    url: String(m.body || "").trim(),
    ts: m.ts,
  }));
}

/**
 * 换头像：默认写当前 peer；家机(daily)同时写设定 avatar_bot，壳顶栏跟着变。
 * who=you → avatar_user（仅 daily 有意义）
 */
function applyChatAvatar({ url, who }) {
  const av = normalizePeerAvatar(url);
  const side = who === "you" ? "you" : "bot";
  const peerId = currentPeerId();
  if (side === "bot") {
    updatePeer(peerId, { avatar: av });
    /* 并发 writeStore 可能冲掉字段；读回不对就再写一次 */
    const hit = (readStore().peers || []).find((p) => p && p.id === peerId);
    if (!hit || hit.avatar !== av) updatePeer(peerId, { avatar: av });
    if (peerId === DEFAULT_PEER_ID) {
      const { patchSettings } = require("../../共读app/gateway/settings");
      patchSettings({ avatar_bot: av });
    }
  } else {
    if (peerId === DEFAULT_PEER_ID) {
      const { patchSettings } = require("../../共读app/gateway/settings");
      patchSettings({ avatar_user: av });
    }
  }
  return { ok: true, who: side, url: av, peerId };
}

function userImagePriorContent(m, pickById, visionLeft) {
  const url = String((m && m.body) || "").trim();
  const pick = m && m.id && pickById ? pickById.get(m.id) : 0;
  const label = pick
    ? "[候选头像#" +
      pick +
      "] 若让你换头像请 set_avatar(pick=" +
      pick +
      " 或 url=" +
      url +
      ")"
    : url
      ? "[图片 " + url + "]"
      : "[图片]";
  if (visionLeft && visionLeft.n > 0) {
    const dataUrl = chatMediaDataUrl(url);
    if (dataUrl) {
      visionLeft.n -= 1;
      return [
        { type: "text", text: label },
        { type: "image_url", image_url: { url: dataUrl } },
      ];
    }
  }
  return label;
}

function threadBucket(store, peerId) {
  const th = store.threads[peerId];
  if (!th || typeof th !== "object") {
    const empty = emptyThread();
    store.threads[peerId] = empty;
    return empty;
  }
  if (!th.topics || typeof th.topics !== "object") th.topics = {};
  if (th.active_topic == null) th.active_topic = "";
  return th;
}

function activeMessageList(th, topicId) {
  const tid = normalizeTopicId(topicId);
  if (tid && th.topics && th.topics[tid]) {
    if (!Array.isArray(th.topics[tid].messages)) th.topics[tid].messages = [];
    return th.topics[tid].messages;
  }
  if (!Array.isArray(th.messages)) th.messages = [];
  return th.messages;
}

function readAll() {
  const store = readStore();
  const peerId = currentPeerId();
  const topicId = currentTopicId();
  const th = threadBucket(store, peerId);
  const rawMsgs = activeMessageList(th, topicId);
  const messages = (rawMsgs || []).map(normalizeMsg).filter(Boolean);
  messages.sort((a, b) => a.ts - b.ts);
  const topic =
    topicId && th.topics && th.topics[topicId] ? th.topics[topicId] : null;
  const archive_before_ts =
    topicId && topic
      ? Math.max(0, Math.floor(Number(topic.archive_before_ts) || 0))
      : Math.max(0, Math.floor(Number(th.archive_before_ts) || 0));
  return {
    threadId: peerId,
    peerId,
    topicId: topicId || "",
    topicTitle: topic ? topic.title : "",
    memory_inject: topic ? topic.memory_inject !== false : true,
    archive_before_ts,
    messages,
    tokens_used: Math.max(0, Math.floor(Number(th.tokens_used) || 0)),
    budget_tokens: Math.max(0, Math.floor(Number(th.budget_tokens) || 0)),
    last_poke_day: store.last_poke_day || "",
    poke_count: store.poke_count || 0,
    think: !!store.think,
    slow_reply: store.slow_reply === false ? false : true,
  };
}

function writeAll(data) {
  const store = readStore();
  const peerId = currentPeerId();
  const topicId = currentTopicId();
  const prevTh = threadBucket(store, peerId);
  const messages = (data.messages || []).map(normalizeMsg).filter(Boolean);
  messages.sort((a, b) => a.ts - b.ts);
  const tokens_used = Object.prototype.hasOwnProperty.call(data, "tokens_used")
    ? Math.max(0, Math.floor(Number(data.tokens_used) || 0))
    : Math.max(0, Math.floor(Number(prevTh.tokens_used) || 0));
  const budget_tokens = Object.prototype.hasOwnProperty.call(data, "budget_tokens")
    ? Math.max(0, Math.floor(Number(data.budget_tokens) || 0))
    : Math.max(0, Math.floor(Number(prevTh.budget_tokens) || 0));
  const topics = normalizeTopicsMap(prevTh.topics);
  let active = normalizeTopicId(prevTh.active_topic);
  if (active && !topics[active]) active = "";
  const archive_before_ts = Math.max(
    0,
    Math.floor(Number(prevTh.archive_before_ts) || 0)
  );
  if (topicId && topics[topicId]) {
    topics[topicId] = {
      ...topics[topicId],
      messages,
      updated_at: Date.now(),
    };
    store.threads[peerId] = {
      messages: Array.isArray(prevTh.messages) ? prevTh.messages : [],
      tokens_used,
      budget_tokens,
      topics,
      active_topic: active,
      archive_before_ts,
    };
  } else {
    store.threads[peerId] = {
      messages,
      tokens_used,
      budget_tokens,
      topics,
      active_topic: active,
      archive_before_ts,
    };
  }
  if (Object.prototype.hasOwnProperty.call(data, "last_poke_day")) {
    store.last_poke_day = String(data.last_poke_day || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(data, "poke_count")) {
    store.poke_count = Math.max(0, Math.floor(Number(data.poke_count) || 0));
  }
  if (Object.prototype.hasOwnProperty.call(data, "think")) {
    store.think = !!data.think;
  }
  if (Object.prototype.hasOwnProperty.call(data, "slow_reply")) {
    store.slow_reply = data.slow_reply !== false;
  }
  writeStore(store);
  return {
    threadId: peerId,
    peerId,
    messages,
    tokens_used,
    budget_tokens,
    last_poke_day: store.last_poke_day || "",
    poke_count: store.poke_count || 0,
    think: !!store.think,
    slow_reply: store.slow_reply !== false,
  };
}

function getChatPrefs() {
  const all = readAll();
  return {
    ok: true,
    think: !!all.think,
    slow_reply: all.slow_reply !== false,
  };
}

function setChatPrefs(patch) {
  const all = readAll();
  const next = { ...all };
  if (patch && Object.prototype.hasOwnProperty.call(patch, "think")) {
    next.think = !!patch.think;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "slow_reply")) {
    next.slow_reply = !!patch.slow_reply;
  }
  writeAll(next);
  return getChatPrefs();
}

/** H1.32：只清空本会话消息。偏好、额度、主动短讯计数、心情/收藏/朋友圈不动。 */
function clearChatMessages() {
  const all = readAll();
  const removed = all.messages.length;
  writeAll({ ...all, messages: [] });
  return { ok: true, removed };
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
  let callChance = 0.12;
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    if (readSettings().call_proactive_enabled) callChance = 0.35;
  } catch (_) {}
  if (Math.random() < callChance) {
    /* 偶发来电（inbound）；M4 主动来电开时更勤 */
    message = startChatCall(Math.random() < 0.35 ? "video" : "voice", "in").message;
  } else if (Math.random() < 0.28) {
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

/** H1.81：已领钱有 receipt 但缺同文 sys 灰字时补种（幂等） */
function backfillMoneySysTips() {
  const all = readAll();
  const msgs = Array.isArray(all.messages) ? all.messages : [];
  if (!msgs.length) return false;
  const out = [];
  let changed = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (!m || !MONEY_KINDS.has(m.kind)) continue;
    if (m.payload && m.payload.is_receipt) continue;
    if (!m.payload || m.payload.status === "sent") continue;
    const tip = String(m.payload.receipt || "").trim().slice(0, 40);
    if (!tip) continue;
    let has = false;
    for (let j = i + 1; j < msgs.length; j++) {
      const n = msgs[j];
      if (!n) continue;
      if (n.kind === "sys" && String(n.body || "").trim() === tip) {
        has = true;
        break;
      }
      if (
        MONEY_KINDS.has(n.kind) &&
        !(n.payload && n.payload.is_receipt)
      ) {
        break;
      }
    }
    if (has) continue;
    const tipMsg = normalizeMsg({
      id: randomUUID(),
      from: "bot",
      kind: "sys",
      body: tip,
      ts: (Number(m.ts) || Date.now()) + 1,
      read: true,
    });
    if (!tipMsg) continue;
    out.push(tipMsg);
    changed = true;
  }
  if (!changed) return false;
  writeAll({ ...all, messages: out });
  return true;
}

function listMessages() {
  backfillMoneySysTips();
  const all = readAll();
  return {
    ok: true,
    threadId: all.threadId,
    peerId: all.peerId || all.threadId,
    topicId: all.topicId || "",
    topicTitle: all.topicTitle || "",
    memory_inject: all.memory_inject !== false,
    archive_before_ts: Math.max(0, Math.floor(Number(all.archive_before_ts) || 0)),
    messages: all.messages,
  };
}

/** IB M7：当前频道封档线（ms）；0=无 */
function getArchiveBeforeTs() {
  return Math.max(0, Math.floor(Number(readAll().archive_before_ts) || 0));
}

/** 设封档线；ts=0 清除。各频道独立。 */
function setArchiveBeforeTs(ts) {
  const cut = Math.max(0, Math.floor(Number(ts) || 0));
  const store = readStore();
  const peerId = currentPeerId();
  const topicId = currentTopicId();
  const th = threadBucket(store, peerId);
  if (topicId) {
    const topics = normalizeTopicsMap(th.topics);
    if (!topics[topicId]) {
      const err = new Error("话题不存在");
      err.code = "topic_missing";
      throw err;
    }
    topics[topicId] = {
      ...topics[topicId],
      archive_before_ts: cut,
      updated_at: Date.now(),
    };
    store.threads[peerId] = { ...th, topics };
  } else {
    store.threads[peerId] = { ...th, archive_before_ts: cut };
  }
  writeStore(store);
  return { ok: true, archive_before_ts: cut };
}

/** 封档到指定消息（含该条及更早） */
function setArchiveAtMessage(messageId) {
  const sid = String(messageId || "").trim();
  if (!sid) {
    const err = new Error("缺少消息");
    err.code = "bad_archive";
    throw err;
  }
  const msg = (listMessages().messages || []).find((m) => m && m.id === sid);
  if (!msg) {
    const err = new Error("消息不存在");
    err.code = "msg_missing";
    throw err;
  }
  return setArchiveBeforeTs(Number(msg.ts) || 0);
}

/** H7：列出某 peer 的话题频道（不含主线消息体） */
function listTopics(peerId) {
  const store = readStore();
  const pid = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const th = threadBucket(store, pid);
  const topics = normalizeTopicsMap(th.topics);
  const rows = Object.keys(topics)
    .map((id) => {
      const t = topics[id];
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        id: t.id,
        title: t.title,
        memory_inject: t.memory_inject !== false,
        created_at: t.created_at,
        updated_at: t.updated_at,
        count: msgs.length,
        preview: last
          ? String(last.body || last.kind || "").trim().slice(0, 40)
          : "",
      };
    })
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const active = normalizeTopicId(th.active_topic);
  return {
    ok: true,
    peerId: pid,
    active_topic: active && topics[active] ? active : "",
    main: {
      id: "",
      title: "主线",
      memory_inject: true,
      count: Array.isArray(th.messages) ? th.messages.length : 0,
    },
    topics: rows,
  };
}

function createTopic(peerId, patch) {
  const store = readStore();
  const pid = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const th = threadBucket(store, pid);
  const topics = normalizeTopicsMap(th.topics);
  if (Object.keys(topics).length >= TOPICS_MAX) {
    const err = new Error("话题频道已满（" + TOPICS_MAX + "）");
    err.code = "topics_full";
    throw err;
  }
  const topic = emptyTopic({
    title: patch && patch.title,
    memory_inject: patch && patch.memory_inject,
  });
  topics[topic.id] = topic;
  store.threads[pid] = {
    ...th,
    topics,
    active_topic: normalizeTopicId(th.active_topic),
  };
  writeStore(store);
  return { ok: true, topic: listTopics(pid).topics.find((t) => t.id === topic.id) };
}

function updateTopic(peerId, topicId, patch) {
  const store = readStore();
  const pid = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const tid = normalizeTopicId(topicId);
  const th = threadBucket(store, pid);
  const topics = normalizeTopicsMap(th.topics);
  if (!tid || !topics[tid]) {
    const err = new Error("话题不存在");
    err.code = "topic_missing";
    throw err;
  }
  const cur = topics[tid];
  if (patch && patch.title != null) {
    cur.title =
      String(patch.title || "").trim().slice(0, TOPIC_TITLE_MAX) || cur.title;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "memory_inject")) {
    cur.memory_inject = patch.memory_inject !== false;
  }
  cur.updated_at = Date.now();
  topics[tid] = cur;
  store.threads[pid] = { ...th, topics };
  writeStore(store);
  return { ok: true, topic: listTopics(pid).topics.find((t) => t.id === tid) };
}

function deleteTopic(peerId, topicId) {
  const store = readStore();
  const pid = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const tid = normalizeTopicId(topicId);
  const th = threadBucket(store, pid);
  const topics = normalizeTopicsMap(th.topics);
  if (!tid || !topics[tid]) {
    const err = new Error("话题不存在");
    err.code = "topic_missing";
    throw err;
  }
  delete topics[tid];
  let active = normalizeTopicId(th.active_topic);
  if (active === tid) active = "";
  store.threads[pid] = { ...th, topics, active_topic: active };
  writeStore(store);
  return { ok: true, id: tid, active_topic: active };
}

function setActiveTopic(peerId, topicId) {
  const store = readStore();
  const pid = normalizePeerId(peerId != null ? peerId : currentPeerId());
  const tid = normalizeTopicId(topicId);
  const th = threadBucket(store, pid);
  const topics = normalizeTopicsMap(th.topics);
  if (tid && !topics[tid]) {
    const err = new Error("话题不存在");
    err.code = "topic_missing";
    throw err;
  }
  store.threads[pid] = { ...th, topics, active_topic: tid };
  writeStore(store);
  return { ok: true, peerId: pid, active_topic: tid };
}

function topicMemoryInjectEnabled() {
  const all = readAll();
  return all.memory_inject !== false;
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
  if (m.recalled) return "";
  /* H1.30：拍一拍不进搜索 */
  if (m.kind === "pat") return "";
  if (m.kind === "sys") return String(m.body || "");
  const p = m.payload || {};
  const parts = [m.body, p.note, p.name, p.detail];
  if (p.is_receipt) parts.push("已收款", "转账回执");
  if (m.quote) parts.push(m.quote.who, m.quote.text, "引用");
  if (m.forward) parts.push(m.forward.who, "转发");
  if (m.kind === "redpacket") parts.push("红包", "微信红包");
  if (m.kind === "transfer") parts.push("转账");
  if (m.kind === "sticker") parts.push("贴纸", "表情");
  if (m.kind === "image") parts.push("图片");
  if (m.kind === "voice") {
    parts.push("语音", "语音消息");
    if (p.transcript) parts.push(p.transcript, "转文字");
  }
  if (m.kind === "call") {
    const mp = m.payload || {};
    parts.push(
      mp.media === "video" ? "视频通话" : "语音通话",
      "通话",
      callDisplayBody(mp)
    );
  }
  if (m.kind === "location") parts.push("位置");
  if (m.kind === "file") parts.push("文件", p.name, p.text);
  if (m.kind === "music") parts.push("音乐", p.name, p.artist);
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

function appendToolMessage({ name, label, summary, ok, detail }) {
  const payload = normalizeToolPayload({
    name,
    label,
    summary,
    ok: ok !== false,
    detail,
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

/** q / kind(all|text|image|sticker|redpacket|transfer|location|money) / from / to (YYYY-MM-DD) / peer / topic */
function searchMessages(query) {
  const q = String((query && query.q) || "").trim().toLowerCase();
  const kind = String((query && query.kind) || "all").trim() || "all";
  const fromMs = dayStartMs(query && query.from);
  const toMs = dayEndMs(query && query.to);
  const peerId = String((query && query.peer) || "").trim();
  const topicId = String((query && query.topic) || "").trim();
  let messages = [];
  if (peerId) {
    withPeerTopic(peerId, topicId, () => {
      messages = listMessages().messages || [];
    });
  } else {
    const store = readStore();
    for (const p of store.peers) {
      withPeer(p.id, () => {
        messages = messages.concat(listMessages().messages || []);
      });
    }
  }
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
    if (k === "voice" && !isMediaUrl(text)) {
      const err = new Error("语音无效");
      err.code = "bad_chat_voice";
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
  const { walletTransfer, readWallet, writeWallet } = require("../../资产app/gateway/wallet");
  const pay = () =>
    walletTransfer({
      from: "bot",
      to: "you",
      amount: payload.amount,
      kind: k,
      note: payload.note,
      msg_id: msgId,
    });
  try {
    pay();
  } catch (e) {
    if (!(e && e.code === "wallet_insufficient")) throw e;
    /* 气氛红包：零花不够时给家机补一笔再发，避免口头说发了却没卡片 */
    const w = readWallet();
    w.bot_balance = Math.max(Number(w.bot_balance) || 0, 1000);
    writeWallet(w);
    try {
      pay();
    } catch (e2) {
      if (e2 && e2.code === "wallet_insufficient") return null;
      throw e2;
    }
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
  const userBlob = llmContent(you);
  const blob = (userBlob + " " + String(botText || "")).toLowerCase();
  let kind = null;
  const askRp =
    /红包|利是|塞红包|再发一|发一个|赏你|给点钱|一块钱|1\s*块|一块/.test(blob) ||
    (/发/.test(userBlob) && /(?:块|元|￥|¥)\s*$|(?:\d+(?:\.\d+)?)\s*(?:块|元)/.test(userBlob));
  if (/转账|打钱|给你钱|报销|午饭|奶茶钱|买杯/.test(blob) && !/红包|利是/.test(blob)) {
    kind = "transfer";
  } else if (/红包|利是|塞红包/.test(blob) || askRp) {
    kind = "redpacket";
  } else if (Math.random() < 0.07) {
    kind = Math.random() < 0.55 ? "redpacket" : "transfer";
  }
  if (!kind) return null;
  const amounts =
    kind === "redpacket"
      ? [5.2, 6.66, 8.8, 18.8, 52]
      : [6.66, 12, 18.8, 28, 52, 66];
  const notes =
    kind === "redpacket"
      ? ["恭喜发财", "赏你的", "开心收着"]
      : ["一点心意", "午饭钱", "拿去花"];
  let amount = amounts[Math.floor(Math.random() * amounts.length)];
  const am = String(userBlob).match(/(\d+(?:\.\d+)?)\s*(?:块|元|￥|¥)?/);
  if (am) {
    const n = Number(am[1]);
    if (n > 0 && n <= 200) amount = Math.round(n * 100) / 100;
  }
  const note = notes[Math.floor(Math.random() * notes.length)];
  return createBotMoney(kind, amount, note);
}

function unreadCount() {
  const store = readStore();
  const byPeer = {};
  let total = 0;
  for (const p of store.peers) {
    const msgs = ((store.threads[p.id] || emptyThread()).messages || [])
      .map(normalizeMsg)
      .filter(Boolean);
    const n = msgs.filter((m) => m.from === "bot" && !m.read).length;
    byPeer[p.id] = n;
    total += n;
  }
  /* count = 总和（Dock）；byPeer 给会话列表角标 */
  return { ok: true, count: total, byPeer, total };
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

/**
 * H1.27：发起通话。
 * dir=out 你拨出（from you，等待对方）；dir=in 家机来电（from bot）。
 */
function startChatCall(mediaRaw, dirRaw) {
  const media = mediaRaw === "video" ? "video" : "voice";
  const dir = dirRaw === "in" ? "in" : "out";
  const payload = normalizeCallPayload({
    media,
    dir,
    phase: "invite",
    durationSec: 0,
    peer: "家机",
  });
  const from = dir === "in" ? "bot" : "you";
  const msg = normalizeMsg({
    id: randomUUID(),
    from,
    kind: "call",
    payload,
    body: callDisplayBody(payload),
    ts: Date.now(),
    read: from === "you",
  });
  if (!msg) {
    const err = new Error("通话无效");
    err.code = "bad_chat_call";
    throw err;
  }
  const all = readAll();
  all.messages.push(msg);
  writeAll(all);
  return { ok: true, message: msg };
}

function setChatCallPhase(id, patch) {
  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("通话不存在");
    err.code = "not_found";
    throw err;
  }
  return updateMessageById(sid, (cur) => {
    if (!cur || cur.kind !== "call") {
      const err = new Error("不是通话消息");
      err.code = "bad_chat_call";
      throw err;
    }
    const nextPhase = String((patch && patch.phase) || "").trim();
    if (!CALL_PHASES.has(nextPhase)) {
      const err = new Error("通话状态无效");
      err.code = "bad_chat_call";
      throw err;
    }
    const payload = normalizeCallPayload({
      ...(cur.payload || {}),
      phase: nextPhase,
      durationSec:
        patch && patch.durationSec != null
          ? patch.durationSec
          : (cur.payload && cur.payload.durationSec) || 0,
    });
    return {
      ...cur,
      payload,
      body: callDisplayBody(payload),
      read: true,
    };
  });
}

/**
 * 拒绝 / 结束通话；接通过并 ended 时家机可接一句。
 * emit: call → (可选 bot_*) → done
 */
async function finishChatCallStream(id, patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const phase = String((patch && patch.phase) || "").trim();
  if (phase !== "rejected" && phase !== "declined" && phase !== "ended") {
    const err = new Error("通话结束状态无效");
    err.code = "bad_chat_call";
    throw err;
  }
  const msg = setChatCallPhase(id, {
    phase,
    durationSec: patch && patch.durationSec,
  });
  await write({ type: "call", ok: true, message: msg });
  if (phase === "ended") {
    const { observeUserText } = require("./mood");
    const obs = llmContent(msg);
    if (obs) observeUserText(obs);
    /* prior 里跳过同 id 的 bot 通话条，改以 user 角色注入 */
    const asYou = Object.assign({}, msg, { from: "you" });
    return exclusiveBotReply(() =>
      runBotReplyStream(write, asYou, {
        skipObserve: true,
        coalesced: true,
      })
    );
  }
  /* M4：婉拒/拒绝来电 → 落一条你侧提示并让 TA 知情回应 */
  if (
    (phase === "declined" || phase === "rejected") &&
    msg &&
    msg.from === "bot"
  ) {
    const tip = appendMessage("you", "（暂时不方便接电话）", "text", {
      payload: { source: "call_decline" },
    });
    await write({ type: "you", message: tip });
    return exclusiveBotReply(() =>
      runBotReplyStream(write, tip, {
        skipObserve: true,
        coalesced: true,
        systemExtra:
          "对方婉拒了你刚打的电话，用一两句口语回应即可；不要立刻再拨、不要追问为什么。",
      })
    );
  }
  const messages = listMessages().messages;
  await write({
    type: "done",
    ok: true,
    message: msg,
    bot_message: null,
    messages,
  });
  return { ok: true, message: msg, bot_message: null, messages };
}

/** M4：`[[call:voice]]` / `[[call:video]]` */
const CALL_TAG_RE = /\[\[\s*call\s*:\s*(voice|video)\s*\]\]/gi;

function extractCallTag(text) {
  let media = "";
  const cleaned = String(text || "")
    .replace(CALL_TAG_RE, (_, m) => {
      media = String(m || "").toLowerCase() === "video" ? "video" : "voice";
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, media };
}

/**
 * 剥来电标签；若开启主动来电则拨入并发 bot_call。
 * @returns {Promise<string>} 展示用正文
 */
async function applyProactiveCallTag(write, text) {
  const parsed = extractCallTag(text);
  let body = parsed.text;
  if (!parsed.media) return String(text || "").trim();
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    if (!readSettings().call_proactive_enabled) {
      /* 关着也剥标签，避免露馅 */
      return body || String(text || "").trim();
    }
    const out = startChatCall(parsed.media, "in");
    if (out && out.message && typeof write === "function") {
      await write({ type: "bot_call", message: out.message });
    }
  } catch (_) {}
  if (!body) body = parsed.media === "video" ? "视频打给你了" : "打给你了";
  return body;
}

/**
 * M5：剥礼物标签；开启时发 bot_gift（仅仪式，无支付）。
 * @returns {Promise<string>}
 */
async function applyGiftTag(write, text) {
  let body = String(text || "");
  let gift = null;
  try {
    const { extractGiftTag } = require("./call-gifts");
    const parsed = extractGiftTag(body);
    body = parsed.text;
    gift = parsed.gift;
  } catch (_) {
    return String(text || "").trim();
  }
  if (!gift) return String(text || "").trim();
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    if (readSettings().call_gift_enabled && typeof write === "function") {
      await write({
        type: "bot_gift",
        gift: {
          tier: gift.tier,
          id: gift.id,
          name: gift.name,
          emoji: gift.emoji,
        },
      });
    }
  } catch (_) {}
  if (!body) body = gift.emoji + " 送了" + gift.name;
  else body = body + "\n" + gift.emoji + " " + gift.name;
  return body;
}

function mediaIdFromChatBody(body) {
  const s = String(body || "").trim();
  if (!s.startsWith(MEDIA_URL_PREFIX)) return "";
  const id = s.slice(MEDIA_URL_PREFIX.length);
  return MEDIA_ID_RE.test(id) ? id : "";
}

function contentTypeFromMediaId(id) {
  const ext = String(id || "")
    .split(".")
    .pop()
    .toLowerCase();
  if (ext === "webm") return "audio/webm";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a" || ext === "aac" || ext === "mp4") return "audio/mp4";
  if (ext === "wav") return "audio/wav";
  return "application/octet-stream";
}

function applyVoiceTranscriptStub(cur) {
  const payload = Object.assign({}, cur.payload || { durationMs: 0 });
  payload.transcript = VOICE_TRANSCRIPT_STUB;
  payload.transcriptStub = true;
  delete payload.transcriptHidden;
  return Object.assign({}, cur, { payload });
}

/**
 * 语音转文字：无 transcript 时真识别（voiceStub / 无音频 → 示意 stub）；
 * 已有 transcript 时只折叠/展开，不删正文。
 * opts.transcribe 仅自检 mock，跳过外网。
 */
async function toggleVoiceTranscript(id, opts) {
  const sid = String(id || "").trim();
  if (!sid) {
    const err = new Error("消息不存在");
    err.code = "not_found";
    throw err;
  }
  const all = readAll();
  const cur = all.messages.find((m) => m && m.id === sid);
  if (!cur || cur.recalled || cur.kind !== "voice") {
    const err = new Error(cur ? "这条不是语音" : "消息不存在");
    err.code = cur ? "bad_voice" : "not_found";
    throw err;
  }
  const payload = Object.assign({}, cur.payload || { durationMs: 0 });
  if (payload.transcript) {
    return updateMessageById(sid, (m) => {
      const p = Object.assign({}, m.payload || { durationMs: 0 });
      if (p.transcriptHidden) delete p.transcriptHidden;
      else p.transcriptHidden = true;
      return Object.assign({}, m, { payload: p });
    });
  }
  if (payload.voiceStub === true) {
    return updateMessageById(sid, applyVoiceTranscriptStub);
  }
  const mediaId = mediaIdFromChatBody(cur.body);
  const filePath = mediaId ? resolveChatMediaPath(mediaId) : null;
  if (!filePath) {
    return updateMessageById(sid, applyVoiceTranscriptStub);
  }
  const buf = fs.readFileSync(filePath);
  const transcribe =
    opts && typeof opts.transcribe === "function"
      ? opts.transcribe
      : require("../../共读app/gateway/llm").transcribeAudio;
  const result = await transcribe({
    buf,
    contentType: contentTypeFromMediaId(mediaId),
    filename: mediaId,
  });
  const text = String((result && result.text) || "").trim().slice(0, 2000);
  if (!text) {
    const err = new Error("未识别出文字");
    err.code = "asr_empty";
    throw err;
  }
  return updateMessageById(sid, (m) => {
    const p = Object.assign({}, m.payload || { durationMs: 0 });
    if (p.transcript) {
      delete p.transcriptHidden;
      return Object.assign({}, m, { payload: p });
    }
    p.transcript = text;
    delete p.transcriptStub;
    delete p.transcriptHidden;
    return Object.assign({}, m, { payload: p });
  });
}

/**
 * H1.30：你侧拍一拍。target=bot 拍家机；target=you 拍自己。
 * 拍家机时约 1/3 概率立刻回拍（不调 LLM）。
 */
function createPat(patch) {
  const target = patch && patch.target === "you" ? "you" : "bot";
  const forceSuffix =
    patch && patch.suffix != null ? String(patch.suffix).trim().slice(0, 12) : null;
  const suffix = forceSuffix != null ? forceSuffix : randomPatSuffix();
  const payload = { target };
  if (suffix) payload.suffix = suffix;
  const msg = appendMessage("you", patDisplayBody("you", payload), "pat", {
    payload,
  });
  let bot_pat = null;
  const forceBack = patch && patch.forceBotPat;
  if (
    target === "bot" &&
    (forceBack === true || (forceBack == null && Math.random() < 0.34))
  ) {
    const backSuffix =
      forceBack === true && forceSuffix != null
        ? forceSuffix
        : randomPatSuffix();
    const backPayload = { target: "you" };
    if (backSuffix) backPayload.suffix = backSuffix;
    bot_pat = appendMessage(
      "bot",
      patDisplayBody("bot", backPayload),
      "pat",
      { payload: backPayload }
    );
  }
  return { ok: true, message: msg, bot_pat };
}

function createMessage(patch) {
  /* 你已拉黑：任意出站消息打感叹号标记 */
  if (youBlockedPeer() && patch && typeof patch === "object") {
    patch = Object.assign({}, patch, { blocked_send: true });
  }
  const kind = normalizeKind(patch && patch.kind);
  if (kind === "tool") {
    const err = new Error("工具摘要不能手发");
    err.code = "bad_chat_kind";
    throw err;
  }
  if (kind === "call") {
    const err = new Error("通话请走通话接口");
    err.code = "bad_chat_kind";
    throw err;
  }
  if (kind === "pat") {
    const err = new Error("拍一拍请走拍一拍接口");
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
    const locExtra = { payload };
    const locFwd = normalizeForward(patch && patch.forward);
    if (locFwd) locExtra.forward = locFwd;
    if (patch && patch.blocked_send) locExtra.blocked_send = true;
    const msg = appendMessage("you", payload.name, "location", locExtra);
    return { ok: true, message: msg };
  }

  if (kind === "file") {
    const payload = normalizeFilePayload(patch);
    if (!payload) {
      const err = new Error("请选择文件");
      err.code = "bad_chat_file";
      throw err;
    }
    const fileExtra = { payload };
    const fileFwd = normalizeForward(patch && patch.forward);
    if (fileFwd) fileExtra.forward = fileFwd;
    if (patch && patch.blocked_send) fileExtra.blocked_send = true;
    const msg = appendMessage("you", payload.name, "file", fileExtra);
    return { ok: true, message: msg };
  }

  if (kind === "music") {
    const payload = normalizeMusicPayload(patch);
    if (!payload) {
      const err = new Error("请选择音乐");
      err.code = "bad_chat_music";
      throw err;
    }
    const musicExtra = { payload };
    if (patch && patch.blocked_send) musicExtra.blocked_send = true;
    const msg = appendMessage("you", payload.name, "music", musicExtra);
    return { ok: true, message: msg };
  }

  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("内容不能为空");
    err.code = "bad_chat_body";
    throw err;
  }
  const extra = {};
  const quote = normalizeQuote(patch && patch.quote);
  if (quote) extra.quote = quote;
  const forward = normalizeForward(patch && patch.forward);
  if (forward) extra.forward = forward;
  if (kind === "voice") {
    extra.payload = normalizeVoicePayload(patch);
  }
  if (patch && patch.blocked_send) extra.blocked_send = true;
  /* 服务端为准：你已拉黑对方时强制打标（防前端漏传） */
  if (youBlockedPeer()) extra.blocked_send = true;
  const msg = appendMessage("you", body, kind, extra);
  return { ok: true, message: msg };
}

function markMoneyReceived(msgId, receiptText) {
  const id = String(msgId || "").trim();
  if (!id) return null;
  const all = readAll();
  let found = null;
  const messages = all.messages.map((m) => {
    if (!m || m.id !== id || !MONEY_KINDS.has(m.kind)) return m;
    const payload = Object.assign({}, m.payload || {}, { status: "received" });
    const tip = String(receiptText || payload.receipt || "").trim().slice(0, 40);
    if (tip) payload.receipt = tip;
    found = normalizeMsg(Object.assign({}, m, { payload }));
    return found || m;
  });
  if (!found) return null;
  writeAll({ ...all, messages });
  return found;
}

/** 灰字回执落库，退出聊天再进还在 */
function appendSysTip(text) {
  const tip = String(text || "").trim().slice(0, 40);
  if (!tip) return null;
  return appendMessage("bot", tip, "sys", { read: true });
}

/** 转账已收：再发一条接收方气泡（微信式回执卡） */
function appendTransferReceipt(from, amount) {
  const amt = roundMoney(amount);
  if (!(amt > 0)) return null;
  return appendMessage(from, "已收款 ¥" + amt.toFixed(2), "transfer", {
    payload: {
      amount: amt,
      note: "已收款",
      status: "received",
      is_receipt: true,
    },
    read: true,
  });
}

/** 你发给家机：对方自动领；家机发给你：须点卡片领取（见 claimIncomingMoney） */
async function emitMoneyClaim(msg, write) {
  if (!msg || !MONEY_KINDS.has(msg.kind) || msg.from !== "you") return;
  await new Promise((r) => setTimeout(r, 380));
  const tip =
    msg.kind === "redpacket" ? "对方已领取你的红包" : "对方已收款";
  const claimed = markMoneyReceived(msg.id, tip);
  if (!claimed) return;
  await write({ type: "money_claim", message: claimed });
  const tipMsg = appendSysTip(tip);
  if (tipMsg) {
    await write({
      type: "money_tip",
      message: tipMsg,
      text: tip,
      ts: tipMsg.ts,
    });
  }
  if (msg.kind === "transfer") {
    const amt = claimed.payload && claimed.payload.amount;
    const receipt = appendTransferReceipt("bot", amt);
    if (receipt) await write({ type: "bot_money", message: receipt });
  }
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
    const tip = (m.payload && m.payload.receipt) || null;
    return {
      ok: true,
      already: true,
      message: m,
      tip,
      tip_message: null,
      receipt_message: null,
    };
  }
  const tip = m.kind === "redpacket" ? "你已领取红包" : "你已收款";
  const claimed = markMoneyReceived(id, tip);
  if (!claimed) {
    const err = new Error("领取失败");
    err.code = "bad_money_claim";
    throw err;
  }
  const tipMsg = appendSysTip(tip);
  let receiptMsg = null;
  if (m.kind === "transfer") {
    receiptMsg = appendTransferReceipt("you", claimed.payload.amount);
  }
  return {
    ok: true,
    already: false,
    message: claimed,
    tip: tip,
    tip_message: tipMsg,
    receipt_message: receiptMsg,
  };
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

function observeTextForMessage(you) {
  if (!you) return "";
  if (you.recalled) return "（我撤回了一条消息）";
  if (you.kind === "sticker") return "[贴纸]";
  if (you.kind === "image") return "[图片]";
  if (you.kind === "voice") return llmContent(you) || "[语音]";
  if (you.kind === "call") return llmContent(you) || "[通话]";
  if (you.kind === "location") return "[位置]";
  if (you.kind === "file") return "[文件]";
  if (you.kind === "music") return "[音乐]";
  if (you.kind === "redpacket" || you.kind === "transfer") {
    return you.kind === "redpacket" ? "[红包]" : "[转账]";
  }
  return String(llmContent(you) || you.body || "").trim();
}

/**
 * H1.17′：随机 1–12s 看一眼会不会连发（慢回关则只留短抖动）。
 * 不顶掉上路——一条条回也行；等完若已有更新的你侧短讯则本条 deferred，让最新那条带上下文回。
 */
let llmReplyChain = Promise.resolve();

function messageWaitsForCoalesce(you) {
  if (!you) return false;
  if (MONEY_KINDS.has(you.kind)) return false;
  return true;
}

function coalesceWaitMs(prefs) {
  if (prefs && prefs.slow_reply === false) {
    return 200 + Math.floor(Math.random() * 500);
  }
  /* 1000..12000 ms，含端点 */
  return 1000 + Math.floor(Math.random() * 11001);
}

function hasNewerYouMessage(you) {
  if (!you || !you.id) return false;
  const msgs = listMessages().messages || [];
  const idx = msgs.findIndex((m) => m && m.id === you.id);
  if (idx < 0) return false;
  for (let i = idx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.from !== "you" || m.recalled) continue;
    if (MONEY_KINDS.has(m.kind)) continue;
    return true;
  }
  return false;
}

function exclusiveBotReply(fn) {
  const run = llmReplyChain.then(fn, fn);
  llmReplyChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * 心情门控 + 流式接一句。you 可为 null（撤回后仅接话）。
 * emit: bot_start → (delay) → bot_delta* → bot_done|bot_error → done
 */
function moodPublicSnap() {
  try {
    const { getMoodPublic } = require("./mood");
    return getMoodPublic({ peerId: currentPeerId() });
  } catch (_) {
    return null;
  }
}

/** H2.14：从模型 JSON / 脏文本里抽出合法成员 id，最多 3 个 */
function parseSpeakerPickIds(raw, allowedIds) {
  const allow = new Set(
    (Array.isArray(allowedIds) ? allowedIds : [])
      .map((x) => String(x || "").trim())
      .filter((id) => PEER_ID_RE.test(id))
  );
  const fallback = () => {
    if (allow.has(DEFAULT_PEER_ID)) return [DEFAULT_PEER_ID];
    const first = allow.values().next().value;
    return first ? [first] : [DEFAULT_PEER_ID];
  };
  if (!allow.size) return [DEFAULT_PEER_ID];
  let ids = [];
  try {
    const s = String(raw || "");
    const m = s.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : s);
    const arr = Array.isArray(j && j.ids) ? j.ids : [];
    for (const x of arr) {
      const id = String(x || "").trim();
      if (!allow.has(id) || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= 3) break;
    }
  } catch (_) {
    ids = [];
  }
  return ids.length ? ids : fallback();
}

(function selfCheckSpeakerPick() {
  const a = parseSpeakerPickIds('{"ids":["daily","mint","ghost","mint"]}', [
    "daily",
    "mint",
  ]);
  if (a.join(",") !== "daily,mint") throw new Error("speaker pick trim");
  const b = parseSpeakerPickIds("not json", ["mint"]);
  if (b.join(",") !== "mint") throw new Error("speaker pick fallback");
})();

function resolveGroupMemberMeta(memberId) {
  const id = normalizePeerId(memberId);
  const store = readStore();
  const m = (store.peers || []).find((p) => p && p.id === id);
  if (id === DEFAULT_PEER_ID) {
    return {
      id,
      name: (m && m.name) || "家机",
      persona: String((m && m.persona) || "").trim(),
    };
  }
  return {
    id,
    name: (m && m.name) || id,
    persona: String((m && m.persona) || "").trim(),
  };
}

function currentGroupPeer() {
  const store = readStore();
  const pid = currentPeerId();
  const peer = (store.peers || []).find((p) => p && p.id === pid);
  if (!peer || peer.kind !== "group") return null;
  return peer;
}

/** H2.14：模型从群成员里选 1～3 人；失败回落 daily / 第一人 */
async function pickGroupSpeakers(userText) {
  const peer = currentGroupPeer();
  if (!peer) return { ids: [DEFAULT_PEER_ID], used: 0 };
  const store = readStore();
  const members = (Array.isArray(peer.members) ? peer.members : [])
    .map((mid) => normalizePeerId(mid))
    .filter((id) => (store.peers || []).some((p) => p && p.id === id));
  const allowed = members.length ? members : [DEFAULT_PEER_ID];
  const roster = allowed.map((id) => {
    const meta = resolveGroupMemberMeta(id);
    return (
      "- " +
      meta.id +
      "｜" +
      meta.name +
      (meta.persona ? "｜" + meta.persona.slice(0, 120) : "")
    );
  });
  try {
    const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
    const system =
      "你是群聊选人助手。只能从给定成员 id 里选 1～3 个该回消息的人。" +
      '只输出 JSON：{"ids":["id1",...]}，不要解释、不要 markdown。';
    const user =
      "群名：" +
      (peer.name || peer.id) +
      "\n成员：\n" +
      roster.join("\n") +
      "\n\n用户刚说：\n" +
      String(userText || "").trim().slice(0, 400);
    const out = await chatCompletion({
      system,
      user,
      think: false,
      replyKind: "chat",
    });
    const parsed = parseThinkBody(out.content, false);
    const body = String((parsed && parsed.body) || out.content || "");
    const used =
      (Number(out.tokens_in) || 0) + (Number(out.tokens_out) || 0);
    return { ids: parseSpeakerPickIds(body, allowed), used };
  } catch (_) {
    return {
      ids: parseSpeakerPickIds("", allowed),
      used: 0,
    };
  }
}

async function runBotReplyStream(write, you, opts) {
  const {
    observeUserText,
    decideReplyGate,
    sleep,
    maybeCalibrateMood,
  } = require("./mood");
  if (!(opts && opts.skipObserve)) {
    const observe =
      (opts && opts.observeText) != null
        ? String(opts.observeText)
        : observeTextForMessage(you);
    if (observe) {
      observeUserText(observe);
      /* H2.9：大波动才 LLM 选词；未配置/失败不挡接话 */
      try {
        const bud = ensureBudget();
        if (!budgetExhausted(bud)) {
          const cal = await maybeCalibrateMood(observe);
          if (cal && cal.used) addTokensUsed(cal.used);
        }
      } catch (_) {}
    }
  }

  const prefs = getChatPrefs();
  const gate = decideReplyGate({
    slowReply: prefs.slow_reply !== false,
    coalesced: !!(opts && opts.coalesced),
    peerId: currentPeerId(),
  });
  if (gate.skip) {
    const messages = listMessages().messages;
    const mood = moodPublicSnap();
    await write({
      type: "done",
      ok: true,
      message: you || null,
      bot_message: null,
      bot_error: null,
      skipped: true,
      skip_reason: "mood_cold",
      messages,
      mood,
    });
    return {
      ok: true,
      message: you || null,
      bot_message: null,
      bot_error: null,
      skipped: true,
      skip_reason: "mood_cold",
      messages,
      mood,
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
    const mood = moodPublicSnap();
    await write({
      type: "done",
      ok: true,
      message: you || null,
      bot_message: null,
      bot_error,
      messages,
      mood,
    });
    return {
      ok: true,
      message: you || null,
      bot_message: null,
      bot_error,
      messages,
      mood,
    };
  }

  let bot_message = null;
  let bot_error = null;
  try {
    const hist = listMessages().messages;
    let prior = buildChatPrior(hist, you);
    if (opts && opts.extraUser) {
      prior = prior.concat([{ role: "user", content: String(opts.extraUser) }]);
    }
    if (gate.delayMs > 0) await sleep(gate.delayMs);
    const memQuery =
      (opts && opts.observeText) != null
        ? String(opts.observeText)
        : observeTextForMessage(you);
    const groupPeer = currentGroupPeer();
    if (groupPeer) {
      /* H2.14：模型选 1～3 人，串行各回一句；工具关闭 */
      const pick = await pickGroupSpeakers(memQuery);
      if (pick.used) addTokensUsed(pick.used);
      const speakers = pick.ids.length
        ? pick.ids
        : parseSpeakerPickIds("", groupPeer.members || []);
      let lastText = "";
      for (let i = 0; i < speakers.length; i++) {
        const sid = speakers[i];
        const meta = resolveGroupMemberMeta(sid);
        await write({
          type: "bot_start",
          speaker_id: meta.id,
          speaker_name: meta.name,
        });
        const { text, thinkExtra, used } = await streamBotReply(write, prior, {
          moodPrompt: gate.moodPrompt,
          memoryQuery: memQuery,
          speakerId: meta.id,
          speakerName: meta.name,
          speakerPersona: meta.persona,
          disableTools: true,
        });
        const extra = Object.assign({}, thinkExtra, {
          payload: {
            speaker_id: meta.id,
            speaker_name: meta.name,
          },
        });
        let shown = await applyProactiveCallTag(write, text);
        shown = await applyGiftTag(write, shown);
        bot_message = appendMessage("bot", shown, "text", extra);
        addTokensUsed(used > 0 ? used : 400);
        await write({ type: "bot_done", message: bot_message });
        lastText = shown;
        prior = prior.concat([
          {
            role: "assistant",
            content: "「" + meta.name + "」：" + shown,
          },
        ]);
      }
      try {
        const { maybeExtractMemory } = require("./memory");
        if (memQuery) maybeExtractMemory(currentPeerId(), memQuery);
      } catch (_) {}
      const bot_money = maybeBotMoney(you, lastText);
      if (bot_money) await write({ type: "bot_money", message: bot_money });
      const bot_sticker = maybeBotSticker(you, lastText);
      if (bot_sticker) await write({ type: "bot_sticker", message: bot_sticker });
      const bot_voice = maybeBotVoice(you);
      if (bot_voice) await write({ type: "bot_voice", message: bot_voice });
      if (you) await maybeBotReact(write, you, opts);
      if (bot_message) await maybeBotSelfRecall(write, bot_message, opts);
    } else {
      await write({ type: "bot_start" });
      const { text, thinkExtra, used } = await streamBotReply(write, prior, {
        moodPrompt: gate.moodPrompt,
        memoryQuery: memQuery,
        systemExtra: opts && opts.systemExtra,
      });
      let shown = await applyProactiveCallTag(write, text);
      shown = await applyGiftTag(write, shown);
      bot_message = appendMessage("bot", shown, "text", thinkExtra);
      addTokensUsed(used > 0 ? used : 400);
      await write({ type: "bot_done", message: bot_message });
      try {
        const { maybeExtractMemory } = require("./memory");
        if (memQuery) maybeExtractMemory(currentPeerId(), memQuery);
      } catch (_) {}
      const bot_money = maybeBotMoney(you, shown);
      if (bot_money) await write({ type: "bot_money", message: bot_money });
      const bot_sticker = maybeBotSticker(you, shown);
      if (bot_sticker) await write({ type: "bot_sticker", message: bot_sticker });
      const bot_voice = maybeBotVoice(you);
      if (bot_voice) await write({ type: "bot_voice", message: bot_voice });
      if (you) await maybeBotReact(write, you, opts);
      if (bot_message) await maybeBotSelfRecall(write, bot_message, opts);
    }
  } catch (e) {
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "家机暂时接不上",
    };
    await write({ type: "bot_error", ...bot_error });
  }

  const messages = listMessages().messages;
  const mood = moodPublicSnap();
  await write({
    type: "done",
    ok: true,
    message: you || null,
    bot_message,
    bot_error,
    messages,
    mood,
  });
  return {
    ok: true,
    message: you || null,
    bot_message,
    bot_error,
    messages,
    mood,
  };
}

/**
 * 你侧落库后请家机流式接一句（A-daily）。LLM / 额度失败不回滚你侧。
 * H1.17′：随机 1–12s 后再回；不顶掉上路。等完若有更新的你侧短讯则本条 deferred。
 * emit: you → … → done（deferred:true 时本条不回，由更新那条带上下文）
 */
function forwardBatchNote(batch) {
  const lines = Array.isArray(batch)
    ? batch.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  if (lines.length < 2) return "";
  return (
    "（系统：下面这几条是同一次转发，按顺序一起到的。请综合着回一次，把里面的点都照顾到，不要只接最后一句。）\n" +
    lines.map((t, i) => i + 1 + ". " + t.slice(0, 400)).join("\n")
  );
}

async function createMessageWithReplyStream(patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const youRes = createMessage(patch);
  const you = youRes.message;
  const batchNote = forwardBatchNote(patch && patch.batch);
  await write({
    type: "you",
    ok: true,
    message: you,
    wallet: youRes.wallet || undefined,
  });

  await emitMoneyClaim(you, write);

  const { observeUserText, sleep } = require("./mood");
  const obs = observeTextForMessage(you);
  if (obs) observeUserText(obs);

  /* 你拉黑对方 / 消息带感叹号：不接话 */
  if ((you && you.blocked_send) || youBlockedPeer()) {
    const messages = listMessages().messages;
    await write({
      type: "done",
      ok: true,
      message: you,
      bot_message: null,
      skipped: true,
      reason: "you_blocked",
      messages,
    });
    return {
      ok: true,
      message: you,
      bot_message: null,
      skipped: true,
      reason: "you_blocked",
      messages,
    };
  }
  if (peerBlocksYou()) {
    const soft = maybeSoftUnblockFromText(obs || (you && you.body) || "");
    if (!soft) {
      const messages = listMessages().messages;
      await write({
        type: "done",
        ok: true,
        message: you,
        bot_message: null,
        skipped: true,
        reason: "blocks_you",
        blocks_you: true,
        messages,
      });
      return {
        ok: true,
        message: you,
        bot_message: null,
        skipped: true,
        reason: "blocks_you",
        messages,
      };
    }
  }

  if (!messageWaitsForCoalesce(you)) {
    return exclusiveBotReply(() =>
      runBotReplyStream(write, you, {
        skipObserve: true,
        extraUser: batchNote || undefined,
      })
    );
  }

  const prefs = getChatPrefs();
  await sleep(coalesceWaitMs(prefs));
  if (hasNewerYouMessage(you)) {
    const messages = listMessages().messages;
    await write({
      type: "done",
      ok: true,
      message: you,
      bot_message: null,
      deferred: true,
      messages,
    });
    return {
      ok: true,
      message: you,
      bot_message: null,
      deferred: true,
      messages,
    };
  }
  return exclusiveBotReply(() =>
    runBotReplyStream(write, you, {
      skipObserve: true,
      coalesced: true,
      extraUser: batchNote || undefined,
    })
  );
}

/** 撤回后家机接一句（SSE）；opts.screenshotUrl = 客户端抓拍的真气泡图 */
async function recallMessageWithReplyStream(id, emit, opts) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const recalled = recallMessage(id);
  let sight = decideRecallSight(
    recalled.snap,
    opts && opts.forceSight ? String(opts.forceSight) : ""
  );
  /* 客户端带来真截图 → 走调侃发图，别随机成 miss/silent 白拍了 */
  const shotReady = resolveRecallScreenshotUrl({ mode: "roast" }, opts);
  if (shotReady && !recalled.already) {
    sight = {
      mode: "roast",
      body: String((recalled.snap && recalled.snap.body) || ""),
      kind: String((recalled.snap && recalled.snap.kind) || "text"),
    };
  }
  await write({
    type: "you_recall",
    ok: true,
    message: recalled.message,
    already: !!recalled.already,
    sight: sight.mode,
  });
  if (recalled.already) {
    const messages = listMessages().messages;
    await write({
      type: "done",
      ok: true,
      message: recalled.message,
      bot_message: null,
      bot_error: null,
      skipped: true,
      skip_reason: "already_recalled",
      messages,
    });
    return {
      ok: true,
      message: recalled.message,
      already: true,
      bot_message: null,
      messages,
    };
  }

  if (sight.mode === "miss") {
    return exclusiveBotReply(() =>
      runBotReplyStream(write, null, {
        skipBotRecall: true,
        observeText: "（对方撤回了一条消息）",
        extraUser:
          "（系统：对方刚撤回一条消息，你没看清内容。用一两句口语接住即可，不要猜测原文，不要装看见了。）",
      })
    );
  }

  if (sight.mode === "silent") {
    const hint = sight.body
      ? "你其实看见了，原文是：「" + sight.body.slice(0, 200) + "」。"
      : "你其实看见了撤回前的内容。";
    return exclusiveBotReply(() =>
      runBotReplyStream(write, null, {
        skipBotRecall: true,
        observeText: "（对方撤回了一条消息）",
        extraUser:
          "（系统：" +
          hint +
          "心照不宣：不要引用原文、不要截图、不要点破；可淡淡回一句，或几乎不提撤回。）",
      })
    );
  }

  /* roast：有真截图就先发图，再调侃 */
  const shot = resolveRecallScreenshotUrl(sight, opts);
  if (shot) {
    try {
      const imgMsg = appendMessage("bot", shot, "image");
      await write({ type: "bot_image", message: imgMsg });
    } catch (_) {
      /* 贴纸非 media URL 时 append 可能失败，改走纯文字调侃 */
    }
  }
  const bodyHint = sight.body
    ? "撤回原文：「" + sight.body.slice(0, 200) + "」。"
    : "";
  const shotHint = shot
    ? "你已经把聊天截图（图片消息）发给对方看了，对方能在聊天里看到那张图。"
    : "截图没发出去：禁止说「我截图了/存证了」，只口头提你看见的内容即可。";
  return exclusiveBotReply(() =>
    runBotReplyStream(write, null, {
      skipBotRecall: true,
      observeText: "（对方撤回了一条消息）",
      extraUser:
        "（系统：你看见了对方撤回的内容。" +
        shotHint +
        bodyHint +
        "用一两句口语调侃/接话，不要长篇。）",
    })
  );
}

const TIME_GAP_MS = 60 * 60 * 1000; /* ≥1h 插时间标记（H1.16 / Wave14） */

function formatHistoryGapHint(ms) {
  const hours = Math.max(1, Math.round(Number(ms) / 3600000));
  if (hours < 24) {
    return "[系统提示: 以上对话发生在约 " + hours + " 小时前。以下是更近的对话。]";
  }
  const days = Math.max(1, Math.round(hours / 24));
  return "[系统提示: 以上对话发生在约 " + days + " 天前。以下是更近的对话。]";
}

function pushHistoryGap(prior, lastTs, nextTs) {
  const a = Number(lastTs) || 0;
  const b = Number(nextTs) || 0;
  if (!a || !b || b - a < TIME_GAP_MS) return;
  prior.push({ role: "user", content: formatHistoryGapHint(b - a) });
}

/** H1.20：中文多 → 译英；拉丁多 → 译中 */
function detectTranslateTarget(text) {
  const raw = String(text || "");
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (raw.match(/[A-Za-z]/g) || []).length;
  return letters > cjk ? "zh" : "en";
}

/**
 * 短讯翻译（不落库）。think:false。
 * @param {string} text
 * @param {string} [forceTo] zh|en|ja|ko；空则自动中↔英
 * @returns {Promise<{ ok: true, text: string, translation: string, to: string }>}
 */
async function translateChatText(text, forceTo) {
  const raw = String(text || "").trim().slice(0, 800);
  if (!raw) {
    const err = new Error("没有可翻译的文字");
    err.code = "bad_translate";
    throw err;
  }
  if (
    raw === "[图片]" ||
    raw === "[贴纸]" ||
    /^\[(红包|转账|位置|工具)/.test(raw)
  ) {
    const err = new Error("这类消息暂不翻译");
    err.code = "bad_translate_kind";
    throw err;
  }
  const forced = String(forceTo || "")
    .trim()
    .toLowerCase();
  const to = ["zh", "en", "ja", "ko"].includes(forced)
    ? forced
    : detectTranslateTarget(raw);
  const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
  const system =
    "你是翻译助手。只输出译文本身，不要解释、不要加引号、不要标注语言名。";
  let user;
  if (to === "zh") user = "把下面内容译成简体中文：\n" + raw;
  else if (to === "ja") user = "次の内容を自然な日本語に訳してください：\n" + raw;
  else if (to === "ko") user = "다음 내용을 자연스러운 한국어로 번역하세요:\n" + raw;
  else user = "Translate the following into natural English:\n" + raw;
  const out = await chatCompletion({
    system,
    user,
    think: false,
    replyKind: "chat",
  });
  const parsed = parseThinkBody(out.content, false);
  const translation = String((parsed && parsed.body) || out.content || "")
    .trim()
    .replace(/^["「『]|["」』]$/g, "");
  if (!translation) {
    const err = new Error("翻译失败");
    err.code = "translate_empty";
    throw err;
  }
  return { ok: true, text: raw, translation, to };
}

/** 构建 LLM prior；excludeId 跳过该条（重生时跳过旧家机气泡） */
function buildChatPrior(hist, youOrNull, excludeId) {
  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const toolsOn = settings.chat_tools_enabled !== false;
  const skip = excludeId ? String(excludeId) : "";
  const youId = youOrNull && youOrNull.id ? String(youOrNull.id) : "";
  const prior = [];
  const cut = getArchiveBeforeTs();
  const base = Array.isArray(hist) ? hist : [];
  const visible =
    cut > 0 ? base.filter((m) => (Number(m && m.ts) || 0) > cut) : base;
  const slice = visible.slice(-HISTORY);
  const recentImgs = listRecentYouImages(8);
  const pickById = new Map(recentImgs.map((x) => [x.id, x.pick]));
  /* ponytail: 最多 6 张真图进视觉，其余只带编号+url 文案 */
  const visionLeft = { n: 6 };
  let lastTs = null;
  for (const m of slice) {
    if (!m) continue;
    if (skip && m.id === skip) continue;
    if (youId && m.id === youId) continue;
    if (m.kind === "tool" || m.kind === "sys") continue;
    if (m.payload && m.payload.is_receipt) continue;
    const ts = Number(m.ts) || 0;
    if (lastTs != null) pushHistoryGap(prior, lastTs, ts);
    if (m.from === "bot") {
      const am = { role: "assistant", content: llmContent(m) };
      if (toolsOn) am.reasoning_content = m.think || "";
      prior.push(am);
    } else if (m.kind === "image") {
      prior.push({
        role: "user",
        content: userImagePriorContent(m, pickById, visionLeft),
      });
    } else {
      prior.push({ role: "user", content: llmContent(m) });
    }
    if (ts) lastTs = ts;
  }
  if (youOrNull) {
    const yTs = Number(youOrNull.ts) || Date.now();
    if (lastTs != null) pushHistoryGap(prior, lastTs, yTs);
    if (youOrNull.kind === "image") {
      prior.push({
        role: "user",
        content: userImagePriorContent(youOrNull, pickById, visionLeft),
      });
    } else {
      prior.push({ role: "user", content: llmContent(youOrNull) });
    }
  }
  return prior;
}

function thinkExtraFromParts(joined, sec, tools) {
  const thinkExtra = {};
  const text = String(joined || "").trim();
  if (text) thinkExtra.think = text.slice(0, 12000);
  if (sec > 0) thinkExtra.think_sec = Math.round(sec * 10) / 10;
  if (tools && tools.length) thinkExtra.tools = tools;
  return thinkExtra;
}
console.assert(!thinkExtraFromParts("", 1.2).think && thinkExtraFromParts("", 1.2).think_sec === 1.2);
console.assert(thinkExtraFromParts("x", 0).think === "x" && !thinkExtraFromParts("x", 0).think_sec);

/**
 * 流式跑一轮家机文字（含工具）。emit bot_delta / bot_think / bot_tool*。
 * 不写库；调用方负责 append / appendVariant。
 */
async function streamBotReply(write, priorIn, opts) {
  const { chatCompletionStream, parseThinkBody, resolveThinkText } = require(
    "../../共读app/gateway/llm"
  );
  const { readSettings, resolveAppPersona } = require("../../共读app/gateway/settings");
  const {
    MAX_TOOL_ROUNDS,
    CAM_CHECK_DELAY_SEC,
    runChatTool,
    resolveToolLabel,
    summarizeToolResult,
    formatToolDetail,
    getToolBundle,
    isActionTool,
  } = require("./chat-tools");
  const settings = readSettings();
  const resolved = resolveAppPersona("chat", settings);
  const speakerId = String((opts && opts.speakerId) || "").trim();
  const toolsForcedOff = !!(opts && opts.disableTools);
  const toolsOn = !toolsForcedOff && settings.chat_tools_enabled !== false;
  const toolLabels = settings.chat_tool_labels || {};
  let toolBundle = null;
  if (toolsOn) toolBundle = await getToolBundle(settings);
  const tools = toolBundle && toolBundle.defs.length ? toolBundle.defs : undefined;
  const toolNameSet = new Set(
    (tools || [])
      .map((t) => t && t.function && t.function.name)
      .filter(Boolean)
  );
  let stickyLeaveUsed = 0;
  let autoMemoryOpsUsed = 0;
  let momentsPostsUsed = 0;
  let momentsCommentsUsed = 0;
  let system = DAILY_SYSTEM_BASE;
  system +=
    "对方可能发贴纸、图片、红包、转账或位置；用一两句口语接住即可。" +
    "不要每条都提表情包，也不要说「我发了贴纸/红包」（贴纸与红包由系统按气氛另发）。";
  if (toolsOn && toolNameSet.size) {
    system += buildToolsSystemHint(toolNameSet);
  }
  let peerPersona = "";
  let displayName = "";
  try {
    const store = readStore();
    const pid = currentPeerId();
    const peer = (store.peers || []).find((p) => p && p.id === pid);
    if (speakerId && peer && peer.kind === "group") {
      /* H2.14：以指定成员身份发言 */
      const meta = resolveGroupMemberMeta(speakerId);
      const names = (Array.isArray(peer.members) ? peer.members : [])
        .map((mid) => {
          const m = (store.peers || []).find((x) => x && x.id === mid);
          return m ? m.name : mid;
        })
        .filter(Boolean);
      displayName =
        String((opts && opts.speakerName) || "").trim() || meta.name;
      peerPersona =
        String((opts && opts.speakerPersona) || "").trim() || meta.persona;
      system +=
        "\n你在群聊「" +
        (peer.name || pid) +
        "」里；成员：" +
        (names.join("、") || "家机") +
        "。你的身份是「" +
        displayName +
        "」。只以自己口吻回一句短讯，不要扮演其它成员或用户，不要自称家机（除非你就是家机）。";
    } else if (peer && peer.kind === "group") {
      const names = (Array.isArray(peer.members) ? peer.members : [])
        .map((mid) => {
          const m = (store.peers || []).find((x) => x && x.id === mid);
          return m ? m.name : mid;
        })
        .filter(Boolean);
      system +=
        "\n你在群聊「" +
        (peer.name || pid) +
        "」里发言；成员：" +
        (names.join("、") || "家机") +
        "。以家机身份回短讯，可点名其它成员，勿冒充用户。";
      peerPersona = String(peer.persona || "").trim();
    } else if (peer && peer.id !== DEFAULT_PEER_ID) {
      system +=
        "\n当前会话对象：「" +
        (peer.name || peer.id) +
        "」。你就是对方本人（AI 联系人），按本会话人设说话，勿自称家机。";
      peerPersona = String(peer.persona || "").trim();
    }
  } catch (_) {}
  if (!toolsOn) {
    system +=
      "\n（工具已关闭：不要声称已查手机、已改日历、已看屏幕或已拨电话；可请对方自己去对应 App 看。）";
  } else if (toolBundle) {
    const bits = [];
    if (toolBundle.diyMap && toolBundle.diyMap.size) {
      bits.push("DIY 外部 HTTP");
    }
    if (toolBundle.mcpMap && toolBundle.mcpMap.size) bits.push("外接 MCP");
    if (bits.length) {
      system += "\n（另有" + bits.join(" / ") + "工具可用，名称见工具表。）";
    } else if (toolBundle.mcpError) {
      system +=
        "\n（外接 MCP 暂不可用：" +
        String(toolBundle.mcpError).slice(0, 80) +
        "）";
    }
  }
  /* 非家机会话优先用 peer.persona；家机 / 未填仍走小屋聊天人设 */
  const card = peerPersona
    ? peerPersona
    : String((resolved && resolved.persona_card) || "").trim();
  if (card) {
    /* ponytail: 聊天人设硬截 4000，与跟批同级；以后要省额度再加开关 */
    system += "\n人设（请遵守，勿整段复述）：\n" + card.slice(0, 4000);
  }
  if (displayName) {
    system += "\n你的显示名：" + displayName + "。";
  } else {
    const nameBot = String(settings.name_bot || "").trim();
    if (nameBot) system += "\n你的显示名：" + nameBot + "。";
  }
  const moodPrompt = opts && opts.moodPrompt ? String(opts.moodPrompt).trim() : "";
  if (moodPrompt) system += "\n" + moodPrompt;
  const systemExtra =
    opts && opts.systemExtra ? String(opts.systemExtra).trim() : "";
  if (systemExtra) system += "\n" + systemExtra;
  if (settings.call_proactive_enabled) {
    system +=
      "\n若要主动打来电，在回复末尾单独一行写 [[call:voice]] 或 [[call:video]]（不要口头假装已拨）；也可调 start_call。";
  }
  if (settings.call_gift_enabled) {
    system +=
      "\n视频通话仪式礼物（无支付）：可在回复末尾写 [[gift:1]]～[[gift:5]]" +
      "（1小心心 2花束 3夏日烟火 4流星雨 5银河铁道之夜），每条最多一枚；勿提花钱。";
  }
  try {
    const { buildPocketKeyPrompt } = require("../../资产app/gateway/pocket-keys");
    const keyPrompt = buildPocketKeyPrompt();
    if (keyPrompt) system += "\n" + keyPrompt;
  } catch (_) {
    /* 零花钥事实可选 */
  }
  try {
    if (topicMemoryInjectEnabled()) {
      const { buildMemoryPrompt } = require("./memory");
      const memPrompt = await buildMemoryPrompt(
        currentPeerId(),
        opts && opts.memoryQuery
      );
      if (memPrompt) system += "\n" + memPrompt;
    }
  } catch (_) {
    /* 记忆模块异常不挡接话 */
  }
  try {
    if (settings.auto_memory_enabled) {
      const { buildAutoMemoryPrompt, clampBudget } = require("./auto-memory");
      const amPrompt = buildAutoMemoryPrompt(currentPeerId(), {
        mute: !!settings.auto_memory_mute,
        budget: clampBudget(settings.auto_memory_budget),
      });
      if (amPrompt) system += "\n" + amPrompt;
    }
  } catch (_) {
    /* 档案模块异常不挡接话 */
  }
  system += "\n" + buildNowPrompt();
  system += "\n" + buildTodayPrompt();
  {
    const neu = buildNewCalPrompt();
    if (neu) system += "\n" + neu;
  }
  try {
    const {
      buildMusicContextPrompt,
    } = require("../../共听app/gateway/music-session");
    const musicCtx = buildMusicContextPrompt();
    if (musicCtx) system += "\n" + musicCtx;
  } catch (_) {
    /* 共听上下文可选 */
  }
  system +=
    "\n对话历史里若出现「以上对话发生在约…前」的系统提示，那些是旧对话；" +
    "不要让旧对话的情绪盖过你当前的心情状态。对方当前这条消息才是前景。";

  const prior = Array.isArray(priorIn) ? priorIn.slice() : [];
  try {
    const { appendWorldbookForChat } = require("../../共读app/gateway/world");
    system = appendWorldbookForChat(system, prior, settings);
  } catch (_) {
    /* 世界书模块异常时不挡接话 */
  }
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
    let roundHadFetch = false;
    for (const tc of calls) {
      const name = (tc.function && tc.function.name) || "";
      const label = resolveToolLabel(name, toolLabels);
      await write({ type: "bot_tool", name, label });
      if (name === "cam_check") {
        const sec = CAM_CHECK_DELAY_SEC;
        try {
          require("../../共读app/gateway/ws-hub").broadcastMonitorAlert(
            "家机要看一眼屏幕",
            { kind: "cam_check", seconds: sec }
          );
        } catch (_) {}
        await write({ type: "cam_check_wait", seconds: sec });
        await new Promise((r) => setTimeout(r, sec * 1000));
      }
      const ran = await runChatTool(name, tc.function && tc.function.arguments, {
        mcpMap: toolBundle && toolBundle.mcpMap,
        diyMap: toolBundle && toolBundle.diyMap,
        settings,
        stickyLeaveUsed,
        autoMemoryOpsUsed,
        momentsPostsUsed,
        momentsCommentsUsed,
        peerId: currentPeerId(),
      });
      let actionOnly = isActionTool(name);
      try {
        const o = JSON.parse(ran.result || "");
        if (o && o.needs_confirm) actionOnly = true;
      } catch (_) {}
      if (!actionOnly) roundHadFetch = true;
      if (name === "sticky_leave_note" && ran.ok) stickyLeaveUsed += 1;
      if (
        (name === "auto_memory_upsert" || name === "auto_memory_delete") &&
        ran.ok
      ) {
        autoMemoryOpsUsed += 1;
      }
      if (name === "moments_post" && ran.ok) momentsPostsUsed += 1;
      if (name === "moments_comment" && ran.ok) momentsCommentsUsed += 1;
      const summary = summarizeToolResult(ran.name, ran.result, !!ran.ok);
      const detail = formatToolDetail(ran.result);
      const meta = {
        name: ran.name,
        label,
        summary,
        ok: !!ran.ok,
      };
      if (detail) meta.detail = detail;
      toolMetas.push(meta);
      await write({
        type: "bot_tool_done",
        name: ran.name,
        label,
        ok: !!ran.ok,
        summary,
        detail: detail || undefined,
      });
      if (name === "share_music" && ran.ok) {
        try {
          const o = JSON.parse(ran.result);
          if (o && o.message) await write({ type: "bot_music", message: o.message });
        } catch (_) {}
      }
      if (name === "start_call" && ran.ok) {
        try {
          const o = JSON.parse(ran.result);
          if (o && o.message) await write({ type: "bot_call", message: o.message });
        } catch (_) {}
      }
      if (name === "set_avatar" && ran.ok) {
        try {
          const o = JSON.parse(ran.result);
          if (o && o.url) {
            await write({
              type: "avatar_changed",
              who: o.who || "bot",
              url: o.url,
              peerId: o.peerId || "",
            });
          }
        } catch (_) {}
      }
      /* 动作类：成败短回传，不喂进下一轮续答（取数类仍喂） */
      prior.push({
        role: "tool",
        tool_call_id: tc.id,
        content: actionOnly
          ? JSON.stringify({
              ok: !!ran.ok,
              summary,
              action: true,
            })
          : ran.result,
      });
    }
    /* 本轮全是动作类 → 不触发续答 */
    if (!roundHadFetch) break;
  }

  if (!text) text = String(streamed || "").trim();
  if (!text && thinkParts.length) text = "嗯。";
  if (!text) {
    const err = new Error("家机没说出话来");
    err.code = "llm_empty";
    throw err;
  }
  const thinkJoined = thinkParts.filter(Boolean).join("\n---\n");
  const thinkExtra = thinkExtraFromParts(thinkJoined, thinkSecTotal, toolMetas);
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
    const { text, thinkExtra, used } = await streamBotReply(write, prior, {
      memoryQuery: you ? observeTextForMessage(you) : "",
    });
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

if (require.main === module) {
  (async () => {
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
    detail: '{\n  "events": [\n    { "title": "午觉" }\n  ]\n}',
  });
  console.assert(toolMsg.kind === "tool" && toolMsg.read === true);
  console.assert(toolMsg.payload && toolMsg.payload.summary.includes("2 条"));
  console.assert(toolMsg.payload && toolMsg.payload.detail.includes("午觉"));
  console.assert(llmContent(toolMsg) === "");
  const withTools = appendMessage("bot", "挂工具自检", "text", {
    tools: [
      {
        name: "calendar_list_events",
        label: "查行程",
        summary: "1 条：午觉",
        ok: true,
        detail: '{"events":[{"title":"午觉"}]}',
      },
    ],
  });
  console.assert(
    withTools.tools &&
      withTools.tools[0] &&
      withTools.tools[0].summary.includes("午觉")
  );
  console.assert(
    withTools.tools[0].detail && withTools.tools[0].detail.includes("午觉")
  );
  {
    const { formatToolDetail: fmtDetail } = require("./chat-tools");
    console.assert(
      fmtDetail('{"a":1}').includes("\n") && fmtDetail('{"a":1}').includes('"a"')
    );
  }
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
  const fakeVoice = saveChatMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "audio/webm");
  console.assert(fakeVoice.url && resolveChatMediaPath(fakeVoice.id));
  const voiceMsg = createMessage({
    kind: "voice",
    body: fakeVoice.url,
    durationMs: 3200,
  });
  console.assert(voiceMsg.message.kind === "voice");
  console.assert(voiceMsg.message.payload.durationMs === 3200);
  console.assert(llmContent(voiceMsg.message) === "[语音 3″]");
  /* voiceStub → 示意 stub，不打外网 */
  const stubVoice = appendStubBotVoice(2);
  console.assert(stubVoice.kind === "voice" && stubVoice.payload.voiceStub === true);
  const asrStub = await toggleVoiceTranscript(stubVoice.id);
  console.assert(asrStub.payload.transcriptStub === true);
  console.assert(llmContent(asrStub) === "[语音 2″]");
  console.assert(
    searchMessages({ q: "示意转写" }).messages.some((m) => m.id === asrStub.id)
  );
  /* 假音频：mock transcribe，断言真识别无 stub 且进模型 */
  const asr = await toggleVoiceTranscript(voiceMsg.message.id, {
    transcribe: async () => ({ text: "真转写一句" }),
  });
  console.assert(asr.payload.transcript === "真转写一句");
  console.assert(asr.payload.transcriptStub !== true);
  console.assert(llmContent(asr) === "[语音 3″] 真转写一句");
  const folded = await toggleVoiceTranscript(asr.id);
  console.assert(folded.payload.transcriptHidden === true);
  console.assert(folded.payload.transcript === "真转写一句");
  console.assert(llmContent(folded) === "[语音 3″] 真转写一句");
  console.assert(wantsBotVoice({ from: "you", kind: "text", body: "发一条语音" }));
  const loc = createMessage({ kind: "location", name: "楼下咖啡馆", detail: "靠窗" });
  console.assert(loc.message.kind === "location" && loc.message.payload.name === "楼下咖啡馆");
  const fileMsg = createMessage({ kind: "file", name: "笔记.txt" });
  console.assert(fileMsg.message.kind === "file" && fileMsg.message.payload.fileStub === true);
  console.assert(llmContent(fileMsg.message) === "[文件]");
  console.assert(
    searchMessages({ q: "笔记.txt" }).messages.some((m) => m.id === fileMsg.message.id)
  );
  const fakeDoc = saveChatMedia(
    Buffer.from("hello-file-body"),
    "application/octet-stream",
    "hello.txt"
  );
  console.assert(/\.[a-z0-9]+$/i.test(fakeDoc.id));
  const fileUp = createMessage({
    kind: "file",
    name: "hello.txt",
    url: fakeDoc.url,
    size: 15,
    ext: "txt",
    text: "hello-file-body",
  });
  console.assert(fileUp.message.payload.url === fakeDoc.url);
  console.assert(fileUp.message.payload.fileStub !== true);
  console.assert(String(llmContent(fileUp.message)).includes("hello.txt"));
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, fakeDoc.id));
  } catch (_) {}
  const musicMsg = createMessage({ kind: "music", name: "夜曲.mp3" });
  console.assert(musicMsg.message.kind === "music" && musicMsg.message.payload.musicStub === true);
  console.assert(llmContent(musicMsg.message) === "[音乐]");
  const botSong = appendBotMusic({
    name: "自检点歌",
    artist: "测试",
    source: "selfcheck",
  });
  console.assert(botSong.kind === "music" && botSong.payload.recommended === true);
  console.assert(String(llmContent(botSong)).includes("自检点歌"));
  console.assert(
    searchMessages({ q: "夜曲.mp3" }).messages.some((m) => m.id === musicMsg.message.id)
  );
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
        m.id !== voiceMsg.message.id &&
        m.id !== stubVoice.id &&
        m.id !== loc.message.id &&
        m.id !== fileMsg.message.id &&
        m.id !== musicMsg.message.id &&
        m.id !== botSong.id &&
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
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, fakeVoice.id));
  } catch (_) {}
  try {
    const stubId = String(stubVoice.body || "").split("/").pop();
    if (stubId) fs.unlinkSync(path.join(MEDIA_DIR, stubId));
  } catch (_) {}
  console.assert(isAckText("嗯") && isAckText("好的") && isAckText("哈哈"));
  console.assert(!isAckText("今天吃什么"));
  console.assert(looksLikeNeedsReply("今晚去超市吗？"));
  console.assert(!looksLikeNeedsReply("我先去倒杯水。"));
  const { observeUserText, decideReplyGate, writeMood } = require("./mood");
  writeMood({ pa: 0.4, na: 0.1, updatedAt: Date.now() });
  const fought = observeUserText("你滚 分手吧 我受够了");
  console.assert(fought.mood.na > 0.35);
  const gate = decideReplyGate();
  console.assert(gate.delayMs >= 400);
  const fwdMsg = createMessage({
    body: "fwd-selfcheck-" + Date.now(),
    forward: { who: "家机" },
  });
  console.assert(fwdMsg.message.forward && fwdMsg.message.forward.who === "家机");
  const fwdFile = createMessage({
    kind: "file",
    name: "fwd-file.txt",
    text: "fwd-body",
    forward: { who: "你" },
  });
  console.assert(fwdFile.message.kind === "file" && fwdFile.message.forward.who === "你");
  writeAll({
    messages: readAll().messages.filter(
      (m) => m.id !== fwdMsg.message.id && m.id !== fwdFile.message.id
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });
  const snap2 = readWallet();
  const rp2 = createMessage({ kind: "transfer", amount: 1.01, note: "回执自检" });
  console.assert(rp2.message.payload.status === "sent");
  const claimed = markMoneyReceived(rp2.message.id);
  console.assert(claimed && claimed.payload.status === "received");
  const tipSys = appendSysTip("对方已收款");
  console.assert(tipSys && tipSys.kind === "sys" && tipSys.body === "对方已收款");
  const rcptSelf = appendTransferReceipt("bot", 1.01);
  console.assert(
    rcptSelf &&
      rcptSelf.payload &&
      rcptSelf.payload.is_receipt === true &&
      rcptSelf.payload.status === "received"
  );
  /* H1.81：有 receipt、无 sys → 补种；再跑不重复 */
  const bfTip = "补种灰字-" + stamp;
  const bf = createMessage({ kind: "redpacket", amount: 0.5, note: "补种自检" });
  const bfClaimed = markMoneyReceived(bf.message.id, bfTip);
  console.assert(bfClaimed && bfClaimed.payload.receipt === bfTip);
  writeAll({
    messages: readAll().messages.filter(
      (m) => !(m && m.kind === "sys" && m.body === bfTip)
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });
  if (backfillMoneySysTips() !== true) throw new Error("backfill should insert");
  const afterBf = readAll().messages.filter(
    (m) => m && m.kind === "sys" && m.body === bfTip
  );
  if (afterBf.length !== 1) throw new Error("backfill tip count");
  if (backfillMoneySysTips() !== false) throw new Error("backfill should be idempotent");
  const botPay = createBotMoney("redpacket", 3.5, "自检红包");
  console.assert(botPay && botPay.from === "bot" && botPay.kind === "redpacket");
  writeAll({
    messages: readAll().messages.filter(
      (m) =>
        m.id !== rp2.message.id &&
        m.id !== tipSys.id &&
        m.id !== rcptSelf.id &&
        m.id !== bf.message.id &&
        !(m && m.kind === "sys" && m.body === bfTip) &&
        (!botPay || m.id !== botPay.id)
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
  /* IB M6：peer 限定不得扫全库 */
  console.assert(
    searchMessages({ peer: "daily", from: "2099-01-01", to: "2099-01-01" }).messages
      .length === 0
  );

  const vYou = createMessage({ body: "variant-selfcheck-you-" + Date.now() });
  const vBot = appendMessage("bot", "版本甲");
  const v1 = appendVariantToMessage(vBot.id, { body: "版本乙", think: "想了想乙" });
  console.assert(v1.variants && v1.variants.length === 2);
  console.assert(v1.variantIndex === 1 && v1.body === "版本乙" && v1.think === "想了想乙");
  const v0 = setMessageVariant(vBot.id, 0);
  console.assert(v0.variantIndex === 0 && v0.body === "版本甲");
  try {
    assertRegenTarget(vBot.id);
  } catch (e) {
    throw e;
  }
  const older = appendMessage("bot", "更新的一条");
  try {
    assertRegenTarget(vBot.id);
    throw new Error("expected not_latest");
  } catch (e) {
    if (e.code !== "not_latest") throw e;
  }
  const delOlder = deleteMessage(older.id);
  console.assert(delOlder.ok && delOlder.id === older.id && delOlder.deleted === true);
  console.assert(!listMessages().messages.some((m) => m.id === older.id));
  const vDel = deleteMessage(vBot.id, 0);
  console.assert(vDel.ok && vDel.deleted === false && vDel.message);
  console.assert(vDel.message.body === "版本乙");
  console.assert(!vDel.message.variants);
  console.assert(listMessages().messages.some((m) => m.id === vBot.id));
  console.assert(recallExpired(Date.now() - RECALL_MAX_AGE_MS - 1000) === true);
  console.assert(recallExpired(Date.now() - 1000) === false);
  const recalled = recallMessage(vYou.message.id);
  console.assert(recalled.ok && recalled.message && recalled.message.recalled);
  console.assert(recalled.message.recall_body);
  console.assert(/撤回了：/.test(llmContent(recalled.message)));
  console.assert(messageSearchText(recalled.message) === "");
  console.assert(recalled.snap && recalled.snap.body);
  console.assert(decideRecallSight({ body: "秘密", kind: "text" }, "miss").mode === "miss");
  console.assert(decideRecallSight({ body: "秘密", kind: "text" }, "silent").mode === "silent");
  console.assert(decideRecallSight({ body: "秘密", kind: "text" }, "roast").mode === "roast");
  console.assert(decideBotRecallYouSight({ body: "溜了" }, "miss").mode === "miss");
  console.assert(decideBotRecallYouSight({ body: "溜了" }, "peek").mode === "peek");
  console.assert(decideBotRecallYouSight({ body: "溜了" }, "peek").body === "溜了");
  const botLine = appendMessage("bot", "bot-recall-selfcheck-" + Date.now(), "text");
  const botRec = recallMessage(botLine.id, { from: "bot", forceSight: "peek" });
  console.assert(botRec.message.recalled && botRec.message.recall_sight === "peek");
  console.assert(botRec.message.peek_body && botRec.message.peek_body.includes("bot-recall"));
  console.assert(botRec.message.recall_body && botRec.message.recall_body.includes("bot-recall"));
  console.assert(/对方撤回了：/.test(llmContent(botRec.message)));
  console.assert(messageSearchText(botRec.message) === "");
  writeAll({
    messages: readAll().messages.filter((m) => m.id !== botLine.id),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });
  console.assert(detectTranslateTarget("hello world") === "zh");
  console.assert(detectTranslateTarget("你好呀") === "en");
  console.assert(detectTranslateTarget("好的好的") === "en");
  console.assert(extractCallTag("嗨\n[[call:voice]]").media === "voice");
  console.assert(extractCallTag("嗨\n[[call:voice]]").text === "嗨");
  console.assert(extractCallTag("x [[call:video]]").media === "video");
  try {
    recallMessage(vBot.id);
    throw new Error("expected not_yours");
  } catch (e) {
    if (e.code !== "not_yours") throw e;
  }
  writeAll({
    messages: readAll().messages.filter(
      (m) => m.id !== vYou.message.id && m.id !== vBot.id
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });

  const t0 = Date.now() - 5 * 3600000;
  const t1 = Date.now();
  const gapPrior = buildChatPrior(
    [
      { id: "g1", from: "you", kind: "text", body: "早", ts: t0 },
      { id: "g2", from: "bot", kind: "text", body: "早呀", ts: t0 + 1000 },
      { id: "g3", from: "you", kind: "text", body: "现在", ts: t1 },
    ],
    null
  );
  console.assert(
    gapPrior.some((p) => /系统提示/.test(p.content || "") && /小时前/.test(p.content || ""))
  );
  console.assert(!formatHistoryGapHint(30 * 60 * 1000).includes("天前"));
  console.assert(/天前/.test(formatHistoryGapHint(50 * 3600000)));
  console.assert(messageWaitsForCoalesce({ kind: "text" }));
  console.assert(messageWaitsForCoalesce({ kind: "image" }));
  console.assert(!messageWaitsForCoalesce({ kind: "redpacket" }));
  console.assert(!messageWaitsForCoalesce({ kind: "transfer" }));
  const todayP = buildTodayPrompt();
  console.assert(/^\[TODAY\]/.test(todayP) && /今天是/.test(todayP));
  console.assert(/^\[NOW\]/.test(buildNowPrompt()) && /现在是/.test(buildNowPrompt()));
  for (let i = 0; i < 30; i++) {
    const w = coalesceWaitMs({ slow_reply: true });
    console.assert(w >= 1000 && w <= 12000);
  }
  const fast = coalesceWaitMs({ slow_reply: false });
  console.assert(fast >= 200 && fast <= 700);

  const callOut = startChatCall("voice", "out");
  console.assert(callOut.message.kind === "call" && callOut.message.from === "you");
  console.assert(callOut.message.body === "等待对方接听");
  console.assert(callOut.message.payload.dir === "out");
  console.assert(formatCallClock(342) === "05:42");
  const callOutEnd = setChatCallPhase(callOut.message.id, {
    phase: "ended",
    durationSec: 342,
  });
  console.assert(callOutEnd.body === "通话时长 05:42");
  const callIn = startChatCall("voice", "in");
  console.assert(callIn.message.from === "bot");
  console.assert(callIn.message.body === "家机邀请你语音通话");
  const callAns = setChatCallPhase(callIn.message.id, { phase: "answered" });
  console.assert(callAns.body === "已接听");
  const callAct = setChatCallPhase(callIn.message.id, {
    phase: "active",
    durationSec: 3,
  });
  console.assert(callAct.body === "通话中 00:03");
  const callVid = startChatCall("video", "in");
  console.assert(callVid.message.body === "家机邀请你视频通话");
  writeAll({
    messages: readAll().messages.filter(
      (m) =>
        m.id !== callOut.message.id &&
        m.id !== callIn.message.id &&
        m.id !== callVid.message.id
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });

  const reactYou = createMessage({ body: "react-selfcheck-" + Date.now() });
  const reacted = toggleMessageReaction(reactYou.message.id, "❤️", "you");
  console.assert(
    reacted.reactions &&
      reacted.reactions.some((r) => r.from === "you" && r.emoji === "❤️")
  );
  console.assert(/表情:爱心/.test(llmContent(reacted)));
  const reactedFree = toggleMessageReaction(reactYou.message.id, "🥹x", "you");
  console.assert(
    reactedFree.reactions &&
      reactedFree.reactions.some((r) => r.from === "you" && r.emoji === "🥹")
  );
  const unreacted = toggleMessageReaction(reactYou.message.id, "🥹", "you");
  console.assert(!unreacted.reactions || !unreacted.reactions.length);
  writeAll({
    messages: readAll().messages.filter((m) => m.id !== reactYou.message.id),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });

  const patYou = createPat({ target: "bot", suffix: "的脑袋", forceBotPat: true });
  console.assert(patYou.message.kind === "pat");
  console.assert(patYou.message.body === "你拍了拍家机的脑袋");
  console.assert(/拍了拍/.test(llmContent(patYou.message)));
  console.assert(
    !searchMessages({ q: "拍了拍" }).messages.some(
      (m) => m.id === patYou.message.id
    )
  );
  console.assert(patYou.bot_pat && patYou.bot_pat.from === "bot");
  const patSelf = createPat({ target: "you", suffix: "", forceBotPat: true });
  console.assert(patSelf.message.body === "你拍了拍自己");
  console.assert(!patSelf.bot_pat);
  writeAll({
    messages: readAll().messages.filter(
      (m) =>
        m.id !== patYou.message.id &&
        (!patYou.bot_pat || m.id !== patYou.bot_pat.id) &&
        m.id !== patSelf.message.id
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });

  /* IB M7 封档线：cut 及更早不进 prior */
  const archA = createMessage({ body: "archive-old-" + Date.now() });
  const archB = createMessage({ body: "archive-new-" + Date.now() });
  setArchiveAtMessage(archA.message.id);
  console.assert(getArchiveBeforeTs() === (Number(archA.message.ts) || 0));
  const archPrior = buildChatPrior(
    [archA.message, archB.message],
    null
  );
  console.assert(
    !archPrior.some((p) => String(p.content || "").includes("archive-old-"))
  );
  console.assert(
    archPrior.some((p) => String(p.content || "").includes("archive-new-"))
  );
  setArchiveBeforeTs(0);
  writeAll({
    messages: readAll().messages.filter(
      (m) => m.id !== archA.message.id && m.id !== archB.message.id
    ),
    tokens_used: readAll().tokens_used,
    budget_tokens: readAll().budget_tokens,
    last_poke_day: readAll().last_poke_day,
    poke_count: readAll().poke_count,
  });

  const beforeClear = readAll();
  createMessage({ body: "clear-selfcheck-" + Date.now() });
  const cleared = clearChatMessages();
  console.assert(cleared.ok && cleared.removed >= 1);
  console.assert(listMessages().messages.length === 0);
  console.assert(getChatPrefs().slow_reply === (beforeClear.slow_reply !== false));
  writeAll(beforeClear);

  /* H7 话题频道 */
  const topicMade = createTopic(DEFAULT_PEER_ID, {
    title: "H7话题-" + Date.now(),
    memory_inject: false,
  });
  console.assert(topicMade.ok && topicMade.topic && topicMade.topic.id);
  console.assert(topicMade.topic.memory_inject === false);
  const tid = topicMade.topic.id;
  setActiveTopic(DEFAULT_PEER_ID, tid);
  withPeerTopic(DEFAULT_PEER_ID, tid, () => {
    const m = createMessage({ body: "topic-only-" + Date.now() });
    console.assert(m.message && listMessages().topicId === tid);
    console.assert(topicMemoryInjectEnabled() === false);
  });
  withPeer(DEFAULT_PEER_ID, () => {
    console.assert(
      !listMessages().messages.some((m) =>
        String(m.body || "").includes("topic-only-")
      )
    );
  });
  updateTopic(DEFAULT_PEER_ID, tid, { memory_inject: true, title: "H7改名" });
  console.assert(
    listTopics(DEFAULT_PEER_ID).topics.find((t) => t.id === tid).title === "H7改名"
  );
  deleteTopic(DEFAULT_PEER_ID, tid);
  console.assert(!listTopics(DEFAULT_PEER_ID).topics.some((t) => t.id === tid));

  console.log("daily-chat ok");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  listMessages,
  searchMessages,
  createMessage,
  createPat,
  createMessageWithReply,
  createMessageWithReplyStream,
  parseSpeakerPickIds,
  pickGroupSpeakers,
  recallMessageWithReplyStream,
  regenerateMessageStream,
  setMessageVariant,
  deleteMessage,
  recallMessage,
  recallExpired,
  RECALL_MAX_AGE_MS,
  toggleMessageReaction,
  toggleVoiceTranscript,
  appendStubBotVoice,
  maybeBotVoice,
  appendVariantToMessage,
  assertRegenTarget,
  appendMessage,
  appendBotMusic,
  appendToolMessage,
  unreadCount,
  markAllRead,
  pokeDaily,
  buildToolsSystemHint,
  getChatPrefs,
  setChatPrefs,
  clearChatMessages,
  readAll,
  writeAll,
  listStickers,
  listAllStickers,
  saveChatMedia,
  resolveChatMediaPath,
  markMoneyReceived,
  claimIncomingMoney,
  getArchiveBeforeTs,
  setArchiveBeforeTs,
  setArchiveAtMessage,
  buildChatPrior,
  buildTodayPrompt,
  buildNowPrompt,
  buildNewCalPrompt,
  coalesceWaitMs,
  hasNewerYouMessage,
  decideRecallSight,
  decideBotRecallYouSight,
  maybeBotSelfRecall,
  maybeBotReact,
  detectTranslateTarget,
  translateChatText,
  REACTION_EMOJI,
  startChatCall,
  setChatCallPhase,
  finishChatCallStream,
  extractCallTag,
  applyProactiveCallTag,
  applyGiftTag,
  formatCallClock,
  callDisplayBody,
  listRecentYouImages,
  applyChatAvatar,
  MEDIA_MAX_BYTES,
  FILE_MAX_BYTES,
  addTokensUsed,
  ensureBudget,
  budgetExhausted,
  CHAT_PATH,
  VARIANT_MAX,
  DEFAULT_PEER_ID,
  DEMO_PEER_ID,
  normalizePeerId,
  currentPeerId,
  peerBlocksYou,
  setPeerBlocksYou,
  youBlockedPeer,
  setYouBlockedPeer,
  maybeSoftUnblockFromText,
  withPeer,
  withPeerTopic,
  currentTopicId,
  normalizeTopicId,
  listTopics,
  createTopic,
  updateTopic,
  deleteTopic,
  setActiveTopic,
  topicMemoryInjectEnabled,
  resolveChatCtxForMessage,
  listPeers,
  createPeer,
  updatePeer,
  renamePeer,
  deletePeer,
  resolvePeerForMessage,
};
