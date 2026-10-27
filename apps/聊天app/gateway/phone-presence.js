/**
 * 虚拟小手机 presence（壳上报）+ 查手机 / 手机状态摘要。
 * 与 PC 侧 cam_check / view_activity 分开。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const QUOTA_PATH = path.join(__dirname, "..", "data", "peek-quota.json");
/** 每个自然日最多「主动」成功查几次（同意后计；用户让查不占） */
const PEEK_DAILY_MAX = 3;

/** 未指定目标时一次扫这些 App（扣一次主动额度） */
const PEEK_SWEEP_DEFAULT = [
  { view: "chat", label: "微信", story: false },
  { view: "memo", label: "便签", story: false },
  { view: "cal", label: "日历", story: false },
  { view: "shop", label: "购物记录", story: true },
  { view: "album", label: "相册", story: true },
];

const STALE_MS = 3 * 60 * 1000;
/** 查手机申请等待同意上限 */
const PEEK_ASK_TIMEOUT_MS = 60 * 1000;
/** 同意后「翻看」演出时长（密码 + 分段扫 + 代发打字） */
const PEEK_BROWSE_MS = 18 * 1000;

/** @type {Map<string, { resolve: Function, created: number, l1: boolean }>} */
const peekWaits = new Map();

/** @type {Map<string, { resolve: Function, timer: NodeJS.Timeout }>} */
const peekBrowseWaits = new Map();

/** @type {Map<string, { angry?: string, soft?: string, sent?: boolean }>} */
const peekComposeNotes = new Map();

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

/** 中文/别名 → 壳 view id（可定向翻 App，不限微信） */
const APP_ALIAS = {
  微信: "chat",
  聊天: "chat",
  会话: "chat",
  桌面: "home",
  主屏: "home",
  日历: "cal",
  日程: "cal",
  便签: "memo",
  备忘: "memo",
  备忘录: "memo",
  共听: "colisten",
  音乐: "colisten",
  共看: "cowatch",
  视频: "cowatch",
  额度: "budget",
  资产: "wallet",
  钱包: "wallet",
  小屋: "cabin",
  共读: "coread",
  设置: "phone-settings",
  资料: "profile",
  相册: "album",
  购物: "shop",
  购买: "shop",
  订单: "shop",
};

/** 壳上暂无独立页的「剧情 App」 */
const STORY_APP_LAB = {
  album: "相册",
  shop: "购物记录",
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

function peekDayKey(d) {
  const x = d instanceof Date ? d : new Date();
  return (
    x.getFullYear() +
    "-" +
    String(x.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(x.getDate()).padStart(2, "0")
  );
}

function readPeekQuota() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_PATH, "utf8"));
    return {
      day: String((raw && raw.day) || ""),
      count: Math.max(0, Math.floor(Number(raw && raw.count) || 0)),
    };
  } catch (_) {
    return { day: "", count: 0 };
  }
}

function writePeekQuota(q) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_PATH), { recursive: true });
    fs.writeFileSync(
      QUOTA_PATH,
      JSON.stringify(
        { day: q.day, count: q.count, max: PEEK_DAILY_MAX },
        null,
        2
      ),
      "utf8"
    );
  } catch (_) {}
}

/** 今日是否还能发起查手机 */
function checkPeekQuota() {
  const day = peekDayKey();
  const q = readPeekQuota();
  const count = q.day === day ? q.count : 0;
  if (count >= PEEK_DAILY_MAX) {
    return {
      ok: false,
      error: "peek_daily_limit",
      message:
        "今天主动查手机次数用完了（一天最多主动 " +
        PEEK_DAILY_MAX +
        " 次；对方让你查不受限）",
      day,
      count,
      max: PEEK_DAILY_MAX,
    };
  }
  return {
    ok: true,
    day,
    count,
    remaining: PEEK_DAILY_MAX - count,
    max: PEEK_DAILY_MAX,
  };
}

