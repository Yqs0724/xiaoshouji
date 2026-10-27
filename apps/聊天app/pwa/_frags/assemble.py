# -*- coding: utf-8 -*-
"""Assemble complete WeChat-shell chat.js from disk core + shell modules."""
from __future__ import annotations

import re
from pathlib import Path

PWA = Path(r"d:\cursor-projects\Ariadne\apps\聊天app\pwa")
FR = PWA / "_frags"
DISK = (PWA / "chat.js").read_text(encoding="utf-8")
OUT = PWA / "chat.js"

# --- extract core from disk: chatTimeLabel .. just before function bind() ---
m_start = re.search(r"\n  function chatTimeLabel\(", DISK)
m_bind = re.search(r"\n  function bind\(\) \{", DISK)
if not m_start or not m_bind:
    raise SystemExit("markers not found in disk chat.js")
core = DISK[m_start.start() + 1 : m_bind.start() + 1]

# Patch core: displayPeerName, mute-aware unread, more kinds in histPreview/fillBubble
core = core.replace(
    'peer.textContent = deps.getPeerName() || "家机";',
    'peer.textContent = (typeof displayPeerName === "function" ? displayPeerName() : deps.getPeerName()) || "家机";',
    1,
)

# Enhance fillBubble: add voice/call/file/music/pat/recall before text fallback
FILL_EXTRA = r'''
    if (kind === "voice") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-voice-card";
      const sec = Math.max(1, Math.round(Number(p.duration || p.sec || 1)));
      card.textContent = "语音 " + sec + '"';
      card.setAttribute("role", "button");
      card.addEventListener("click", () => {
        if (p.url) {
          try {
            const a = new Audio(p.url);
            a.play().catch(() => shellToast("播放失败"));
          } catch (_) {
            shellToast("播放失败");
          }
        } else shellToast("语音 · 稍后");
      });
      bubble.append(card);
      finish();
      return;
    }
    if (kind === "call") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-call-card-mini";
      const media = p.media === "video" ? "视频" : "语音";
      const phase = p.phase || "ended";
      let lab = media + "通话";
      if (phase === "missed") lab = "未接" + media + "通话";
      else if (Number(p.durationSec) > 0) lab = media + "通话 " + formatCallClockUi(p.durationSec);
      card.textContent = lab;
      bubble.append(card);
      finish();
      return;
    }
    if (kind === "file" || kind === "music") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-file-card";
      card.textContent = (kind === "music" ? "[音乐] " : "[文件] ") + (p.name || msg.body || "");
      bubble.append(card);
      finish();
      return;
    }
    if (kind === "pat") {
      const t = document.createElement("span");
      t.className = "wx-bubble-text";
      t.textContent = (msg && msg.body) || "拍了拍";
      bubble.append(t);
      finish();
      return;
    }
    if (kind === "recall" || msg.recalled) {
      const t = document.createElement("span");
      t.className = "wx-bubble-text is-recall";
      t.textContent = msg.body || "撤回了一条消息";
      bubble.append(t);
      finish();
      return;
    }
'''

# Insert FILL_EXTRA before `const t = document.createElement("span");` text fallback in fillBubble
core = core.replace(
    """    const t = document.createElement("span");
    t.className = "wx-bubble-text";
    t.textContent = (msg && msg.body) || "";
    bubble.append(t);
    finish();
  }

  function bindBunnyThink""",
    FILL_EXTRA
    + """    const t = document.createElement("span");
    t.className = "wx-bubble-text";
    t.textContent = (msg && msg.body) || "";
    bubble.append(t);
    finish();
  }

  function bindBunnyThink""",
    1,
)

# Enhance histPreview
core = core.replace(
    """  function histPreview(m) {
    if (!m) return "";
    const p = m.payload || {};
    if (m.kind === "redpacket") return "[红包] " + moneyText(p.amount) + " " + (p.note || "");
    if (m.kind === "transfer") return "[转账] " + moneyText(p.amount) + " " + (p.note || "");
    if (m.kind === "location") return "[位置] " + (p.name || m.body || "");
    if (m.kind === "image") return "[图片]";
    if (m.kind === "sticker") return "[贴纸]";
    if (m.kind === "tool") return "[工具] " + (m.body || "");""",
    """  function histPreview(m) {
    if (!m) return "";
    if (m.recalled || m.kind === "recall") return "[已撤回]";
    const p = m.payload || {};
    if (m.kind === "redpacket") return "[红包] " + moneyText(p.amount) + " " + (p.note || "");
    if (m.kind === "transfer") return "[转账] " + moneyText(p.amount) + " " + (p.note || "");
    if (m.kind === "location") return "[位置] " + (p.name || m.body || "");
    if (m.kind === "image") return "[图片]";
    if (m.kind === "sticker") return "[贴纸]";
    if (m.kind === "voice") return "[语音]";
    if (m.kind === "call") return "[通话]";
    if (m.kind === "file") return "[文件] " + (p.name || m.body || "");
    if (m.kind === "music") return "[音乐] " + (p.name || m.body || "");
    if (m.kind === "pat") return m.body || "[拍一拍]";
    if (m.kind === "tool") return "[工具] " + (m.body || "");""",
    1,
)

# Enable file/music in PLUS_ITEMS via prefix (we'll redefine PLUS_ITEMS in header)

HEADER = r'''/**
 * 日常聊天 App 前端（≠ 共读短聊 / 共看吐槽）。
 * 微信壳：底栏 Tab + 会话层 #chatThreadLayer；气泡/SSE/加号/表情/查找。
 */
(function (global) {
  let deps = {
    showView: function () {},
    getPeerName: function () {
      return "家机";
    },
    getAvatarYou: function () {
      return "/assets/cafe/avatar-you.png";
    },
    getAvatarBot: function () {
      return "/assets/cafe/avatar-bot.png";
    },
    onUnreadChange: function () {},
  };

  let bound = false;
  let lastTimeBucket = -1;
  let stickerCache = null;
  let sending = false;
  let sheetMode = "";
  let voiceMode = false;
  let longPressTimer = null;
  let callTimer = null;
  let shellToastTimer = null;
  let shellSearchTimer = null;
  let chatSubReturn = null;
  let histReturnTo = null;
  let momPosts = null;
  let composeDraft = { images: [], scope: "public" };
  let ctxPayload = null;
  let multiMode = false;
  let multiIds = new Set();
  let pendingQuote = null;
  let callSession = null;
  let voiceRec = null;
  let voiceChunks = [];
  let picUrls = [];
  let picIdx = 0;
  let draftTimer = null;
  let nearBottom = true;

  const LS = {
    draft: "ariadne.chat.draft.daily",
    pins: "ariadne.chat.pins",
    mute: "ariadne.chat.mute",
    unreadMark: "ariadne.chat.unread.mark",
    peerNotes: "ariadne.chat.peerNotes",
    bgPick: "ariadne.chat.bg.pick",
    sound: "ariadne.chat.sound",
    clearRead: "ariadne.chat.clearRead",
  };
  const NOTE_KEY = LS.peerNotes;
  const PIN_KEY = LS.pins;
  const MUTE_KEY = LS.mute;
  const UNREAD_MARK_KEY = LS.unreadMark;

  const PLUS_ITEMS = [
    { id: "album", lab: "相册", tile: "相册", ok: true },
    { id: "camera", lab: "拍摄", tile: "拍摄", ok: true },
    { id: "location", lab: "位置", tile: "位置", ok: true },
    { id: "redpacket", lab: "红包", tile: "红包", ok: true },
    { id: "transfer", lab: "转账", tile: "转账", ok: true },
    { id: "call", lab: "通话", tile: "通话", ok: true },
    { id: "history", lab: "聊天记录", tile: "记录", ok: true },
    { id: "file", lab: "文件", tile: "文件", ok: true },
    { id: "music", lab: "音乐", tile: "音乐", ok: true },
  ];

  const HIST_CATS = [
    { id: "date", lab: "日期" },
    { id: "text", lab: "文字" },
    { id: "image", lab: "图片" },
    { id: "sticker", lab: "贴纸" },
    { id: "redpacket", lab: "红包" },
    { id: "transfer", lab: "转账" },
    { id: "money", lab: "交易" },
    { id: "location", lab: "位置" },
  ];

  let histKind = "all";
  let histTimer = null;
  let histDay = "";
  let histActiveDays = null;
  let pendingThink = { sec: 0, text: "" };
  let thinkAttached = false;

  const SVG_MOM_TRASH =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9zm-1 12h12a1 1 0 0 0 1-1V7H5v13a1 1 0 0 0 1 1z"/></svg>';
  const SVG_MOM_PUBLIC =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 14h-2v-2h2v2zm0-4h-2V6h2v6z"/></svg>';
  const SVG_MOM_PRIVATE =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 1a5 5 0 00-5 5v3H5v14h14V9h-2V6a5 5 0 00-5-5zm0 2a3 3 0 013 3v3H9V6a3 3 0 013-3z"/></svg>';

'''

# Strip old PLUS_ITEMS / HIST_CATS / state from core if present at start
# core currently starts at chatTimeLabel — good.

