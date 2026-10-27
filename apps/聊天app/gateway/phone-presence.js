/**
 * 虚拟小手机 presence（壳上报）+ 查手机 / 手机状态摘要。
 * 与 PC 侧 cam_check / view_activity 分开。
 */
"use strict";

const STALE_MS = 3 * 60 * 1000;

const VIEW_LAB = {
  standby: "锁屏",
  home: "桌面",
  chat: "微信",
  cal: "日历",
  "cal-agenda": "日历",
  "cal-anniv": "日历",
  "cal-propose": "日历",
  colisten: "共听",
  cowatch: "共看",
  "cowatch-play": "共看",
  budget: "额度",
  wallet: "资产",
  memo: "便签",
  cabin: "小屋",
  coread: "共读",
  "phone-settings": "设置",
  profile: "资料",
  "app-stub": "占位 App",
};

/** @type {object} */
let snap = {
  at: 0,
  view: "",
  app: "",
  locked: false,
  online: true,
  pwa: false,
  net: "",
  battery_level: null,
  battery_charging: null,
  chat_peer_id: "",
  chat_title: "",
  chat_is_group: false,
  chat_layer: "",
};

function clampStr(v, n) {
  return String(v == null ? "" : v).trim().slice(0, n);
}

function putPresence(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...snap, at: Date.now() };
  if (Object.prototype.hasOwnProperty.call(p, "view")) {
    next.view = clampStr(p.view, 48);
  }
  if (Object.prototype.hasOwnProperty.call(p, "app")) {
    next.app = clampStr(p.app, 48);
  }
  if (Object.prototype.hasOwnProperty.call(p, "locked")) {
    next.locked = !!p.locked;
  }
  if (Object.prototype.hasOwnProperty.call(p, "online")) {
    next.online = !!p.online;
  }
  if (Object.prototype.hasOwnProperty.call(p, "pwa")) {
    next.pwa = !!p.pwa;
  }
  if (Object.prototype.hasOwnProperty.call(p, "net")) {
    next.net = clampStr(p.net, 32);
  }
  if (Object.prototype.hasOwnProperty.call(p, "battery_level")) {
    const n = Number(p.battery_level);
    next.battery_level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }
  if (Object.prototype.hasOwnProperty.call(p, "battery_charging")) {
    next.battery_charging =
      p.battery_charging == null ? null : !!p.battery_charging;
  }
  if (Object.prototype.hasOwnProperty.call(p, "chat_peer_id")) {
    next.chat_peer_id = clampStr(p.chat_peer_id, 64);
  }
  if (Object.prototype.hasOwnProperty.call(p, "chat_title")) {
    next.chat_title = clampStr(p.chat_title, 64);
  }
  if (Object.prototype.hasOwnProperty.call(p, "chat_is_group")) {
    next.chat_is_group = !!p.chat_is_group;
  }
  if (Object.prototype.hasOwnProperty.call(p, "chat_layer")) {
    next.chat_layer = clampStr(p.chat_layer, 24);
  }
  snap = next;
  return { ok: true, ...getPresence() };
}

function getPresence() {
  return { ...snap };
}

function ageMs() {
  return snap.at ? Date.now() - snap.at : Infinity;
}

function isStale() {
  return !snap.at || ageMs() > STALE_MS;
}

function resolveAppLabel() {
  const app = snap.app || snap.view || "";
  if (VIEW_LAB[app]) return VIEW_LAB[app];
  if (VIEW_LAB[snap.view]) return VIEW_LAB[snap.view];
  return app || "未知界面";
}

/**
 * L0（+可选 L1）查手机摘要。
 * @param {{ l1?: boolean }} opts
 */
function summarizePeek(opts = {}) {
  if (isStale()) {
    return {
      ok: true,
      stale: true,
      age_ms: ageMs() === Infinity ? null : ageMs(),
      summary: "手机像是黑屏或很久没动，看不清最近在干什么。",
    };
  }
  if (snap.locked || snap.view === "standby") {
    return {
      ok: true,
      stale: false,
      age_ms: ageMs(),
      summary: "手机在锁屏，看不出打开了哪个 App。",
      view: snap.view,
      locked: true,
    };
  }
  const appLab = resolveAppLabel();
  let summary = "手机正打开「" + appLab + "」。";
  const inChat =
    snap.view === "chat" || snap.app === "chat" || appLab === "微信";
  if (inChat) {
    const title = snap.chat_title || "";
    const layer = snap.chat_layer || "";
    if (layer === "list" || (!title && layer !== "thread")) {
      summary = "手机在微信列表页，没进具体会话。";
    } else if (title) {
      summary =
        "手机在微信里" +
        (snap.chat_is_group ? "的群聊「" : "和「") +
        title +
        "」聊天。";
    } else {
      summary = "手机在微信里，会话名不清楚。";
    }
  }

  const out = {
    ok: true,
    stale: false,
    age_ms: ageMs(),
    summary,
    view: snap.view,
    app: snap.app || snap.view,
    app_label: appLab,
    locked: false,
    chat_peer_id: snap.chat_peer_id || "",
    chat_title: snap.chat_title || "",
    chat_is_group: !!snap.chat_is_group,
    chat_layer: snap.chat_layer || "",
  };

  if (opts.l1 && inChat && snap.chat_peer_id) {
    out.thread_excerpt = peekThreadExcerpt(snap.chat_peer_id, 4);
    if (out.thread_excerpt && out.thread_excerpt.length) {
      summary +=
        " 最近几条：" +
        out.thread_excerpt
          .map((x) => (x.role === "user" ? "你" : "对方") + "：" + x.text)
          .join(" / ");
      out.summary = summary.slice(0, 480);
    }
  }
  return out;
}