/** 同意并完成翻看后消耗当日额度 */
function consumePeekQuota() {
  const day = peekDayKey();
  const q = readPeekQuota();
  const count = q.day === day ? q.count : 0;
  const next = { day, count: count + 1 };
  writePeekQuota(next);
  return next;
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
 * 把 target_peer 解析成已有会话；找不到则 null。
 * @param {string} raw
 * @returns {{ id: string, title: string, isGroup: boolean } | null}
 */
function sharedPrefixLen(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  let i = 0;
  const n = Math.min(x.length, y.length);
  while (i < n && x[i] === y[i]) i += 1;
  return i;
}

/**
 * 解析要翻的 App（日历/便签/共听…）；找不到则 null。
 * @param {string} raw
 * @returns {{ view: string, label: string, story?: boolean } | null}
 */
function resolvePeekApp(raw) {
  const q = String(raw || "").trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  if (VIEW_LAB[q]) {
    return { view: q, label: VIEW_LAB[q], story: false };
  }
  if (STORY_APP_LAB[q]) {
    return { view: q, label: STORY_APP_LAB[q], story: true };
  }
  if (APP_ALIAS[q]) {
    const view = APP_ALIAS[q];
    return {
      view,
      label: VIEW_LAB[view] || STORY_APP_LAB[view] || view,
      story: !!STORY_APP_LAB[view],
    };
  }
  const aliasHit = Object.keys(APP_ALIAS).find(
    (k) => k.includes(q) || q.includes(k)
  );
  if (aliasHit) {
    const view = APP_ALIAS[aliasHit];
    return {
      view,
      label: VIEW_LAB[view] || STORY_APP_LAB[view] || view,
      story: !!STORY_APP_LAB[view],
    };
  }
  const viewHit = Object.keys(VIEW_LAB).find(
    (k) => VIEW_LAB[k] === q || k === lower
  );
  if (viewHit) {
    return { view: viewHit, label: VIEW_LAB[viewHit], story: false };
  }
  return null;
}

/** 「日历,购物」/「便签、相册」→ 去重后的 App 列表 */
function resolvePeekAppList(raw) {
  const parts = String(raw || "")
    .split(/[,，、/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = resolvePeekApp(p);
    if (hit && !out.some((x) => x.view === hit.view)) out.push(hit);
  }
  return out;
}

function truthyArg(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "是" || s === "对";
}

/** 通讯录里抽几个「别人」会话，带一句近况 */
function collectOtherChats(limit) {
  const n = Math.max(1, Math.min(4, Number(limit) || 2));
  try {
    const { listPeers, withPeer, listMessages } = require("./daily-chat");
    const listedPeers = listPeers();
    const peers = ((listedPeers && listedPeers.peers) || []).filter(
      (p) => p && p.id && p.id !== "daily"
    );
    const out = [];
    for (const p of peers) {
      if (out.length >= n) break;
      let preview = "";
      try {
        const listed = withPeer(p.id, () => listMessages());
        const msgs = ((listed && listed.messages) || []).filter(
          (m) => m && !m.recalled && m.kind !== "sys" && m.kind !== "tool"
        );
        const last = msgs[msgs.length - 1];
        if (last) {
          preview = String(last.body || last.kind || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 28);
        }
      } catch (_) {}
      out.push({
        id: String(p.id),
        title: String(p.name || p.id).slice(0, 32),
        isGroup: p.kind === "group",
        preview,
      });
    }
    return out;
  } catch (_) {
    return [];
  }
}

function biteMemo() {
  try {
    const { listMemo } = require("../../备忘录app/gateway/memo");
    const listed = listMemo();
    const notes = (listed && listed.notes) || [];
    if (!notes.length) return "便签是空的";
    const top = notes
      .slice(0, 2)
      .map((x) => "「" + String((x && x.title) || "无标题").slice(0, 16) + "」");
    return "便签里有" + top.join("、");
  } catch (_) {
    return "翻了便签";
  }
}

/** 单 App 一句摘要（给人看/给模型用，勿加「不是第三者」类旁白） */
function biteForApp(view, label) {
  const lab = label || VIEW_LAB[view] || STORY_APP_LAB[view] || view;
  if (view === "album") return "相册有密码，解不开";
  if (view === "shop") return "购物里有男士淡香水、薄荷巧克力礼盒（香水备注还没送）";
  if (view === "memo") return biteMemo();
  if (view === "cal" || String(view).indexOf("cal") === 0) return "日历扫过近期日程";
  if (view === "wallet" || view === "budget") return "看了眼「" + lab + "」数字";
  if (view === "chat") {
    const title = snap.chat_title || "";
    const peerId = String(snap.chat_peer_id || "").trim();
    const layer = snap.chat_layer || "";
    if (layer === "list" || (!title && layer !== "thread")) {
      return "微信停在列表";
    }
    if (peerId === "daily") {
      return "微信开着咱俩正在聊的窗口";
    }
    if (title) {
      return (
        "微信在" +
        (snap.chat_is_group ? "群「" : "和「") +
        title +
        "」"
      );
    }
    return "翻了微信";
  }
  if (view === "colisten") return "共听开着";
  if (view === "cowatch" || view === "cowatch-play") return "共看开着";
  return "看了「" + lab + "」";
}

/**
 * 一次扫多个 App（未指定 / 点名几个）；默认顺带翻几个其它联系人。
 * @param {{ apps?: {view:string,label:string,story?:boolean,peerId?:string}[], l1?: boolean }} opts
 */
function summarizePeekSweep(opts = {}) {
  const apps =
    Array.isArray(opts.apps) && opts.apps.length
      ? opts.apps.slice()
      : PEEK_SWEEP_DEFAULT.slice();
  const wantChat = apps.some((a) => a && a.view === "chat");
  const others = wantChat ? collectOtherChats(2) : [];
  /** @type {{view:string,label:string,story?:boolean,peerId?:string}[]} */
  const sweepApps = [];
  const bits = [];

  for (const a of apps) {
    if (!a || !a.view) continue;
    if (a.view === "chat") {
      const curPeer = String(snap.chat_peer_id || "daily").trim() || "daily";
      const curLab =
        curPeer === "daily"
          ? "咱俩"
          : String(snap.chat_title || a.label || "微信").slice(0, 24);
      sweepApps.push({
        view: "chat",
        label: curLab,
        story: false,
        peerId: curPeer,
      });
      bits.push(biteForApp("chat", curLab));
      for (const o of others) {
        if (!o || o.id === curPeer) continue;
        sweepApps.push({
          view: "chat",
          label: o.title,
          story: false,
          peerId: o.id,
        });
        bits.push(
          "还点开了「" +
            o.title +
            "」" +
            (o.preview ? "，近况：「" + o.preview + "」" : "扫了几眼")
        );
      }
      continue;
    }
    sweepApps.push({
      view: a.view,
      label: a.label || VIEW_LAB[a.view] || STORY_APP_LAB[a.view] || a.view,
      story: !!a.story || !!STORY_APP_LAB[a.view],
    });
    bits.push(
      biteForApp(a.view, a.label || VIEW_LAB[a.view] || STORY_APP_LAB[a.view])
    );
  }

  const labels = sweepApps.map((a) => a.label);
  return {
    ok: true,
    stale: false,
    age_ms: ageMs() === Infinity ? null : ageMs(),
    summary: "一次翻了好几个地方：" + bits.join("；") + "。",
    view: "chat",
    app: "sweep",
    app_label: labels.slice(0, 3).join("·") + (labels.length > 3 ? "…" : ""),
    locked: false,
    chat_peer_id: snap.chat_peer_id || "",
    chat_title: snap.chat_title || "",
    chat_is_group: !!snap.chat_is_group,
    chat_layer: snap.chat_layer || "thread",
    targeted: false,
    targeted_app: false,
    sweep: true,
    sweep_apps: sweepApps,
    other_chats: others,
    is_self_chat: String(snap.chat_peer_id || "").trim() === "daily",
  };
}

function resolvePeekTarget(raw) {
  const q = String(raw || "").trim();
  if (!q) return null;
  try {
    const { listPeers } = require("./daily-chat");
    const listed = listPeers();
    const peers = (listed && listed.peers) || [];
    const byId = peers.find((p) => p && p.id === q);
    if (byId) {
      return {
        id: byId.id,
        title: String(byId.name || byId.id).slice(0, 64),
        isGroup: byId.kind === "group",
      };
    }
    const lower = q.toLowerCase();
    const scored = peers
      .filter((p) => p && (p.name || p.id))
      .map((p) => {
        const n = String(p.name || "").trim();
        const nl = n.toLowerCase();
        let score = 0;
        if (nl === lower) score = 100;
        else if (n === q) score = 100;
        else if (nl.includes(lower) || lower.includes(nl)) {
          /* 更长全名匹配加分，避免「冒烟」误粘到短名 */
          score = 70 + Math.min(20, n.length);
        } else {
          const pref = sharedPrefixLen(n, q);
          if (pref >= 2) score = 40 + pref * 3;
        }
        return { p, score, n };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.n.length - a.n.length ||
          (a.p.kind === "group" ? 1 : 0) - (b.p.kind === "group" ? 1 : 0)
      );
    if (scored.length) {
      const hit = scored[0].p;
      return {
        id: hit.id,
        title: String(hit.name || hit.id).slice(0, 64),
        isGroup: hit.kind === "group",
      };
    }
  } catch (_) {}
  return null;
}

/**
 * L0（+可选 L1）查手机摘要。
 * @param {{ l1?: boolean, targetPeerId?: string, targetTitle?: string, targetIsGroup?: boolean, targetApp?: string, targetAppLabel?: string, targetAppStory?: boolean, sweep?: boolean, sweepApps?: object[] }} opts
 */
function summarizePeek(opts = {}) {
  const targeted = !!(opts.targetPeerId && String(opts.targetPeerId).trim());
  const appTarget = !!(opts.targetApp && String(opts.targetApp).trim());
  const sweepApps = Array.isArray(opts.sweepApps) ? opts.sweepApps : null;
  const doSweep =
    !targeted &&
    (opts.sweep === true ||
      (sweepApps && sweepApps.length > 1) ||
      (!appTarget && opts.sweep !== false && !opts.singlePresence));

  if (!targeted && !appTarget && !doSweep && isStale()) {
    return {
      ok: true,
      stale: true,
      age_ms: ageMs() === Infinity ? null : ageMs(),
      summary: "手机像是黑屏或很久没动，看不清最近在干什么。",
    };
  }
  if (!targeted && !appTarget && !doSweep && (snap.locked || snap.view === "standby")) {
    return {
      ok: true,
      stale: false,
      age_ms: ageMs(),
      summary: "手机在锁屏，看不出打开了哪个 App。",
      view: snap.view,
      locked: true,
    };
  }

  if (doSweep && !targeted && !(appTarget && !(sweepApps && sweepApps.length > 1))) {
    return summarizePeekSweep({
      l1: opts.l1,
      apps: sweepApps && sweepApps.length ? sweepApps : undefined,
    });
  }

  if (appTarget && !targeted) {
    const view = clampStr(opts.targetApp, 48);
    const label =
      clampStr(opts.targetAppLabel, 32) ||
      VIEW_LAB[view] ||
      STORY_APP_LAB[view] ||
      view;
    const story = !!opts.targetAppStory || !!STORY_APP_LAB[view];
    let summary = "定向翻看了「" + label + "」。";
    if (view === "album" || label === "相册") {
      summary =
        "打开了相册，但设了密码，解不开，只好作罢。";
    } else if (view === "shop" || label.indexOf("购物") >= 0) {
      summary =
        "翻了购物记录：有男士淡香水、薄荷巧克力礼盒等，香水备注还没送出去。";
    } else if (view === "memo") {
      summary = "翻了便签/备忘，看到几条日常备忘。";
    } else if (view === "cal" || view.indexOf("cal") === 0) {
      summary = "打开了日历，扫了一眼近期日程。";
    } else if (view === "wallet" || view === "budget") {
      summary = "看了一眼「" + label + "」里的数字。";
    }
    return {
      ok: true,
      stale: false,
      age_ms: ageMs() === Infinity ? null : ageMs(),
      summary,
      view: story ? "home" : view,
      app: story ? view : view,
      app_label: label,
      locked: view === "album",
      chat_peer_id: "",
      chat_title: "",
      chat_is_group: false,
      chat_layer: "",
      targeted: false,
      targeted_app: true,
      target_app: view,
      story_app: story,
      is_self_chat: false,
    };
  }

  if (targeted) {
    const peerId = clampStr(opts.targetPeerId, 64);
    const title =
      clampStr(opts.targetTitle, 64) || peerId || "某人";
    const isGroup = !!opts.targetIsGroup;
    const selfChat = peerId === "daily";
    let summary = selfChat
      ? "翻了咱俩的微信会话。"
      : "定向翻看了微信里" +
        (isGroup ? "的群聊「" : "和「") +
        title +
        "」的聊天。";
    const out = {
      ok: true,
      stale: false,
      age_ms: ageMs() === Infinity ? null : ageMs(),
      summary,
      view: "chat",
      app: "chat",
      app_label: "微信",
      locked: false,
      chat_peer_id: peerId,
      chat_title: title,
      chat_is_group: isGroup,
      chat_layer: "thread",
      targeted: true,
      is_self_chat: selfChat,
    };
    if (opts.l1) {
      out.thread_excerpt = peekThreadExcerpt(out.chat_peer_id, 8);
      if (out.thread_excerpt && out.thread_excerpt.length) {
        summary +=
          " 最近几条：" +
          out.thread_excerpt
            .map((x) => {
              if (x.role === "user") return "你：" + x.text;
              return (selfChat ? "我" : "对方") + "：" + x.text;
            })
            .join(" / ");
        out.summary = summary.slice(0, 480);
      }
    }
    return out;
  }

  const appLab = resolveAppLabel();
  let summary = "手机正打开「" + appLab + "」。";
  const inChat =
    snap.view === "chat" || snap.app === "chat" || appLab === "微信";
  if (inChat) {
    const title = snap.chat_title || "";
    const layer = snap.chat_layer || "";
    const peerId = String(snap.chat_peer_id || "").trim();
    if (layer === "list" || (!title && layer !== "thread")) {
      summary = "手机在微信列表页，没进具体会话。";
    } else if (peerId === "daily") {
      /* daily=咱俩；顶栏可能是用户显示名，模型靠 is_self_chat 理解，摘要勿旁白 */
      summary = "手机正开着咱俩的微信。";
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
    targeted: false,
    is_self_chat: String(snap.chat_peer_id || "").trim() === "daily",
  };

  if (opts.l1 && inChat && snap.chat_peer_id) {
    out.thread_excerpt = peekThreadExcerpt(snap.chat_peer_id, 6);
    if (out.thread_excerpt && out.thread_excerpt.length) {
      const self = String(snap.chat_peer_id).trim() === "daily";
      summary +=
        " 最近几条：" +
        out.thread_excerpt
          .map((x) => {
            if (x.role === "user") return "你：" + x.text;
            return (self ? "我" : "对方") + "：" + x.text;
          })
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
        const role =
          m.from === "you" || m.role === "user" ? "user" : "bot";
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
    parts.push(
      summarizePeek({
        l1: !!s.peek_phone_l1_enabled,
        singlePresence: true,
        sweep: false,
      }).summary
    );
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
  for (const [, hit] of peekWaits) {
    try {
      hit.resolve({ accept: false, reason: "reset" });
    } catch (_) {}
  }
  peekWaits.clear();
  for (const [, hit] of peekBrowseWaits) {
    clearTimeout(hit.timer);
    try {
      hit.resolve({ aborted: false });
    } catch (_) {}
  }
  peekBrowseWaits.clear();
  peekComposeNotes.clear();
}

/**
 * 发起查手机申请：等前端 accept/reject。
 * @param {{ l1?: boolean, targetPeerId?: string, targetTitle?: string, targetIsGroup?: boolean, targetApp?: string, targetAppLabel?: string, targetAppStory?: boolean, sweep?: boolean, sweepApps?: object[] }} [opts]
 * @returns {{ id: string, promise: Promise<{ accept: boolean, reason?: string, peek?: object }>, target: object|null, app: object|null, sweep: boolean }}
 */
function beginPeekWait(opts) {
  const id = randomUUID();
  const l1 = !!(opts && opts.l1);
  const targetPeerId = clampStr(opts && opts.targetPeerId, 64);
  const targetTitle = clampStr(opts && opts.targetTitle, 64);
  const targetIsGroup = !!(opts && opts.targetIsGroup);
  const targetApp = clampStr(opts && opts.targetApp, 48);
  const targetAppLabel = clampStr(opts && opts.targetAppLabel, 32);
  const targetAppStory = !!(opts && opts.targetAppStory);
  const sweepApps = Array.isArray(opts && opts.sweepApps)
    ? opts.sweepApps
        .filter((a) => a && a.view)
        .map((a) => ({
          view: clampStr(a.view, 48),
          label: clampStr(a.label, 32) || clampStr(a.view, 32),
          story: !!a.story,
        }))
    : [];
  const sweep =
    !targetPeerId &&
    ((opts && opts.sweep === true) ||
      sweepApps.length > 1 ||
      (!targetApp && !(opts && opts.sweep === false)));
  /** @type {(v: object) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  peekWaits.set(id, {
    resolve,
    created: Date.now(),
    l1,
    targetPeerId,
    targetTitle,
    targetIsGroup,
    targetApp,
    targetAppLabel,
    targetAppStory,
    sweep,
    sweepApps,
  });
  const timer = setTimeout(() => {
    const hit = peekWaits.get(id);
    if (!hit) return;
    peekWaits.delete(id);
    try {
      hit.resolve({ accept: false, reason: "timeout" });
    } catch (_) {}
  }, PEEK_ASK_TIMEOUT_MS);
  promise.finally(() => clearTimeout(timer)).catch(() => {});
  return {
    id,
    promise,
    target: targetPeerId
      ? { id: targetPeerId, title: targetTitle, isGroup: targetIsGroup }
      : null,
    app: targetApp && !sweep
      ? { view: targetApp, label: targetAppLabel || targetApp, story: targetAppStory }
      : null,
    sweep: !!sweep,
  };
}

/**
 * 用户同意 / 拒绝查手机。
 * 同意时可带 presence 快照（客户端当前页），避免仍用过期的「锁屏」态。
 * 若申请带了定向会话 / App，同意后按目标出摘要。
 * @param {string} id
 * @param {boolean} accept
 * @param {object} [presencePatch]
 */
function answerPeekWait(id, accept, presencePatch) {
  const key = String(id || "").trim();
  const hit = peekWaits.get(key);
  if (!hit) {
    return { ok: false, error: "peek_gone", message: "申请已过期或不存在" };
  }
  peekWaits.delete(key);
  if (accept) {
    if (presencePatch && typeof presencePatch === "object") {
      putPresence(presencePatch);
    }
    if (hit.targetPeerId) {
      putPresence({
        view: "chat",
        app: "chat",
        locked: false,
        chat_layer: "thread",
        chat_peer_id: hit.targetPeerId,
        chat_title: hit.targetTitle || hit.targetPeerId,
        chat_is_group: !!hit.targetIsGroup,
      });
    } else if (!hit.sweep && hit.targetApp && !hit.targetAppStory) {
      putPresence({
        view: hit.targetApp,
        app: hit.targetApp,
        locked: false,
        chat_layer: "",
        chat_peer_id: "",
        chat_title: "",
        chat_is_group: false,
      });
    } else if (hit.sweep) {
      /* 翻多 App：先抬到桌面，前端再轮播 */
      putPresence({
        view: "home",
        app: "home",
        locked: false,
      });
    }
    const peek = summarizePeek({
      l1: hit.l1,
      targetPeerId: hit.targetPeerId || "",
      targetTitle: hit.targetTitle || "",
      targetIsGroup: !!hit.targetIsGroup,
      targetApp: hit.sweep ? "" : hit.targetApp || "",
      targetAppLabel: hit.sweep ? "" : hit.targetAppLabel || "",
      targetAppStory: hit.sweep ? false : !!hit.targetAppStory,
      sweep: !!hit.sweep,
      sweepApps: hit.sweepApps && hit.sweepApps.length ? hit.sweepApps : undefined,
    });
    hit.resolve({ accept: true, peek });
    return { ok: true, accept: true, peek };
  }
  hit.resolve({ accept: false, reason: "rejected" });
  return { ok: true, accept: false };
}

/**
 * 翻看演出闸：超时自然结束，或被用户强制下线提前结束。
 * @param {string} id
 * @param {number} [ms]
 */
function beginPeekBrowse(id, ms) {
  const key = String(id || "").trim();
  if (!key) {
    return {
      promise: Promise.resolve({ aborted: false }),
    };
  }
  const prev = peekBrowseWaits.get(key);
  if (prev) {
    clearTimeout(prev.timer);
    try {
      prev.resolve({ aborted: false });
    } catch (_) {}
    peekBrowseWaits.delete(key);
  }
  const waitMs = Math.max(2000, Math.min(20000, Number(ms) || PEEK_BROWSE_MS));
  /** @type {(v: { aborted: boolean }) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const timer = setTimeout(() => {
    const hit = peekBrowseWaits.get(key);
    if (!hit) return;
    peekBrowseWaits.delete(key);
    try {
      hit.resolve({ aborted: false });
    } catch (_) {}
  }, waitMs);
  peekBrowseWaits.set(key, { resolve, timer });
  return { promise };
}

/** 用户点「终止」强制下线 */
function abortPeekBrowse(id) {
  const key = String(id || "").trim();
  const hit = peekBrowseWaits.get(key);
  if (!hit) {
    return { ok: false, error: "browse_gone", message: "翻看已结束" };
  }
  peekBrowseWaits.delete(key);
  clearTimeout(hit.timer);
  try {
    hit.resolve({ aborted: true });
  } catch (_) {}
  return { ok: true, aborted: true };
}

function hasPeekWait(id) {
  return peekWaits.has(String(id || "").trim());
}

function hasPeekBrowse(id) {
  return peekBrowseWaits.has(String(id || "").trim());
}

/** 翻看中客户端上报代发演出结果 */
function setPeekCompose(id, note) {
  const key = String(id || "").trim();
  if (!key) return { ok: false, error: "bad_id" };
  const n = note && typeof note === "object" ? note : {};
  peekComposeNotes.set(key, {
    angry: clampStr(n.angry, 120),
    soft: clampStr(n.soft, 120),
    sent: !!n.sent,
  });
  return { ok: true };
}

function takePeekCompose(id) {
  const key = String(id || "").trim();
  const hit = peekComposeNotes.get(key);
  peekComposeNotes.delete(key);
  return hit || null;
}

if (require.main === module) {
  (async () => {
    resetForTests();
    console.assert(summarizePeek({ singlePresence: true }).stale === true);
    putPresence({
      view: "chat",
      app: "chat",
      locked: false,
      chat_peer_id: "daily",
      chat_title: "沈言之",
      chat_layer: "thread",
      chat_is_group: false,
      battery_level: 0.42,
      battery_charging: false,
      online: true,
      pwa: true,
    });
    const pk = summarizePeek({ singlePresence: true, sweep: false });
    console.assert(pk.is_self_chat === true, "self chat flag");
    console.assert(
      /咱俩|和你|会话/.test(pk.summary) && !/第三者/.test(pk.summary),
      pk.summary
    );
    putPresence({
      view: "chat",
      app: "chat",
      locked: false,
      chat_peer_id: "mint",
      chat_title: "薄巧测试",
      chat_layer: "thread",
      chat_is_group: false,
    });
    const pkOther = summarizePeek({ singlePresence: true, sweep: false });
    console.assert(pkOther.summary.includes("薄巧测试"), pkOther.summary);
    console.assert(!pkOther.is_self_chat);
    const dv = summarizeDevice();
    console.assert(dv.summary.includes("42%"), dv.summary);
    const w = beginPeekWait({ l1: false, sweep: true });
    console.assert(hasPeekWait(w.id));
    setTimeout(() => answerPeekWait(w.id, true), 20);
    const ans = await w.promise;
    console.assert(ans.accept && ans.peek && ans.peek.sweep, "default wait sweeps");
    console.assert(/薄巧测试|香水|便签/.test(ans.peek.summary), ans.peek.summary);
    const b = beginPeekBrowse("browse-test", 200);
    console.assert(hasPeekBrowse("browse-test"));
    setTimeout(() => abortPeekBrowse("browse-test"), 30);
    const br = await b.promise;
    console.assert(br.aborted === true);
    const targeted = summarizePeek({
      l1: false,
      targetPeerId: "someone",
      targetTitle: "定向测试",
      targetIsGroup: false,
    });
    console.assert(targeted.targeted && targeted.summary.includes("定向测试"), targeted.summary);
    console.assert(PEEK_DAILY_MAX === 3, "daily max 3");
    const appCal = resolvePeekApp("日历");
    console.assert(appCal && appCal.view === "cal", appCal);
    const appAlbum = resolvePeekApp("相册");
    console.assert(appAlbum && appAlbum.story === true, appAlbum);
    const pkApp = summarizePeek({
      targetApp: "shop",
      targetAppLabel: "购物记录",
      targetAppStory: true,
      sweep: false,
    });
    console.assert(pkApp.targeted_app && /香水|购物/.test(pkApp.summary), pkApp.summary);
    const multi = resolvePeekAppList("日历,购物,相册");
    console.assert(multi.length === 3, multi);
    const pkSweep = summarizePeek({ sweep: true, sweepApps: multi });
    console.assert(pkSweep.sweep && /香水|购物/.test(pkSweep.summary), pkSweep.summary);
    console.assert(truthyArg("是") && !truthyArg("否"));
    console.log("phone-presence self-check ok");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  STALE_MS,
  PEEK_ASK_TIMEOUT_MS,
  PEEK_BROWSE_MS,
  PEEK_DAILY_MAX,
  putPresence,
  getPresence,
  summarizePeek,
  summarizeDevice,
  maybeSilentPrefetch,
  resolvePeekTarget,
  resolvePeekApp,
  resolvePeekAppList,
  truthyArg,
  PEEK_SWEEP_DEFAULT,
  checkPeekQuota,
  consumePeekQuota,
  beginPeekWait,
  answerPeekWait,
  beginPeekBrowse,
  abortPeekBrowse,
  setPeekCompose,
  takePeekCompose,
  hasPeekWait,
  hasPeekBrowse,
  resetForTests,
};