SHELL = r'''
  /* ========== 本地存储 / 备注 / 置顶免打扰 ========== */
  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (_) {}
  }
  function lsGetJson(key, fallback) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      return raw == null ? fallback : raw;
    } catch {
      return fallback;
    }
  }
  function readPins() {
    const raw = lsGetJson(PIN_KEY, []);
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  }
  function writePins(arr) {
    lsSet(PIN_KEY, JSON.stringify(arr || []));
  }
  function readMutes() {
    const raw = lsGetJson(MUTE_KEY, []);
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  }
  function writeMutes(arr) {
    lsSet(MUTE_KEY, JSON.stringify(arr || []));
  }
  function readUnreadMarks() {
    const raw = lsGetJson(UNREAD_MARK_KEY, {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }
  function writeUnreadMarks(obj) {
    lsSet(UNREAD_MARK_KEY, JSON.stringify(obj || {}));
  }
  function chatListMuted() {
    return readMutes().includes("daily");
  }
  function toggleSessionPin(sessId) {
    const id = String(sessId || "daily");
    const pins = readPins();
    const i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1);
    else pins.push(id);
    writePins(pins);
    paintSessBadges();
    shellToast(pins.includes(id) ? "已置顶" : "已取消置顶");
  }
  async function toggleSessionMute(sessId) {
    const id = String(sessId || "daily");
    const mutes = readMutes();
    const i = mutes.indexOf(id);
    if (i >= 0) mutes.splice(i, 1);
    else mutes.push(id);
    writeMutes(mutes);
    paintSessBadges();
    await refreshUnreadUi();
    shellToast(mutes.includes(id) ? "已开启免打扰" : "已关闭免打扰");
  }
  function readNotes() {
    const raw = lsGetJson(NOTE_KEY, {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }
  function readNote(sessId) {
    return String(readNotes()[String(sessId || "daily")] || "").trim();
  }
  function writeNote(sessId, name) {
    const id = String(sessId || "daily");
    const all = readNotes();
    const t = String(name || "").trim().slice(0, 32);
    if (!t) delete all[id];
    else all[id] = t;
    lsSet(NOTE_KEY, JSON.stringify(all));
  }
  function displayPeerName(sessId) {
    return readNote(sessId || "daily") || deps.getPeerName() || "家机";
  }
  function refreshPeerLabels() {
    const name = displayPeerName();
    const note = readNote("daily");
    ["chatSessName", "chatContactName", "chatProfileName", "chatClearPeerName", "chatPeerPageTitle"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = name;
    });
    const peer = document.getElementById("chatPeerName");
    if (peer && !peer.classList.contains("is-typing")) peer.textContent = name;
    const noteRow = document.querySelector('#chatOvPeer [data-peer-act="note"] .val');
    if (noteRow) noteRow.textContent = note || "未设置";
    paintSessBadges();
  }
  function paintSessBadges() {
    const pin = document.getElementById("chatSessPin");
    const mute = document.getElementById("chatSessMute");
    if (pin) pin.hidden = !readPins().includes("daily");
    if (mute) mute.hidden = !readMutes().includes("daily");
  }

  /* ========== Shell tabs / thread layer ========== */
  function threadLayerOpen() {
    const layer = document.getElementById("chatThreadLayer");
    return !!(layer && layer.classList.contains("active") && !layer.hidden);
  }
  function closeThreadLayer() {
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    layer.classList.remove("active");
    layer.hidden = true;
    closeHist({ skipReturn: true });
    setPanels(null);
    setTyping(false);
    exitMultiMode();
    clearPendingQuote();
    persistDraft();
    refreshSessionList();
  }
  function openThreadLayer() {
    closeShellOverlays();
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    layer.hidden = false;
    layer.classList.add("active");
    refreshPeerLabels();
    applyChatBg();
    restoreDraft();
    refreshChatThread();
    const clearRead = lsGet(LS.clearRead, "1") !== "0";
    if (clearRead) markChatRead().then(() => refreshUnreadUi());
  }
  function shellToast(msg) {
    const el = document.getElementById("chatShellToast");
    if (!el) {
      try {
        console.info("[chat]", msg);
      } catch (_) {}
      return;
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(shellToastTimer);
    shellToastTimer = setTimeout(() => {
      el.hidden = true;
    }, 1700);
  }
  function showChatOverlay(id) {
    document.querySelectorAll("#view-chat .chat-overlay").forEach((el) => {
      const on = el.id === id;
      el.classList.toggle("active", on);
      el.hidden = !on;
    });
  }
  function closeShellOverlays() {
    document.querySelectorAll("#view-chat .chat-overlay").forEach((el) => {
      el.classList.remove("active");
      el.hidden = true;
    });
  }
  function openShellOverlay(id) {
    chatSubReturn = null;
    histReturnTo = null;
    closeThreadLayer();
    showChatOverlay(id);
  }
  function goChatTab(name) {
    closeShellOverlays();
    closeThreadLayer();
    document.querySelectorAll("#view-chat .chat-tab").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-chat-tab") === name);
    });
    document.querySelectorAll("#view-chat .chat-dock [data-chat-go]").forEach((b) => {
      b.classList.toggle("on", b.getAttribute("data-chat-go") === name);
    });
    if (name === "moments") refreshMoments();
    if (name === "chat") refreshSessionList();
  }
  function sessTimeLabel(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes());
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yest.getFullYear() &&
      d.getMonth() === yest.getMonth() &&
      d.getDate() === yest.getDate()
    ) {
      return "昨天";
    }
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  async function fetchUnreadCount() {
    try {
      const res = await fetch("/api/v1/chat/unread", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return 0;
      return Math.max(0, Math.floor(Number(data.count) || 0));
    } catch (_) {
      return 0;
    }
  }
  function paintShellUnread(count) {
    const n = chatListMuted() ? 0 : Math.max(0, Math.floor(Number(count) || 0));
    const marks = readUnreadMarks();
    const marked = !!marks.daily;
    const show = n > 0 || marked;
    const badge = document.getElementById("chatSessBadge");
    const dot = document.getElementById("chatDockDot");
    if (badge) {
      if (show) {
        badge.hidden = false;
        badge.textContent = n > 0 ? (n > 99 ? "99+" : String(n)) : "";
        if (n <= 0 && marked) badge.textContent = "";
        badge.classList.toggle("is-dot", n <= 0 && marked);
      } else {
        badge.hidden = true;
        badge.classList.remove("is-dot");
      }
    }
    if (dot) dot.hidden = !show || chatListMuted();
  }
  async function refreshUnreadUi() {
    const n = await fetchUnreadCount();
    paintShellUnread(n);
    try {
      deps.onUnreadChange();
    } catch (_) {}
  }
  function syncShellAvatars() {
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const you = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    [
      ["chatSessAv", bot],
      ["chatContactAv", bot],
      ["chatProfileAv", bot],
      ["chatMomYouAv", you],
      ["chatMeAv", you],
    ].forEach(([id, src]) => {
      const el = document.getElementById(id);
      if (el) el.src = src;
    });
    refreshPeerLabels();
  }
  async function refreshSessionList() {
    syncShellAvatars();
    paintSessBadges();
    const preview = document.getElementById("chatSessPreview");
    const timeEl = document.getElementById("chatSessTime");
    try {
      const msgs = await fetchChatMessages();
      if (!msgs.length) {
        if (preview) preview.textContent = "还没有短讯";
        if (timeEl) timeEl.textContent = "";
      } else {
        const last = msgs[msgs.length - 1];
        if (preview) preview.textContent = histPreview(last) || "…";
        if (timeEl) timeEl.textContent = sessTimeLabel(last.ts || last.created_at);
      }
    } catch (_) {
      if (preview) preview.textContent = "加载失败";
    }
    await refreshUnreadUi();
  }
  function onShowChatShell() {
    syncShellAvatars();
    refreshSessionList();
    applyChatBg();
    loadChatPrefsUi();
    if (threadLayerOpen()) refreshChatThread();
  }
  function noteBotPing() {
    if (threadLayerOpen() && chatViewActive()) {
      markChatRead().then(() => refreshUnreadUi());
      return;
    }
    refreshUnreadUi();
  }

  /* ========== Draft / quote / new-msg chip ========== */
  function persistDraft() {
    const input = document.getElementById("dailyChatInput");
    if (!input) return;
    const v = String(input.value || "");
    if (v) lsSet(LS.draft, v);
    else {
      try {
        localStorage.removeItem(LS.draft);
      } catch (_) {}
    }
  }
  function restoreDraft() {
    const input = document.getElementById("dailyChatInput");
    if (!input) return;
    const v = lsGet(LS.draft, "");
    if (v && !input.value) input.value = v;
    syncSendPlus();
  }
  function clearPendingQuote() {
    pendingQuote = null;
    const bar = document.getElementById("chatQuoteBar");
    if (bar) bar.hidden = true;
  }
  function paintQuoteBar() {
    const bar = document.getElementById("chatQuoteBar");
    const who = document.getElementById("chatQuoteWho");
    const txt = document.getElementById("chatQuoteTxt");
    if (!bar) return;
    if (!pendingQuote) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (who) who.textContent = pendingQuote.who || "";
    if (txt) txt.textContent = pendingQuote.text || "";
  }
  function quoteIntoComposer(msg) {
    if (!msg) return;
    const peer = displayPeerName();
    pendingQuote = {
      id: msg.id,
      who: msg.from === "you" ? "你" : peer,
      text: String(histPreview(msg) || "").slice(0, 120),
    };
    paintQuoteBar();
  }
  function threadNearBottom() {
    const box = document.getElementById("chatThread");
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  function showNewMsgChip(on) {
    const chip = document.getElementById("chatNewMsg");
    if (chip) chip.hidden = !on;
  }

  /* ========== Pic viewer ========== */
  function openPicViewer(urls, idx) {
    picUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
    picIdx = Math.max(0, Math.min(Number(idx) || 0, picUrls.length - 1));
    const view = document.getElementById("chatPicView");
    const img = document.getElementById("chatPicViewImg");
    if (!view || !img || !picUrls.length) return;
    img.src = picUrls[picIdx];
    view.hidden = false;
    const prev = document.getElementById("chatPicPrev");
    const next = document.getElementById("chatPicNext");
    if (prev) prev.hidden = picUrls.length < 2;
    if (next) next.hidden = picUrls.length < 2;
  }
  function closePicViewer() {
    const view = document.getElementById("chatPicView");
    if (view) view.hidden = true;
  }
  function stepPic(dir) {
    if (picUrls.length < 2) return;
    picIdx = (picIdx + dir + picUrls.length) % picUrls.length;
    const img = document.getElementById("chatPicViewImg");
    if (img) img.src = picUrls[picIdx];
  }

  /* ========== Ctx / multi ========== */
  function closeCtxMenu() {
    const el = document.getElementById("chatCtx");
    if (el) el.hidden = true;
    ctxPayload = null;
  }
  function openCtxMenu(clientX, clientY, payload) {
    const root = document.getElementById("view-chat");
    const el = document.getElementById("chatCtx");
    const panel = document.getElementById("chatCtxPanel");
    if (!root || !el || !panel || !payload) return;
    ctxPayload = payload;
    const regen = document.getElementById("chatCtxRegen");
    const recall = document.getElementById("chatCtxRecall");
    const react = document.getElementById("chatCtxReact");
    if (regen) regen.hidden = !(payload.from === "bot" && payload.kind === "text");
    if (recall) recall.hidden = !(payload.from === "you");
    if (react) react.hidden = false;
    el.hidden = false;
    panel.style.left = "0px";
    panel.style.top = "0px";
    const rr = root.getBoundingClientRect();
    const pw = panel.offsetWidth || 168;
    const ph = panel.offsetHeight || 280;
    let x = clientX - rr.left;
    let y = clientY - rr.top;
    x = Math.max(8, Math.min(x, rr.width - pw - 8));
    y = Math.max(8, Math.min(y, rr.height - ph - 8));
    if (clientY - rr.top > ph + 24) y = clientY - rr.top - ph - 8;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
  }
  function bindLongPress(el, onHold) {
    if (!el || typeof onHold !== "function") return;
    let holdTimer = null;
    let armed = false;
    let sx = 0;
    let sy = 0;
    const clear = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      clear();
      armed = false;
      sx = e.clientX;
      sy = e.clientY;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        armed = true;
        onHold(e.clientX || sx, e.clientY || sy);
      }, 520);
    });
    el.addEventListener("pointermove", (e) => {
      if (!holdTimer) return;
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) clear();
    });
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointerleave", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener(
      "click",
      (e) => {
        if (!armed) return;
        armed = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  function bindBubbleCtx(bubble, msg) {
    if (!bubble || !msg) return;
    const text = String(histPreview(msg) || "").trim();
    if (!text || msg.kind === "tool") return;
    if (msg.kind === "image") {
      bubble.addEventListener("click", (e) => {
        if (multiMode) return;
        e.preventDefault();
        openPicViewer([msg.body], 0);
      });
    }
    bindLongPress(bubble, (x, y) => {
      if (multiMode) {
        toggleMultiId(msg.id);
        return;
      }
      openCtxMenu(x, y, {
        src: "chat",
        refId: msg.id ? String(msg.id) : "",
        text: text.slice(0, 400),
        kind: msg.kind || "text",
        from: msg.from,
        msg: msg,
      });
    });
  }
  async function copyCtxText(text) {
    const t = String(text || "");
    if (!t) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
      } else {
        const ta = document.createElement("textarea");
        ta.value = t;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      shellToast("已复制");
    } catch (_) {
      shellToast("复制失败");
    }
  }
  async function translateCtxUi(p) {
    if (!p || !p.text) return;
    try {
      const res = await fetch("/api/v1/chat/translate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: p.text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "翻译失败");
      shellToast(data.text || data.translation || "稍后");
    } catch (err) {
      shellToast((err && err.message) || "翻译失败");
    }
  }
  async function addFavoriteFromUi(p) {
    if (!p) return;
    try {
      const res = await fetch("/api/v1/chat/favorites", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: p.text,
          meta: p.kind || "chat",
          refId: p.refId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "收藏失败");
      shellToast("已收藏");
    } catch (err) {
      shellToast((err && err.message) || "收藏失败");
    }
  }
  async function recallChatMessageUi(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    try {
      const res = await fetch("/api/v1/chat/messages/" + encodeURIComponent(sid) + "/recall", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "撤回失败");
      if (data.message) patchMessageBubble(data.message);
      else await refreshChatThread();
      shellToast("已撤回");
    } catch (err) {
      shellToast((err && err.message) || "撤回失败");
    }
  }
  async function deleteChatMessageUi(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    try {
      const res = await fetch("/api/v1/chat/messages/" + encodeURIComponent(sid), {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "删除失败");
      const box = document.getElementById("chatThread");
      const row = box && box.querySelector('.wx-row[data-msg-id="' + sid + '"]');
      if (row) row.remove();
      else await refreshChatThread();
    } catch (err) {
      shellToast((err && err.message) || "删除失败");
    }
  }
  async function regenerateBotMessage(id) {
    shellToast("重新生成 · 稍后");
    /* ponytail: full regen stream later; toast keeps UI honest */
  }
  function openReactSheet(p) {
    const sheet = document.getElementById("chatReactSheet");
    const inp = document.getElementById("chatReactInput");
    if (!sheet) return;
    sheet.hidden = false;
    if (inp) {
      inp.value = "";
      inp.focus();
      inp.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const emo = String(inp.value || "").trim();
          sheet.hidden = true;
          if (emo) shellToast("贴了 " + emo);
        }
      };
    }
  }
  async function runCtxAction(action) {
    const p = ctxPayload;
    closeCtxMenu();
    if (!p || !action) return;
    if (action === "copy") {
      await copyCtxText(p.text);
      return;
    }
    if (action === "translate") {
      await translateCtxUi(p);
      return;
    }
    if (action === "react") {
      openReactSheet(p);
      return;
    }
    if (action === "quote") {
      quoteIntoComposer(p.msg || { from: p.from, body: p.text, id: p.refId });
      return;
    }
    if (action === "forward") {
      openFwdSheet([p]);
      return;
    }
    if (action === "fav") {
      await addFavoriteFromUi(p);
      return;
    }
    if (action === "multi") {
      enterMultiMode(p.refId);
      return;
    }
    if (action === "regen") {
      await regenerateBotMessage(p.refId);
      return;
    }
    if (action === "recall") {
      await recallChatMessageUi(p.refId);
      return;
    }
    if (action === "delete") {
      await deleteChatMessageUi(p.refId);
      return;
    }
  }
  function paintMultiBar() {
    const bar = document.getElementById("chatMultiBar");
    const count = document.getElementById("chatMultiCount");
    const form = document.getElementById("chatForm");
    if (bar) bar.hidden = !multiMode;
    if (form) form.hidden = !!multiMode;
    if (count) count.textContent = "已选 " + multiIds.size + " 条";
    ["chatMultiDel", "chatMultiCopy", "chatMultiFwd"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = multiIds.size === 0;
    });
    syncMultiMarks();
  }
  function syncMultiMarks() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    box.querySelectorAll(".wx-row[data-msg-id]").forEach((row) => {
      const id = row.getAttribute("data-msg-id");
      row.classList.toggle("is-multi-on", multiMode && multiIds.has(id));
      row.classList.toggle("is-multi", multiMode);
    });
  }
  function enterMultiMode(seedId) {
    multiMode = true;
    multiIds = new Set();
    if (seedId) multiIds.add(String(seedId));
    paintMultiBar();
  }
  function exitMultiMode() {
    multiMode = false;
    multiIds = new Set();
    paintMultiBar();
  }
  function toggleMultiId(id) {
    const sid = String(id || "");
    if (!sid) return;
    if (multiIds.has(sid)) multiIds.delete(sid);
    else multiIds.add(sid);
    paintMultiBar();
  }
  async function multiDeleteUi() {
    const ids = Array.from(multiIds);
    for (const id of ids) await deleteChatMessageUi(id);
    exitMultiMode();
  }
  async function multiCopyUi() {
    shellToast("已记 · 多选复制稍后");
  }
  function openFwdSheet(items) {
    const sheet = document.getElementById("chatFwdSheet");
    const peers = document.getElementById("chatFwdPeers");
    if (!sheet) {
      shellToast("转发 · 稍后");
      return;
    }
    if (peers) {
      peers.innerHTML =
        '<button type="button" class="chat-scope-peer on" data-fwd="daily">' +
        escapeHtml(displayPeerName()) +
        "</button>";
    }
    sheet._fwdItems = items || [];
    sheet.hidden = false;
  }
  function closeFwdSheet() {
    const sheet = document.getElementById("chatFwdSheet");
    if (sheet) sheet.hidden = true;
  }

  /* ========== Moments / fav / compose ========== */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }
  function momRelTime(ts) {
    const t = Number(ts) || Date.now();
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return "刚刚";
    if (sec < 3600) return Math.floor(sec / 60) + "分钟前";
    if (sec < 86400) return Math.floor(sec / 3600) + "小时前";
    if (sec < 172800) return "昨天";
    return chatTimeLabel(t);
  }
  function paintMomPost(raw) {
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const you = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const peer = displayPeerName();
    const author = raw.author === "bot" ? "bot" : "you";
    const likes = Array.isArray(raw.likes) ? raw.likes.slice() : [];
    const images = Array.isArray(raw.images)
      ? raw.images.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 9)
      : [];
    return {
      id: String(raw.id || ""),
      author,
      name: raw.name || (author === "bot" ? peer : "你"),
      av: author === "bot" ? bot : you,
      txt: String(raw.txt || raw.text || ""),
      images,
      scope: raw.scope === "private" ? "private" : "public",
      time: momRelTime(raw.ts),
      liked: likes.indexOf("你") >= 0,
      likes,
      comments: Array.isArray(raw.comments)
        ? raw.comments.map((c) => ({ who: c.who || "你", txt: c.txt || "" }))
        : [],
    };
  }
  function momImgsHtml(images) {
    const list = Array.isArray(images) ? images : [];
    if (!list.length) return "";
    const n = Math.min(9, list.length);
    return (
      '<div class="chat-post-imgs n' +
      n +
      '">' +
      list
        .slice(0, 9)
        .map((u) => '<img src="' + escapeHtml(u) + '" alt="" loading="lazy" />')
        .join("") +
      "</div>"
    );
  }
  function momOwnFootHtml(p) {
    if (!p || p.author !== "you") return "";
    const priv = p.scope === "private";
    return (
      '<div class="chat-post-foot">' +
      '<button type="button" class="chat-post-ico" data-mom-del="' +
      escapeHtml(p.id) +
      '" aria-label="删除">' +
      SVG_MOM_TRASH +
      "</button>" +
      '<button type="button" class="chat-post-ico ' +
      (priv ? "is-private" : "") +
      '" data-mom-scope="' +
      escapeHtml(p.id) +
      '" aria-label="分享范围">' +
      (priv ? SVG_MOM_PRIVATE : SVG_MOM_PUBLIC) +
      "</button>" +
      '<span class="chat-post-scope-lab">' +
      (priv ? "仅自己" : "公开") +
      "</span></div>"
    );
  }
  function renderMomFeed() {
    const feed = document.getElementById("chatMomFeed");
    if (!feed) return;
    const posts = momPosts || [];
    if (!posts.length) {
      feed.innerHTML = '<p class="chat-hint-line">还没有动态</p>';
      return;
    }
    feed.innerHTML = posts
      .map((p) => {
        const likes = p.likes.length
          ? '<div class="chat-post-likes">' + p.likes.map(escapeHtml).join("、") + "</div>"
          : "";
        const cmts = p.comments.length
          ? '<div class="chat-post-comments">' +
            p.comments
              .map(
                (c) =>
                  '<div class="c"><b>' +
                  escapeHtml(c.who) +
                  "</b> " +
                  escapeHtml(c.txt) +
                  "</div>"
              )
              .join("") +
            "</div>"
          : "";
        return (
          '<article class="chat-post" data-id="' +
          escapeHtml(p.id) +
          '"><div class="chat-post-h"><img class="chat-post-av" src="' +
          escapeHtml(p.av) +
          '" alt="" /><div class="chat-post-main"><div class="chat-post-name">' +
          escapeHtml(p.name) +
          '</div><div class="chat-post-txt">' +
          escapeHtml(p.txt) +
          "</div>" +
          momImgsHtml(p.images) +
          '<div class="chat-post-meta"><span>' +
          escapeHtml(p.time) +
          '</span><span class="chat-post-acts"><button type="button" class="chat-post-act ' +
          (p.liked ? "on" : "") +
          '" data-mom-like="' +
          escapeHtml(p.id) +
          '">赞</button><button type="button" class="chat-post-act" data-mom-cmt="' +
          escapeHtml(p.id) +
          '">评</button></span></div>' +
          likes +
          cmts +
          momOwnFootHtml(p) +
          '<div class="chat-cmt-row" data-mom-cmt-row="' +
          escapeHtml(p.id) +
          '"><input type="text" maxlength="80" placeholder="评论…" /><button type="button" data-mom-cmt-send="' +
          escapeHtml(p.id) +
          '">发送</button></div></div></div></article>'
        );
      })
      .join("");
  }
  async function refreshMoments() {
    try {
      const res = await fetch("/api/v1/moments", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      const posts = Array.isArray(data.posts) ? data.posts : [];
      momPosts = posts.map(paintMomPost);
      renderMomFeed();
    } catch (err) {
      const feed = document.getElementById("chatMomFeed");
      if (feed) feed.innerHTML = '<p class="chat-hint-line">' + escapeHtml((err && err.message) || "加载失败") + "</p>";
    }
  }
  function resetComposeDraft() {
    composeDraft = { images: [], scope: "public" };
    const ta = document.getElementById("chatComposeTxt");
    if (ta) ta.value = "";
    paintComposeDraft();
  }
  function paintComposeDraft() {
    const box = document.getElementById("chatComposeImgs");
    const lab = document.getElementById("chatComposeScopeLab");
    if (lab) lab.textContent = composeDraft.scope === "private" ? "仅自己" : "公开";
    if (!box) return;
    const imgs = composeDraft.images || [];
    if (!imgs.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = imgs
      .map(
        (u, i) =>
          '<div class="chat-compose-thumb"><img src="' +
          escapeHtml(u) +
          '" alt="" /><button type="button" class="x" data-compose-rm="' +
          i +
          '" aria-label="去掉">×</button></div>'
      )
      .join("");
  }
  async function uploadComposeImage(file) {
    if (!file) return null;
    const res = await fetch("/api/v1/chat/media", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "上传失败");
    if (!data.url) throw new Error("上传失败");
    return data.url;
  }
  async function postMomentUi() {
    const ta = document.getElementById("chatComposeTxt");
    const txt = String((ta && ta.value) || "").trim();
    if (!txt && !(composeDraft.images || []).length) {
      shellToast("写点什么再发");
      return;
    }
    try {
      const res = await fetch("/api/v1/moments", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txt: txt,
          text: txt,
          images: composeDraft.images || [],
          scope: composeDraft.scope || "public",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "发表失败");
      resetComposeDraft();
      closeShellOverlays();
      goChatTab("moments");
      await refreshMoments();
      shellToast("已发表");
    } catch (err) {
      shellToast((err && err.message) || "发表失败");
    }
  }
  async function deleteMomentUi(id) {
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id), {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "删除失败");
      await refreshMoments();
      shellToast("已删除");
    } catch (err) {
      shellToast((err && err.message) || "删除失败");
    }
  }
  async function toggleMomentScopeUi(id) {
    const cur = (momPosts || []).find((p) => p.id === id);
    const next = cur && cur.scope === "private" ? "public" : "private";
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "改范围失败");
      await refreshMoments();
    } catch (err) {
      shellToast((err && err.message) || "改范围失败");
    }
  }
  async function likeMomentUi(id) {
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id) + "/like", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ who: "你" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "点赞失败");
      await refreshMoments();
    } catch (err) {
      shellToast((err && err.message) || "点赞失败");
    }
  }
  async function commentMomentUi(id, txt) {
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id) + "/comments", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ who: "你", txt: txt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "评论失败");
      await refreshMoments();
    } catch (err) {
      shellToast((err && err.message) || "评论失败");
    }
  }
  async function renderFavList() {
    const box = document.getElementById("chatFavList");
    if (!box) return;
    try {
      const res = await fetch("/api/v1/chat/favorites", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        box.innerHTML = '<p class="chat-hint-line">还没有收藏</p>';
        return;
      }
      box.innerHTML = items
        .map(
          (f) =>
            '<button type="button" class="chat-fav-item"><div><div class="t">' +
            escapeHtml(f.text || f.t || "") +
            '</div><div class="meta">' +
            escapeHtml(f.meta || "") +
            "</div></div></button>"
        )
        .join("");
    } catch (err) {
      box.innerHTML = '<p class="chat-hint-line">' + escapeHtml((err && err.message) || "加载失败") + "</p>";
    }
  }
  function closeScopeSheet() {
    const s = document.getElementById("chatScopeSheet");
    if (s) s.hidden = true;
  }
  function openScopeSheet() {
    const s = document.getElementById("chatScopeSheet");
    if (!s) return;
    s.hidden = false;
    const modes = document.getElementById("chatScopeModes");
    if (modes) {
      modes.querySelectorAll("[data-scope]").forEach((b) => {
        b.classList.toggle("on", b.getAttribute("data-scope") === (composeDraft.scope || "public"));
      });
    }
  }

  /* ========== Prefs / bg / clear ========== */
  function paintMoodCap(data) {
    const cap = document.getElementById("chatMoodCap");
    const prefLab = document.getElementById("chatPrefMoodLab");
    const label = data && data.label ? String(data.label) : "";
    if (prefLab) prefLab.textContent = label || "—";
    if (!cap) return;
    if (!label) {
      cap.hidden = true;
      cap.textContent = "";
      return;
    }
    cap.hidden = false;
    cap.textContent = label;
  }
  async function refreshMoodUi() {
    try {
      const res = await fetch("/api/v1/chat/mood", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      paintMoodCap(data);
    } catch (_) {}
  }
  async function loadChatPrefsUi() {
    const sound = document.getElementById("chatTogSound");
    const read = document.getElementById("chatTogRead");
    if (sound) sound.classList.toggle("on", lsGet(LS.sound, "1") !== "0");
    if (read) read.classList.toggle("on", lsGet(LS.clearRead, "1") !== "0");
    try {
      const res = await fetch("/api/v1/chat/prefs", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const slow = document.getElementById("chatTogSlow");
        if (slow) slow.classList.toggle("on", data.slow_reply !== false);
      }
    } catch (_) {}
    const bgLab = document.getElementById("chatPrefBgLab");
    if (bgLab) bgLab.textContent = lsGet(LS.bgPick, "") ? "已选相册图" : "从相册选择";
    await refreshMoodUi();
  }
  async function patchChatPrefs(patch) {
    try {
      const res = await fetch("/api/v1/chat/prefs", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      return data;
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
      return null;
    }
  }
  function applyChatBg() {
    const url = lsGet(LS.bgPick, "");
    const layer = document.getElementById("chatThreadLayer");
    const thread = document.getElementById("chatThread");
    const el = thread || layer;
    if (!el) return;
    if (url) {
      el.style.backgroundImage = 'url("' + url.replace(/"/g, '\\"') + '")';
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
    } else {
      el.style.backgroundImage = "";
    }
  }
  async function clearChatHistoryUi() {
    const cb = document.getElementById("chatClearPeerDaily");
    if (cb && !cb.checked) {
      shellToast("先勾选会话");
      return;
    }
    try {
      const res = await fetch("/api/v1/chat/messages", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "清空失败");
      const sheet = document.getElementById("chatClearSheet");
      if (sheet) sheet.hidden = true;
      shellToast("已清空");
      refreshSessionList();
      if (threadLayerOpen()) refreshChatThread();
    } catch (err) {
      shellToast((err && err.message) || "清空失败");
    }
  }

  /* ========== Profile / peer / world ========== */
  function paintProfileInheritUi(inherit) {
    const sub = document.getElementById("chatProfileSub");
    const hint = document.getElementById("chatProfileHint");
    const cb = document.getElementById("chatPersonaUseHut");
    if (cb) cb.checked = !!inherit;
    if (sub) sub.textContent = inherit ? "沿用小屋人设" : "聊天自有人设";
    if (hint) {
      hint.textContent = inherit
        ? "开着时改这里=改小屋底稿；关掉则只影响聊天。"
        : "已关掉沿用：只改聊天自有人设，小屋底稿不动。";
    }
  }
  async function openProfilePage(returnTo) {
    const el = document.getElementById("chatOvProfile");
    const cardTa = document.getElementById("chatPersonaCardInput");
    const nameEl = document.getElementById("chatProfileName");
    const av = document.getElementById("chatProfileAv");
    if (!el) return;
    chatSubReturn = returnTo || null;
    if (nameEl) nameEl.textContent = displayPeerName();
    if (av) av.src = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    if (cardTa) cardTa.value = "";
    paintProfileInheritUi(true);
    try {
      const res = await fetch("/api/v1/settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取资料失败");
      const use = data.persona_use_hut || {};
      const inherit = use.chat !== false;
      paintProfileInheritUi(inherit);
      if (inherit) {
        if (cardTa) cardTa.value = String(data.persona_card || data.persona || "");
      } else {
        const local = (data.persona_apps && data.persona_apps.chat) || {};
        if (cardTa) cardTa.value = String(local.persona_card || local.persona || "");
      }
    } catch (err) {
      shellToast((err && err.message) || "读取资料失败");
    }
    showChatOverlay("chatOvProfile");
  }
  async function saveProfilePage() {
    const cardTa = document.getElementById("chatPersonaCardInput");
    const useCb = document.getElementById("chatPersonaUseHut");
    if (!cardTa) return;
    const persona_card = String(cardTa.value || "").slice(0, 12000);
    const inherit = !useCb || useCb.checked;
    const body = { persona_use_hut: { chat: inherit } };
    if (inherit) {
      body.persona_card = persona_card;
      body.persona = "";
    } else {
      body.persona_apps = { chat: { persona: "", persona_card } };
    }
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      shellToast("已保存");
      backFromProfile();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }
  function backFromProfile() {
    const ret = chatSubReturn;
    chatSubReturn = null;
    const el = document.getElementById("chatOvProfile");
    if (el) {
      el.classList.remove("active");
      el.hidden = true;
    }
    if (ret === "peer") {
      openPeerPage();
      return;
    }
    closeShellOverlays();
  }
  function paintPeerPageLabels() {
    const pinVal = document.getElementById("chatPeerPinVal");
    const muteVal = document.getElementById("chatPeerMuteVal");
    if (pinVal) pinVal.textContent = readPins().includes("daily") ? "开" : "关";
    if (muteVal) muteVal.textContent = readMutes().includes("daily") ? "开" : "关";
    refreshPeerLabels();
  }
  function openPeerPage() {
    closeSessMenu();
    closeHist({ skipReturn: true });
    chatSubReturn = null;
    histReturnTo = null;
    paintPeerPageLabels();
    showChatOverlay("chatOvPeer");
  }
  function closePeerPage() {
    const el = document.getElementById("chatOvPeer");
    if (!el) return;
    el.classList.remove("active");
    el.hidden = true;
  }
  function runPeerAct(act) {
    if (act === "profile") {
      openProfilePage("peer");
      return;
    }
    if (act === "world") {
      openWorldPage("peer");
      return;
    }
    if (act === "moments") {
      goChatTab("moments");
      return;
    }
    if (act === "hist") {
      histReturnTo = "peer";
      closePeerPage();
      if (!threadLayerOpen()) openThreadLayer();
      openHist();
      return;
    }
    if (act === "note") {
      const cur = readNote("daily");
      const next = window.prompt("备注名（空=清除）", cur || "");
      if (next == null) return;
      writeNote("daily", next);
      refreshPeerLabels();
      paintPeerPageLabels();
      shellToast(next.trim() ? "已设备注" : "已清除备注");
      return;
    }
    if (act === "bg") {
      const inp = document.getElementById("chatBgInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
      return;
    }
    if (act === "pin") {
      toggleSessionPin("daily");
      paintPeerPageLabels();
      return;
    }
    if (act === "mute") {
      toggleSessionMute("daily").then(() => paintPeerPageLabels());
      return;
    }
  }
  function escapeWorldHtml(s) {
    return escapeHtml(s);
  }
  async function readChatDocx(file) {
    const res = await fetch("/api/v1/import/docx", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || "docx 导入失败");
    return String(data.text || "");
  }
  function paintChatWorldBooks(books, activeCap) {
    const list = document.getElementById("chatWorldList");
    if (!list) return;
    if (!books.length) {
      list.innerHTML = '<p class="chat-hint-line">还没有世界书。导入 JSON / txt / docx。</p>';
      return;
    }
    const cap = activeCap || 3;
    list.innerHTML = books
      .map((b) => {
        const id = String(b.id || "").replace(/"/g, "");
        const nm = escapeWorldHtml(b.name || "未命名");
        const fn = String(b.filename || "").trim();
        const n = Number(b.entry_count) || 0;
        const meta = n + " 条" + (fn ? " · " + escapeWorldHtml(fn) : "");
        return (
          '<div class="chat-world-row" data-world-id="' +
          id +
          '"><input type="checkbox" class="chat-world-active" ' +
          (b.active ? "checked " : "") +
          'title="最多 ' +
          cap +
          ' 本" /><span class="nm" title="' +
          nm +
          '">' +
          nm +
          '</span><span class="meta">' +
          meta +
          '</span><button type="button" class="chat-world-del">删</button></div>'
        );
      })
      .join("");
  }
  async function openWorldPage(returnTo) {
    const el = document.getElementById("chatOvWorld");
    if (!el) return;
    chatSubReturn = returnTo || null;
    const en = document.getElementById("chatWorldEnabled");
    const depth = document.getElementById("chatWorldScanDepth");
    const bud = document.getElementById("chatWorldBudget");
    if (en) en.checked = false;
    if (depth) depth.value = "4";
    if (bud) bud.value = "6000";
    paintChatWorldBooks([], 3);
    try {
      const [sRes, wRes] = await Promise.all([
        fetch("/api/v1/settings", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/v1/world", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const s = await sRes.json().catch(() => ({}));
      const w = await wRes.json().catch(() => ({}));
      if (!sRes.ok) throw new Error(s.message || "读取设定失败");
      if (!wRes.ok) throw new Error(w.message || "读取世界书失败");
      if (en) en.checked = !!s.worldbook_enabled;
      if (depth) depth.value = String(s.worldbook_scan_depth != null ? s.worldbook_scan_depth : 4);
      if (bud) bud.value = String(s.worldbook_budget_chars != null ? s.worldbook_budget_chars : 6000);
      paintChatWorldBooks(w.books || [], w.active_cap || 3);
    } catch (err) {
      shellToast((err && err.message) || "读取世界书失败");
    }
    showChatOverlay("chatOvWorld");
  }
  async function saveWorldPage() {
    const en = document.getElementById("chatWorldEnabled");
    const depth = document.getElementById("chatWorldScanDepth");
    const bud = document.getElementById("chatWorldBudget");
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worldbook_enabled: !!(en && en.checked),
          worldbook_scan_depth: Number(depth && depth.value) || 0,
          worldbook_budget_chars: Number(bud && bud.value) || 6000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      shellToast("已保存");
      backFromWorld();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }
  function backFromWorld() {
    const ret = chatSubReturn;
    chatSubReturn = null;
    const el = document.getElementById("chatOvWorld");
    if (el) {
      el.classList.remove("active");
      el.hidden = true;
    }
    if (ret === "peer") {
      openPeerPage();
      return;
    }
    if (ret === "prefs") {
      openShellOverlay("chatOvPrefs");
      return;
    }
    closeShellOverlays();
  }
  async function onChatWorldFileChange(ev) {
    const input = ev && ev.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      const name = String(file.name || "");
      let text;
      if (/\.docx$/i.test(name)) text = await readChatDocx(file);
      else text = await file.text();
      const res = await fetch("/api/v1/world/books", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, name, filename: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "导入失败");
      paintChatWorldBooks(data.books || [], data.active_cap || 3);
      shellToast("已导入「" + ((data.book && data.book.name) || name) + "」");
    } catch (err) {
      shellToast((err && err.message) || "导入失败");
    } finally {
      if (input) input.value = "";
    }
  }
  async function onChatWorldListClick(ev) {
    const row = ev.target.closest(".chat-world-row");
    if (!row) return;
    const id = row.getAttribute("data-world-id");
    if (!id) return;
    if (ev.target.classList.contains("chat-world-del")) {
      try {
        const res = await fetch("/api/v1/world/books/" + encodeURIComponent(id), {
          method: "DELETE",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "删除失败");
        paintChatWorldBooks(data.books || [], data.active_cap || 3);
      } catch (err) {
        shellToast((err && err.message) || "删除失败");
      }
      return;
    }
    if (ev.target.classList.contains("chat-world-active")) {
      const active = !!ev.target.checked;
      try {
        const res = await fetch("/api/v1/world/books/" + encodeURIComponent(id), {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          ev.target.checked = !active;
          throw new Error(data.message || "更新失败");
        }
        paintChatWorldBooks(data.books || [], data.active_cap || 3);
      } catch (err) {
        shellToast((err && err.message) || "更新失败");
      }
    }
  }

  /* ========== Sess menu / search / calls / voice / pat ========== */
  function closeSessMenu() {
    const el = document.getElementById("chatSessMenu");
    if (el) el.hidden = true;
  }
  function openSessMenu() {
    const el = document.getElementById("chatSessMenu");
    if (!el) return;
    const pinBtn = document.getElementById("btnChatSessPin");
    const muteBtn = document.getElementById("btnChatSessMute");
    if (pinBtn) pinBtn.textContent = readPins().includes("daily") ? "取消置顶" : "置顶";
    if (muteBtn) muteBtn.textContent = readMutes().includes("daily") ? "关闭免打扰" : "消息免打扰";
    el.hidden = false;
  }
  async function runShellSearch(q) {
    const box = document.getElementById("chatShellSearchHits");
    if (!box) return;
    const query = String(q || "").trim();
    if (!query) {
      box.innerHTML = '<p class="chat-hint-line">搜聊天记录、联系人</p>';
      return;
    }
    box.textContent = "搜索中…";
    try {
      const res = await fetch("/api/v1/chat/search?q=" + encodeURIComponent(query), {
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "搜索失败");
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const peer = displayPeerName();
      let html = "";
      if (peer.indexOf(query) >= 0) {
        html +=
          '<button type="button" class="chat-search-hit" data-jump="contact"><div class="t">' +
          escapeHtml(peer) +
          '</div><div class="meta">联系人</div></button>';
      }
      html += msgs
        .slice(0, 40)
        .map(
          (m) =>
            '<button type="button" class="chat-search-hit" data-msg="' +
            escapeHtml(m.id || "") +
            '"><div class="t">' +
            escapeHtml(histPreview(m)) +
            '</div><div class="meta">' +
            escapeHtml(chatTimeLabel(m.ts)) +
            "</div></button>"
        )
        .join("");
      box.innerHTML = html || '<p class="chat-hint-line">没有结果</p>';
      box.querySelectorAll("[data-jump=contact]").forEach((b) => {
        b.addEventListener("click", () => {
          closeShellOverlays();
          openThreadLayer();
        });
      });
      box.querySelectorAll("[data-msg]").forEach((b) => {
        b.addEventListener("click", async () => {
          const id = b.getAttribute("data-msg");
          closeShellOverlays();
          openThreadLayer();
          await refreshChatThread();
          if (id) scrollToMessage(id);
        });
      });
    } catch (err) {
      box.innerHTML = '<p class="chat-hint-line">' + escapeHtml((err && err.message) || "搜索失败") + "</p>";
    }
  }
  function formatCallClockUi(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }
  function openCall(kind) {
    const modal = document.getElementById("chatCallModal");
    const kindEl = document.getElementById("chatCallKind");
    const peerEl = document.getElementById("chatCallPeer");
    const stateEl = document.getElementById("chatCallState");
    if (!modal) return;
    closeCallPicker();
    setPanels(null);
    const media = kind === "video" ? "video" : "voice";
    callSession = { media, phase: "invite", activeAt: 0, started: Date.now() };
    if (kindEl) kindEl.textContent = media === "video" ? "视频通话" : "语音通话";
    if (peerEl) peerEl.textContent = displayPeerName();
    if (stateEl) stateEl.textContent = "等待接听…";
    modal.hidden = false;
    if (callTimer) clearTimeout(callTimer);
    callTimer = setTimeout(() => {
      if (!callSession) return;
      callSession.phase = "active";
      callSession.activeAt = Date.now();
      if (stateEl) stateEl.textContent = "通话中…";
      callTimer = setInterval(() => {
        if (!callSession || callSession.phase !== "active") return;
        const sec = Math.floor((Date.now() - callSession.activeAt) / 1000);
        if (stateEl) stateEl.textContent = "通话中 " + formatCallClockUi(sec);
      }, 1000);
    }, 900);
    fetch("/api/v1/chat/call/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media, dir: "out" }),
    }).catch(() => {});
  }
  function closeCall() {
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = true;
    if (callTimer) {
      clearTimeout(callTimer);
      clearInterval(callTimer);
      callTimer = null;
    }
    const dur =
      callSession && callSession.activeAt
        ? Math.floor((Date.now() - callSession.activeAt) / 1000)
        : 0;
    const media = (callSession && callSession.media) || "voice";
    callSession = null;
    postChatPayload({
      kind: "call",
      media: media,
      phase: dur > 0 ? "ended" : "cancelled",
      durationSec: dur,
    }).catch(() => {});
  }
  function answerCallSession() {
    if (!callSession) return;
    callSession.phase = "active";
    callSession.activeAt = Date.now();
    const stateEl = document.getElementById("chatCallState");
    if (stateEl) stateEl.textContent = "通话中…";
  }
  function pickRecorderMime() {
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const m of cands) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m))
          return m;
      } catch (_) {}
    }
    return "";
  }
  async function beginVoiceHold() {
    const hold = document.getElementById("btnChatHold");
    if (hold) {
      hold.classList.add("is-pressing");
      hold.textContent = "松开 结束";
    }
    voiceChunks = [];
    voiceRec = null;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      voiceRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      voiceRec.ondataavailable = (e) => {
        if (e.data && e.data.size) voiceChunks.push(e.data);
      };
      voiceRec.start();
    } catch (_) {
      voiceRec = null;
    }
  }
  async function endVoiceHold() {
    const hold = document.getElementById("btnChatHold");
    if (hold) {
      hold.classList.remove("is-pressing");
      hold.textContent = "按住 说话";
    }
    if (!voiceRec) {
      shellToast("语音 · 本机不支持录音，已记备忘");
      return;
    }
    const rec = voiceRec;
    voiceRec = null;
    await new Promise((resolve) => {
      rec.onstop = resolve;
      try {
        rec.stop();
      } catch (_) {
        resolve();
      }
      try {
        rec.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    });
    const blob = new Blob(voiceChunks, { type: rec.mimeType || "audio/webm" });
    voiceChunks = [];
    if (blob.size < 200) {
      shellToast("太短了");
      return;
    }
    try {
      setComposerBusy(true);
      const res = await fetch("/api/v1/chat/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.message || "上传失败");
      setComposerBusy(false);
      await postChatPayload({ kind: "voice", body: data.url, duration: 2 });
    } catch (err) {
      setComposerBusy(false);
      shellToast((err && err.message) || "语音发送失败");
    }
  }
  async function sendPat() {
    try {
      await postChatPayload({ kind: "pat", body: "拍了拍" + displayPeerName() });
    } catch (_) {
      try {
        await fetch("/api/v1/chat/pat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        refreshChatThread();
      } catch (e) {
        shellToast("拍一拍 · 稍后");
      }
    }
  }
  function bindPatAvatar(row, msg) {
    if (!row || !msg || msg.from !== "bot") return;
    const av = row.querySelector(".av");
    if (!av || av.dataset.patBound) return;
    av.dataset.patBound = "1";
    av.addEventListener("dblclick", (e) => {
      e.preventDefault();
      sendPat();
    });
  }

  /* ========== Shell search helpers done; patch appendChatMessage hook via wrap ========== */
'''