function peekThreadExcerpt(peerId, n) {
  try {
    const { withPeer, listMessages } = require("./daily-chat");
    const listed = withPeer(peerId, () => listMessages());
    const msgs = (listed && listed.messages) || [];
    const take = Math.max(1, Math.min(8, Number(n) || 4));
    const slice = msgs.slice(-take);
    return slice
      .map((m) => {
        if (!m) return null;
        const role = m.role === "user" ? "user" : "bot";
        let text = "";
        if (m.kind === "text" || !m.kind) text = String(m.body || "").trim();
        else if (m.kind === "sticker") text = "[贴纸]";
        else if (m.kind === "image") text = "[图片]";
        else text = "[" + String(m.kind) + "]";
        text = text.replace(/\s+/g, " ").slice(0, 48);
        if (!text) return null;
        return { role, text };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function summarizeDevice() {
  if (isStale() && snap.battery_level == null && !snap.at) {
    return {
      ok: true,
      stale: true,
      summary: "还没读到手机状态（壳未上报）。",
    };
  }
  const bits = [];
  if (snap.battery_level != null) {
    const pct = Math.round(snap.battery_level * 100);
    bits.push(
      snap.battery_charging ? "电量约 " + pct + "%（充电中）" : "电量约 " + pct + "%"
    );
  } else {
    bits.push("电量未知");
  }
  if (snap.online === false) bits.push("离线");
  else if (snap.net) bits.push("网络：" + snap.net);
  else bits.push("在线");
  bits.push(snap.pwa ? "以类 App（PWA）打开" : "浏览器页打开");
  bits.push(
    snap.locked || snap.view === "standby" ? "当前锁屏" : "屏幕亮着"
  );
  if (isStale()) bits.push("状态略旧");
  return {
    ok: true,
    stale: isStale(),
    age_ms: snap.at ? ageMs() : null,
    summary: bits.join("；") + "。",
    battery_level: snap.battery_level,
    battery_charging: snap.battery_charging,
    online: snap.online,
    pwa: snap.pwa,
    locked: !!(snap.locked || snap.view === "standby"),
    net: snap.net || "",
  };
}

/**
 * 主动开口前静默查岗：约 1/3 概率拼背景句（不出卡）。
 * @returns {string} 空或 [查岗·静默] 段
 */
function maybeSilentPrefetch(settings) {
  const s = settings || {};
  if (Math.random() >= 1 / 3) return "";
  const parts = [];
  if (s.peek_phone_enabled !== false) {
    parts.push(summarizePeek({ l1: !!s.peek_phone_l1_enabled }).summary);
  }
  if (s.phone_device_enabled !== false) {
    parts.push(summarizeDevice().summary);
  }
  if (!parts.length) return "";
  return (
    "[查岗·静默]（勿对用户说「我查了手机/监控」；可自然带一句关心）\n" +
    parts.join("\n")
  );
}

function resetForTests() {
  snap = {
    at: 0,
    view: "",
    app: "",
    locked: false,
    online: true,
    pwa: false,
    net: "",
    battery_level: null,
    battery_charging: null,
    chat_peer_id: "",
    chat_title: "",
    chat_is_group: false,
    chat_layer: "",
  };
}

if (require.main === module) {
  resetForTests();
  console.assert(summarizePeek().stale === true);
  putPresence({
    view: "chat",
    app: "chat",
    locked: false,
    chat_title: "薄巧测试",
    chat_layer: "thread",
    chat_is_group: false,
    battery_level: 0.42,
    battery_charging: false,
    online: true,
    pwa: true,
  });
  const pk = summarizePeek();
  console.assert(pk.summary.includes("薄巧测试"), pk.summary);
  const dv = summarizeDevice();
  console.assert(dv.summary.includes("42%"), dv.summary);
  console.log("phone-presence self-check ok");
}

module.exports = {
  STALE_MS,
  putPresence,
  getPresence,
  summarizePeek,
  summarizeDevice,
  maybeSilentPrefetch,
  resetForTests,
};