# Patch appendChatMessage in core to call bindBubbleCtx + bindPatAvatar
core = core.replace(
    """    box.append(row);
    box.scrollTop = box.scrollHeight;
    return bubble;
  }

  function appendChatBubble""",
    """    box.append(row);
    bindBubbleCtx(bubble, msg);
    bindPatAvatar(row, msg);
    if (multiMode) syncMultiMarks();
    if (nearBottom || msg.from === "you") {
      box.scrollTop = box.scrollHeight;
      showNewMsgChip(false);
    } else if (msg.from === "bot") {
      showNewMsgChip(true);
    }
    return bubble;
  }

  function appendChatBubble""",
    1,
)

# Patch closeHist in core
core = core.replace(
    """  function closeHist() {
    const hist = document.getElementById("chatHist");
    if (hist) hist.hidden = true;
    if (histTimer) {
      clearTimeout(histTimer);
      histTimer = null;
    }
  }""",
    """  function closeHist(opts) {
    const hist = document.getElementById("chatHist");
    if (hist) hist.hidden = true;
    if (histTimer) {
      clearTimeout(histTimer);
      histTimer = null;
    }
    if (opts && opts.skipReturn) {
      histReturnTo = null;
      return;
    }
    const ret = histReturnTo;
    histReturnTo = null;
    if (ret === "peer") openPeerPage();
  }""",
    1,
)

# Patch setTyping to use displayPeerName
core = core.replace(
    """  function setTyping(on) {
    const peer = document.getElementById("chatPeerName");
    if (!peer) return;
    if (on) {
      if (!peer.dataset.peerName) {
        peer.dataset.peerName = peer.textContent || deps.getPeerName() || "家机";
      }
      peer.textContent = "正在输入中...";
      peer.classList.add("is-typing");
      return;
    }
    peer.textContent = peer.dataset.peerName || deps.getPeerName() || "家机";
    peer.classList.remove("is-typing");
    delete peer.dataset.peerName;
  }""",
    """  function setTyping(on) {
    const peer = document.getElementById("chatPeerName");
    if (!peer) return;
    if (on) {
      if (!peer.dataset.peerName) {
        peer.dataset.peerName = peer.textContent || displayPeerName() || "家机";
      }
      peer.textContent = "正在输入中...";
      peer.classList.add("is-typing");
      return;
    }
    peer.textContent = peer.dataset.peerName || displayPeerName() || "家机";
    peer.classList.remove("is-typing");
    delete peer.dataset.peerName;
  }""",
    1,
)

# Patch openCall in core — remove old simple openCall/closeCall since SHELL has them
# The core still has openCall/closeCall — SHELL defines them again later which would be duplicate.
# Remove openCall/closeCall from core.
core = re.sub(
    r"\n  function openCall\(kind\) \{.*?\n  function closeCall\(\) \{.*?\n  \}\n",
    "\n",
    core,
    count=1,
    flags=re.S,
)

# Patch onPlusItem to support file/music
core = core.replace(
    """  function onPlusItem(item) {
    if (!item.ok) {
      setChatErr(item.lab + "未开");
      return;
    }""",
    """  function onPlusItem(item) {
    if (!item || !item.ok) {
      if (item) shellToast(item.lab + " · 稍后");
      return;
    }""",
    1,
)
core = core.replace(
    """    if (item.id === "history") {
      openHist();
    }
  }""",
    """    if (item.id === "history") {
      openHist();
      return;
    }
    if (item.id === "file") {
      const inp = document.getElementById("chatFileInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
      return;
    }
    if (item.id === "music") {
      const inp = document.getElementById("chatMusicInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
      return;
    }
  }

  async function sendPickedFile(file, kind) {
    if (sending || !file) return;
    setChatErr("");
    setComposerBusy(true);
    try {
      const res = await fetch("/api/v1/chat/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.message || "上传失败");
      setComposerBusy(false);
      await postChatPayload({
        kind: kind === "music" ? "music" : "file",
        body: data.url,
        name: file.name || "",
      });
    } catch (e) {
      setChatErr((e && e.message) || "上传失败");
      setComposerBusy(false);
    }
  }""",
    1,
)

# Patch sendChatMessage to include quote + draft clear
core = core.replace(
    """  async function sendChatMessage() {
    if (sending) return;
    const input = document.getElementById("dailyChatInput");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (input) input.value = "";
    syncSendPlus();
    await postChatPayload({ kind: "text", body: body });
  }""",
    """  async function sendChatMessage() {
    if (sending) return;
    const input = document.getElementById("dailyChatInput");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (input) input.value = "";
    syncSendPlus();
    persistDraft();
    const payload = { kind: "text", body: body };
    if (pendingQuote) {
      payload.quote = { id: pendingQuote.id, who: pendingQuote.who, text: pendingQuote.text };
      clearPendingQuote();
    }
    await postChatPayload(payload);
  }""",
    1,
)

# Remove duplicate PLUS_ITEMS/HIST from core if any left at top — core starts at chatTimeLabel OK

BIND = r'''
  function bindShell() {
    document.querySelectorAll("#view-chat .chat-dock [data-chat-go]").forEach((b) => {
      b.addEventListener("click", () => goChatTab(b.getAttribute("data-chat-go")));
    });
    const home = document.getElementById("btnChatShellHome");
    if (home) home.addEventListener("click", () => deps.showView("home"));
    const add = document.getElementById("btnChatShellAdd");
    if (add) add.addEventListener("click", () => shellToast("单 peer 够用 · 多会话后置"));
    const sess = document.getElementById("btnChatSessHome");
    if (sess) {
      sess.addEventListener("click", () => openThreadLayer());
      bindLongPress(sess, () => openSessMenu());
    }
    const contact = document.getElementById("btnChatContactHome");
    if (contact) {
      contact.addEventListener("click", () => {
        openProfilePage();
      });
    }
    const profileBack = document.getElementById("btnChatProfileBack");
    if (profileBack) profileBack.addEventListener("click", () => backFromProfile());
    const profileSave = document.getElementById("btnChatProfileSave");
    if (profileSave) profileSave.addEventListener("click", () => saveProfilePage());
    const useHut = document.getElementById("chatPersonaUseHut");
    if (useHut) {
      useHut.addEventListener("change", () => paintProfileInheritUi(!!useHut.checked));
    }
    const openSearch = document.getElementById("btnChatShellSearch");
    if (openSearch) {
      openSearch.addEventListener("click", () => {
        openShellOverlay("chatOvSearch");
        const q = document.getElementById("chatShellSearchQ");
        if (q) q.value = "";
        runShellSearch("");
        if (q) q.focus();
      });
    }
    const searchClose = document.getElementById("btnChatShellSearchClose");
    if (searchClose) searchClose.addEventListener("click", () => closeShellOverlays());
    const searchQ = document.getElementById("chatShellSearchQ");
    if (searchQ) {
      searchQ.addEventListener("input", () => {
        if (shellSearchTimer) clearTimeout(shellSearchTimer);
        shellSearchTimer = setTimeout(() => runShellSearch(searchQ.value), 220);
      });
    }
    const compose = document.getElementById("btnChatMomCompose");
    if (compose) {
      compose.addEventListener("click", () => {
        resetComposeDraft();
        openShellOverlay("chatOvCompose");
      });
    }
    const composeBack = document.getElementById("btnChatComposeBack");
    if (composeBack) composeBack.addEventListener("click", () => closeShellOverlays());
    const composePost = document.getElementById("btnChatComposePost");
    if (composePost) composePost.addEventListener("click", () => postMomentUi());
    const composePhoto = document.getElementById("btnChatComposePhoto");
    if (composePhoto) {
      composePhoto.addEventListener("click", () => {
        const inp = document.getElementById("chatComposeFile");
        if (inp) {
          inp.value = "";
          inp.click();
        }
      });
    }
    const composeFile = document.getElementById("chatComposeFile");
    if (composeFile) {
      composeFile.addEventListener("change", async () => {
        const files = composeFile.files;
        if (!files || !files.length) return;
        try {
          for (const f of Array.from(files).slice(0, 9)) {
            const url = await uploadComposeImage(f);
            if (url) composeDraft.images.push(url);
          }
          paintComposeDraft();
        } catch (err) {
          shellToast((err && err.message) || "上传失败");
        }
      });
    }
    const composeScope = document.getElementById("btnChatComposeScope");
    if (composeScope) composeScope.addEventListener("click", () => openScopeSheet());
    const scopeScrim = document.getElementById("chatScopeScrim");
    if (scopeScrim) scopeScrim.addEventListener("click", closeScopeSheet);
    const scopeCancel = document.getElementById("btnChatScopeCancel");
    if (scopeCancel) scopeCancel.addEventListener("click", closeScopeSheet);
    const scopeOk = document.getElementById("btnChatScopeOk");
    if (scopeOk) {
      scopeOk.addEventListener("click", () => {
        const on = document.querySelector("#chatScopeModes .on[data-scope]");
        composeDraft.scope = (on && on.getAttribute("data-scope")) || "public";
        paintComposeDraft();
        closeScopeSheet();
      });
    }
    const scopeModes = document.getElementById("chatScopeModes");
    if (scopeModes) {
      scopeModes.addEventListener("click", (e) => {
        const b = e.target.closest("[data-scope]");
        if (!b) return;
        scopeModes.querySelectorAll("[data-scope]").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      });
    }
    const feed = document.getElementById("chatMomFeed");
    if (feed) {
      feed.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-compose-rm]");
        if (rm) return;
        const likeBtn = e.target.closest("[data-mom-like]");
        if (likeBtn) {
          likeMomentUi(likeBtn.getAttribute("data-mom-like"));
          return;
        }
        const cmtBtn = e.target.closest("[data-mom-cmt]");
        if (cmtBtn) {
          const id = cmtBtn.getAttribute("data-mom-cmt");
          const row = feed.querySelector('[data-mom-cmt-row="' + id + '"]');
          if (row) row.classList.toggle("open");
          return;
        }
        const send = e.target.closest("[data-mom-cmt-send]");
        if (send) {
          const id = send.getAttribute("data-mom-cmt-send");
          const input = send.parentElement && send.parentElement.querySelector("input");
          const txt = String((input && input.value) || "").trim();
          if (!txt) return;
          if (input) input.value = "";
          commentMomentUi(id, txt);
          return;
        }
        const del = e.target.closest("[data-mom-del]");
        if (del) {
          deleteMomentUi(del.getAttribute("data-mom-del"));
          return;
        }
        const sc = e.target.closest("[data-mom-scope]");
        if (sc) {
          toggleMomentScopeUi(sc.getAttribute("data-mom-scope"));
          return;
        }
        const img = e.target.closest(".chat-post-imgs img");
        if (img) {
          const imgs = Array.from(img.parentElement.querySelectorAll("img")).map((i) => i.src);
          openPicViewer(imgs, imgs.indexOf(img.src));
        }
      });
    }
    const composeImgs = document.getElementById("chatComposeImgs");
    if (composeImgs) {
      composeImgs.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-compose-rm]");
        if (!rm) return;
        const i = Number(rm.getAttribute("data-compose-rm"));
        composeDraft.images.splice(i, 1);
        paintComposeDraft();
      });
    }
    const fav = document.getElementById("btnChatFav");
    if (fav) {
      fav.addEventListener("click", () => {
        renderFavList();
        openShellOverlay("chatOvFav");
      });
    }
    const favBack = document.getElementById("btnChatFavBack");
    if (favBack) favBack.addEventListener("click", () => closeShellOverlays());
    const prefs = document.getElementById("btnChatPrefs");
    if (prefs) {
      prefs.addEventListener("click", () => {
        loadChatPrefsUi();
        openShellOverlay("chatOvPrefs");
      });
    }
    const prefsBack = document.getElementById("btnChatPrefsBack");
    if (prefsBack) prefsBack.addEventListener("click", () => closeShellOverlays());
    const wallet = document.getElementById("btnChatWallet");
    if (wallet) {
      wallet.addEventListener("click", () => {
        try {
          deps.showView("wallet");
        } catch (_) {
          shellToast("跳转资产");
        }
      });
    }
    const bank = document.getElementById("btnChatBank");
    if (bank) {
      bank.addEventListener("click", () => {
        try {
          deps.showView("wallet");
        } catch (_) {
          shellToast("跳转资产");
        }
      });
    }
    const togSound = document.getElementById("chatTogSound");
    if (togSound) {
      togSound.addEventListener("click", () => {
        togSound.classList.toggle("on");
        lsSet(LS.sound, togSound.classList.contains("on") ? "1" : "0");
        shellToast(togSound.classList.contains("on") ? "提示音开" : "提示音关");
      });
    }
    const togRead = document.getElementById("chatTogRead");
    if (togRead) {
      togRead.addEventListener("click", () => {
        togRead.classList.toggle("on");
        lsSet(LS.clearRead, togRead.classList.contains("on") ? "1" : "0");
      });
    }
    const togSlow = document.getElementById("chatTogSlow");
    if (togSlow) {
      togSlow.addEventListener("click", () => {
        const on = !togSlow.classList.contains("on");
        togSlow.classList.toggle("on", on);
        patchChatPrefs({ slow_reply: on });
      });
    }
    const btnBg = document.getElementById("btnChatBg");
    if (btnBg) {
      btnBg.addEventListener("click", () => {
        const inp = document.getElementById("chatBgInput");
        if (inp) {
          inp.value = "";
          inp.click();
        }
      });
    }
    const bgInp = document.getElementById("chatBgInput");
    if (bgInp) {
      bgInp.addEventListener("change", () => {
        const f = bgInp.files && bgInp.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          lsSet(LS.bgPick, String(reader.result || ""));
          applyChatBg();
          loadChatPrefsUi();
          shellToast("已设聊天背景");
        };
        reader.readAsDataURL(f);
      });
    }
    const worldPrefs = document.getElementById("btnChatWorldPrefs");
    if (worldPrefs) worldPrefs.addEventListener("click", () => openWorldPage("prefs"));
    const btnClear = document.getElementById("btnChatClear");
    if (btnClear) {
      btnClear.addEventListener("click", () => {
        const sheet = document.getElementById("chatClearSheet");
        const name = document.getElementById("chatClearPeerName");
        if (name) name.textContent = displayPeerName();
        if (sheet) sheet.hidden = false;
      });
    }
    const clearScrim = document.getElementById("chatClearScrim");
    if (clearScrim) {
      clearScrim.addEventListener("click", () => {
        const sheet = document.getElementById("chatClearSheet");
        if (sheet) sheet.hidden = true;
      });
    }
    const clearCancel = document.getElementById("btnChatClearCancel");
    if (clearCancel) {
      clearCancel.addEventListener("click", () => {
        const sheet = document.getElementById("chatClearSheet");
        if (sheet) sheet.hidden = true;
      });
    }
    const clearOk = document.getElementById("btnChatClearOk");
    if (clearOk) clearOk.addEventListener("click", () => clearChatHistoryUi());
    const worldBack = document.getElementById("btnChatWorldBack");
    if (worldBack) worldBack.addEventListener("click", () => backFromWorld());
    const worldSave = document.getElementById("btnChatWorldSave");
    if (worldSave) worldSave.addEventListener("click", () => saveWorldPage());
    const worldFile = document.getElementById("chatWorldFile");
    if (worldFile) worldFile.addEventListener("change", onChatWorldFileChange);
    const worldList = document.getElementById("chatWorldList");
    if (worldList) worldList.addEventListener("click", onChatWorldListClick);
    const peerBack = document.getElementById("btnChatPeerBack");
    if (peerBack) {
      peerBack.addEventListener("click", () => {
        closePeerPage();
        if (!threadLayerOpen()) openThreadLayer();
      });
    }
    document.querySelectorAll("#chatOvPeer [data-peer-act]").forEach((b) => {
      b.addEventListener("click", () => runPeerAct(b.getAttribute("data-peer-act")));
    });
    const sessScrim = document.getElementById("chatSessMenuScrim");
    if (sessScrim) sessScrim.addEventListener("click", closeSessMenu);
    const sessPin = document.getElementById("btnChatSessPin");
    if (sessPin) {
      sessPin.addEventListener("click", () => {
        toggleSessionPin("daily");
        closeSessMenu();
      });
    }
    const sessMute = document.getElementById("btnChatSessMute");
    if (sessMute) {
      sessMute.addEventListener("click", () => {
        toggleSessionMute("daily");
        closeSessMenu();
      });
    }
    const sessUnread = document.getElementById("btnChatSessUnread");
    if (sessUnread) {
      sessUnread.addEventListener("click", () => {
        const marks = readUnreadMarks();
        marks.daily = true;
        writeUnreadMarks(marks);
        paintShellUnread(0);
        closeSessMenu();
        shellToast("已标为未读");
      });
    }
    const ctxScrim = document.getElementById("chatCtxScrim");
    if (ctxScrim) ctxScrim.addEventListener("click", closeCtxMenu);
    const ctxPanel = document.getElementById("chatCtxPanel");
    if (ctxPanel) {
      ctxPanel.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ctx]");
        if (!b) return;
        runCtxAction(b.getAttribute("data-ctx"));
      });
    }
    const reactScrim = document.getElementById("chatReactScrim");
    if (reactScrim) {
      reactScrim.addEventListener("click", () => {
        const s = document.getElementById("chatReactSheet");
        if (s) s.hidden = true;
      });
    }
    const reactCancel = document.getElementById("btnChatReactCancel");
    if (reactCancel) {
      reactCancel.addEventListener("click", () => {
        const s = document.getElementById("chatReactSheet");
        if (s) s.hidden = true;
      });
    }
    const fwdScrim = document.getElementById("chatFwdScrim");
    if (fwdScrim) fwdScrim.addEventListener("click", closeFwdSheet);
    const fwdCancel = document.getElementById("btnChatFwdCancel");
    if (fwdCancel) fwdCancel.addEventListener("click", closeFwdSheet);
    const fwdOk = document.getElementById("btnChatFwdOk");
    if (fwdOk) {
      fwdOk.addEventListener("click", () => {
        closeFwdSheet();
        shellToast("已转发（单 peer 示意）");
        exitMultiMode();
      });
    }
    const picView = document.getElementById("chatPicView");
    if (picView) {
      picView.addEventListener("click", (e) => {
        if (e.target.id === "chatPicView" || e.target.id === "chatPicViewImg") closePicViewer();
      });
    }
    const picPrev = document.getElementById("chatPicPrev");
    if (picPrev) picPrev.addEventListener("click", (e) => {
      e.stopPropagation();
      stepPic(-1);
    });
    const picNext = document.getElementById("chatPicNext");
    if (picNext) picNext.addEventListener("click", (e) => {
      e.stopPropagation();
      stepPic(1);
    });
  }

  function bind() {
    if (bound) return;
    bound = true;
    bindShell();
    const back = document.getElementById("btnChatBack");
    if (back) back.addEventListener("click", () => closeThreadLayer());
    const more = document.getElementById("btnChatPeerMore");
    if (more) more.addEventListener("click", () => openPeerPage());
    const quoteClear = document.getElementById("btnChatQuoteClear");
    if (quoteClear) quoteClear.addEventListener("click", () => clearPendingQuote());
    const newMsg = document.getElementById("chatNewMsg");
    if (newMsg) {
      newMsg.addEventListener("click", () => {
        scrollToLatest();
        showNewMsgChip(false);
      });
    }
    const thread = document.getElementById("chatThread");
    if (thread) {
      thread.addEventListener(
        "scroll",
        () => {
          nearBottom = threadNearBottom();
          if (nearBottom) showNewMsgChip(false);
        },
        { passive: true }
      );
    }
    const form = document.getElementById("chatForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendChatMessage();
      });
    }
    const input = document.getElementById("dailyChatInput");
    if (input) {
      input.addEventListener("input", () => {
        syncSendPlus();
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(persistDraft, 300);
      });
      input.addEventListener("focus", () => {
        const stick = document.getElementById("chatStickerPanel");
        const plus = document.getElementById("chatPlusPanel");
        const sheet = document.getElementById("chatSheet");
        const stickBtn = document.getElementById("btnChatSticker");
        const plusBtn = document.getElementById("btnChatPlus");
        if (stick) stick.hidden = true;
        if (plus) plus.hidden = true;
        if (sheet) sheet.hidden = true;
        sheetMode = "";
        if (stickBtn) stickBtn.setAttribute("aria-pressed", "false");
        if (plusBtn) plusBtn.setAttribute("aria-pressed", "false");
      });
      const clearLong = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      };
      input.addEventListener("pointerdown", () => {
        clearLong();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          setVoiceMode(true);
        }, 480);
      });
      input.addEventListener("pointerup", clearLong);
      input.addEventListener("pointerleave", clearLong);
      input.addEventListener("pointercancel", clearLong);
    }
    const hold = document.getElementById("btnChatHold");
    if (hold) {
      hold.addEventListener("contextmenu", (e) => e.preventDefault());
      hold.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        beginVoiceHold();
      });
      const endHold = () => {
        if (!hold.classList.contains("is-pressing") && !voiceRec) return;
        endVoiceHold();
      };
      hold.addEventListener("pointerup", endHold);
      hold.addEventListener("pointerleave", endHold);
      hold.addEventListener("pointercancel", endHold);
    }
    const stick = document.getElementById("btnChatSticker");
    if (stick) {
      stick.addEventListener("click", () => {
        if (voiceMode) {
          setVoiceMode(false);
          return;
        }
        toggleStickerPanel();
      });
    }
    const plus = document.getElementById("btnChatPlus");
    if (plus) plus.addEventListener("click", () => togglePlusPanel());
    const hang = document.getElementById("chatCallHang");
    if (hang) hang.addEventListener("click", closeCall);
    const answer = document.getElementById("chatCallAnswer");
    if (answer) answer.addEventListener("click", answerCallSession);
    const pickVoice = document.getElementById("chatCallPickVoice");
    if (pickVoice) pickVoice.addEventListener("click", () => openCall("voice"));
    const pickVideo = document.getElementById("chatCallPickVideo");
    if (pickVideo) pickVideo.addEventListener("click", () => openCall("video"));
    const pickCancel = document.getElementById("chatCallPickCancel");
    if (pickCancel) pickCancel.addEventListener("click", closeCallPicker);
    const histCancel = document.getElementById("chatHistCancel");
    if (histCancel) histCancel.addEventListener("click", () => closeHist());
    const histQ = document.getElementById("chatHistQ");
    if (histQ) {
      histQ.addEventListener("input", () => {
        if (histTimer) clearTimeout(histTimer);
        histTimer = setTimeout(() => {
          const q = String(histQ.value || "").trim();
          if (q) histDay = "";
          if (!q && histKind === "all" && !histDay) {
            showHistHome();
            return;
          }
          runHistSearch();
        }, 220);
      });
    }
    const dateBack = document.getElementById("chatHistDateBack");
    if (dateBack) dateBack.addEventListener("click", () => showHistHome());
    const calJump = document.getElementById("chatHistCalJump");
    const calMonth = document.getElementById("chatHistCalMonth");
    if (calJump && calMonth) {
      calJump.addEventListener("click", () => {
        try {
          if (typeof calMonth.showPicker === "function") calMonth.showPicker();
          else calMonth.focus();
        } catch (_) {
          calMonth.focus();
        }
      });
      calMonth.addEventListener("change", () => {
        const v = String(calMonth.value || "");
        if (!/^\d{4}-\d{2}$/.test(v)) return;
        const sec = document.querySelector('#chatHistCal .wx-cal-month[data-ym="' + v + '"]');
        if (sec) {
          sec.scrollIntoView({ block: "start" });
          const [y, m] = v.split("-").map(Number);
          setCalJumpLab(y, m - 1);
        }
      });
    }
    const calScroll = document.getElementById("chatHistCal");
    if (calScroll) {
      calScroll.addEventListener(
        "scroll",
        () => {
          const months = calScroll.querySelectorAll(".wx-cal-month");
          let hit = null;
          const top = calScroll.scrollTop + 8;
          for (const sec of months) {
            if (sec.offsetTop <= top) hit = sec;
          }
          if (hit && hit.dataset.ym) {
            const [y, m] = hit.dataset.ym.split("-").map(Number);
            setCalJumpLab(y, m - 1);
          }
        },
        { passive: true }
      );
    }
    const img = document.getElementById("chatImageInput");
    if (img) {
      img.addEventListener("change", () => {
        const f = img.files && img.files[0];
        if (f) sendPickedImage(f);
      });
    }
    const cam = document.getElementById("chatCameraInput");
    if (cam) {
      cam.addEventListener("change", () => {
        const f = cam.files && cam.files[0];
        if (f) sendPickedImage(f);
      });
    }
    const fileInp = document.getElementById("chatFileInput");
    if (fileInp) {
      fileInp.addEventListener("change", () => {
        const f = fileInp.files && fileInp.files[0];
        if (f) sendPickedFile(f, "file");
      });
    }
    const musicInp = document.getElementById("chatMusicInput");
    if (musicInp) {
      musicInp.addEventListener("change", () => {
        const f = musicInp.files && musicInp.files[0];
        if (f) sendPickedFile(f, "music");
      });
    }
    const stIn = document.getElementById("chatStickerInput");
    if (stIn) {
      stIn.addEventListener("change", () => {
        const f = stIn.files && stIn.files[0];
        if (f) uploadUserSticker(f);
      });
    }
    const cancel = document.getElementById("chatSheetCancel");
    if (cancel) cancel.addEventListener("click", closeSheet);
    const ok = document.getElementById("chatSheetOk");
    if (ok) ok.addEventListener("click", () => confirmSheet());
    const multiDel = document.getElementById("chatMultiDel");
    if (multiDel) multiDel.addEventListener("click", () => multiDeleteUi());
    const multiCopy = document.getElementById("chatMultiCopy");
    if (multiCopy) multiCopy.addEventListener("click", () => multiCopyUi());
    const multiFwd = document.getElementById("chatMultiFwd");
    if (multiFwd) {
      multiFwd.addEventListener("click", () => {
        openFwdSheet(Array.from(multiIds).map((id) => ({ refId: id, text: id })));
      });
    }
    syncSendPlus();
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    try {
      bind();
    } catch (err) {
      try {
        console.error("[ChatApp.mount]", err);
      } catch (_) {}
    }
    try {
      syncShellAvatars();
      applyChatBg();
    } catch (_) {}
  }

  global.ChatApp = {
    mount: mount,
    onShow: onShowChatShell,
    refreshThread: refreshChatThread,
    noteBotPing: noteBotPing,
  };
})(typeof window !== "undefined" ? window : globalThis);
'''

# Strip old PLUS/HIST/state from DISK header — we use HEADER
# Remove leading state from core if it somehow includes old consts — core starts at chatTimeLabel

# Fix: core still has old openCall if regex failed — check
if "function openCall(" in core:
    print("WARN: openCall still in core, stripping...")
    core = re.sub(
        r"\n  function openCall\(kind\) \{[\s\S]*?\n  function closeCall\(\) \{[\s\S]*?\n  \}\n",
        "\n",
        core,
        count=1,
    )

final = HEADER + "\n" + core + "\n" + SHELL + "\n" + BIND

# Deduplicate function definitions: keep last occurrence for known shell fns that might also be in core
# Actually openCall should only be in SHELL now.

OUT.write_text(final, encoding="utf-8", newline="\n")
print("Wrote", OUT, "lines", final.count("\n") + 1, "bytes", OUT.stat().st_size)

# quick sanity
for name in [
    "openThreadLayer",
    "goChatTab",
    "postChatPayload",
    "openWorldPage",
    "openPeerPage",
    "displayPeerName",
    "bindShell",
    "ChatApp",
]:
    print(name, final.count(name))
