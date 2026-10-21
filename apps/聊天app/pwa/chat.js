/**
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
  let regenBusy = false;
  let recallBusy = false;
  const RECALL_MAX_AGE_MS = 2 * 60 * 1000;
  let sheetMode = "";
  let sheetYouBalance = null;
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
  let reactMsgId = "";
  let multiMode = false;
  let multiIds = new Set();
  let pendingQuote = null;
  let callSession = null;
  let voiceRec = null;
  let voiceChunks = [];
  let voiceHoldStarted = 0;
  let picUrls = [];
  let picIdx = 0;
  let draftTimer = null;
  let nearBottom = true;
  let newMsgPending = 0;
  let suppressNewCount = false;
  let activePeerId = "daily";
  let peersCache = null;
  let menuSessId = "daily";

  const LS = {
    pins: "ariadne.chat.pins",
    mute: "ariadne.chat.mute",
    unreadMark: "ariadne.chat.unread.mark",
    peerNotes: "ariadne.chat.peerNotes",
    bgPick: "ariadne.chat.bg.pick",
    sound: "ariadne.chat.sound",
    clearRead: "ariadne.chat.clearRead",
    activePeer: "ariadne.chat.activePeer",
  };
  function draftKey(peerId) {
    return "ariadne.chat.draft." + String(peerId || activePeerId || "daily");
  }
  const NOTE_KEY = LS.peerNotes;
  const PIN_KEY = LS.pins;
  const MUTE_KEY = LS.mute;
  const UNREAD_MARK_KEY = LS.unreadMark;

  const PLUS_ITEMS = [
    { id: "request_song", lab: "点歌", tile: "点歌", ok: true },
    { id: "album", lab: "相册", tile: "相册", ok: true },
    { id: "camera", lab: "拍摄", tile: "拍摄", ok: true },
    { id: "location", lab: "位置", tile: "位置", ok: true },
    { id: "redpacket", lab: "红包", tile: "红包", ok: true },
    { id: "transfer", lab: "转账", tile: "转账", ok: true },
    { id: "call", lab: "通话", tile: "通话", ok: true },
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


  function chatTimeLabel(ts) {
    const d = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return (
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function timeBucket(ts) {
    return Math.floor((Number(ts) || 0) / 300000);
  }

  function appendUnreadBar() {
    const box = document.getElementById("chatThread");
    if (!box || box.querySelector(".wx-unread-bar")) return;
    const t = document.createElement("div");
    t.className = "wx-unread-bar";
    t.textContent = "以下是新消息";
    box.append(t);
  }

  function appendTimeChip(ts) {
    const box = document.getElementById("chatThread");
    if (!box) return;
    const bucket = timeBucket(ts);
    if (bucket === lastTimeBucket) return;
    lastTimeBucket = bucket;
    const t = document.createElement("div");
    t.className = "wx-time";
    t.textContent = chatTimeLabel(ts);
    box.append(t);
  }

  /** 删消息后清掉后面没有气泡的时间戳（否则要重进会话才没） */
  function pruneOrphanTimeChips(box) {
    const root = box || document.getElementById("chatThread");
    if (!root) return;
    let el = root.firstElementChild;
    while (el) {
      const next = el.nextElementSibling;
      if (el.classList && el.classList.contains("wx-time")) {
        const fol = next;
        if (!fol || !fol.classList.contains("wx-row")) {
          el.remove();
          el = next;
          continue;
        }
      }
      el = next;
    }
  }

  function humanizeChatNetErr(raw) {
    const m = String(raw || "").trim();
    const low = m.toLowerCase();
    if (
      !m ||
      low === "failed to fetch" ||
      low === "network error" ||
      low === "load failed" ||
      low.includes("networkerror") ||
      low.includes("network error")
    ) {
      return "连不上家机 · 确认电脑网关已开、手机同网后点这里清掉";
    }
    return m.slice(0, 160);
  }
  /* ponytail: 网络错文案自检 */
  (function () {
    if (!/家机/.test(humanizeChatNetErr("network error"))) throw new Error("netErr");
    if (humanizeChatNetErr("余额不足") !== "余额不足") throw new Error("netErrKeep");
  })();

  function setChatErr(text) {
    const el = document.getElementById("chatErr");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = humanizeChatNetErr(text);
  }

  function peerQuery(extra) {
    const q = new URLSearchParams(extra || {});
    q.set("peer", activePeerId || "daily");
    return q.toString();
  }
  function withPeerBody(payload) {
    const out = Object.assign({}, payload || {});
    out.peer = activePeerId || "daily";
    return out;
  }
  function setActivePeer(id) {
    const next = String(id || "daily").trim() || "daily";
    if (next === activePeerId) return;
    persistDraft();
    activePeerId = next;
    try {
      localStorage.setItem(LS.activePeer, next);
    } catch (_) {}
    pendingQuote = null;
    nearBottom = true;
    newMsgPending = 0;
    setNewMsgChip(0);
  }
  function peerDisplayName(peerId) {
    const id = String(peerId || activePeerId || "daily");
    const note = readNote(id);
    if (note) return note;
    const hit = (peersCache || []).find((p) => p && p.id === id);
    if (hit && hit.name) return hit.name;
    if (id === "daily") return deps.getPeerName() || "家机";
    return id;
  }
  async function fetchPeers() {
    const res = await fetch("/api/v1/chat/peers", { credentials: "same-origin" });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) throw new Error(data.message || data.error || "会话列表失败");
    peersCache = Array.isArray(data.peers) ? data.peers : [];
    return peersCache;
  }
  async function fetchChatMessages() {
    const res = await fetch("/api/v1/chat/messages?" + peerQuery(), {
      credentials: "same-origin",
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      if (res.status === 404) throw new Error("聊天接口未就绪：请重启 npm start 后再试");
      if (res.status === 401 || data.error === "gate_locked") {
        throw new Error(data.message || "请先解锁访问密码");
      }
      throw new Error(data.message || data.error || "读取失败");
    }
    return Array.isArray(data.messages) ? data.messages : [];
  }

  async function fetchStickers(force) {
    if (stickerCache && !force) return stickerCache;
    const res = await fetch("/api/v1/chat/stickers", { credentials: "same-origin" });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) throw new Error(data.message || "贴纸包加载失败");
    stickerCache = Array.isArray(data.stickers) ? data.stickers : [];
    return stickerCache;
  }

  function stickerSrc(id) {
    const pack = stickerCache || [];
    const hit = pack.find((s) => s.id === id);
    return hit ? hit.src : "";
  }

  function chatViewActive() {
    const el = document.getElementById("view-chat");
    return !!(el && el.classList.contains("active"));
  }

  async function markChatRead() {
    const pid = activePeerId || "daily";
    try {
      await fetch("/api/v1/chat/read", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer: pid }),
      });
    } catch (_) {}
    try {
      const marks = readUnreadMarks();
      if (marks[pid]) {
        delete marks[pid];
        writeUnreadMarks(marks);
      }
    } catch (_) {}
    try {
      deps.onUnreadChange();
    } catch (_) {}
  }

  function notifyUnread() {
    try {
      deps.onUnreadChange();
    } catch (_) {}
  }

  function moneyText(amount) {
    const n = Number(amount) || 0;
    return "¥" + n.toFixed(2);
  }

  function fileExtLabel(name) {
    const m = String(name || "").match(/\.([^.]+)$/);
    return m ? m[1].toUpperCase() : "";
  }

  function formatFileSize(bytes) {
    const b = Math.max(0, Number(bytes) || 0);
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) {
      const kb = b / 1024;
      return (kb >= 100 ? Math.round(kb) : kb.toFixed(kb >= 10 ? 0 : 1)) + " KB";
    }
    const mb = b / (1024 * 1024);
    return mb.toFixed(mb >= 10 ? 0 : 1) + " MB";
  }

  function fileMetaLine(p, name) {
    const size = formatFileSize(p && p.size);
    const ext = String((p && p.ext) || fileExtLabel(name) || "").trim();
    if (size && ext) return size + " · " + ext;
    return size || ext || "";
  }

  function moneyTagText(kind, msg) {
    const st = (msg && msg.payload && msg.payload.status) || "received";
    const received = st !== "sent";
    const fromYou = msg && msg.from === "you";
    if (kind === "redpacket") {
      if (!received) return "薄巧红包";
      return fromYou ? "已被领取" : "已领取";
    }
    if (!received) return "转账";
    return fromYou ? "已被接收" : "已收款";
  }

  function setTyping(on) {
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
  }

  function appendMoneyTip(text, ts, msgId) {
    const box = document.getElementById("chatThread");
    if (!box || !text) return null;
    const empty = box.querySelector(".wx-empty");
    if (empty) empty.remove();
    const tip = document.createElement("div");
    tip.className = "wx-sys-tip";
    tip.textContent = text;
    tip.dataset.ts = String(ts || Date.now());
    if (msgId) tip.dataset.msgId = String(msgId);
    box.append(tip);
    box.scrollTop = box.scrollHeight;
    return tip;
  }

  function rowBubble(row) {
    if (!row) return null;
    return (
      row.querySelector(":scope > .bubble") ||
      row.querySelector(":scope > .wx-col > .wx-voice-line > .bubble") ||
      row.querySelector(":scope > .wx-col > .bubble") ||
      row.querySelector(".bubble")
    );
  }
  function patchMessageBubble(msg) {
    if (!msg || !msg.id) return;
    const box = document.getElementById("chatThread");
    if (!box) return;
    const row = box.querySelector('.wx-row[data-msg-id="' + msg.id + '"]');
    if (!row) return;
    const bubble = rowBubble(row);
    if (bubble) fillBubble(bubble, msg);
    paintVoiceAsr(row, msg);
    paintQuoteRef(row, msg);
    const col = row.querySelector(".wx-col");
    if (col) syncVariantBar(col, msg);
  }

  function bubbleTextEl(bubble) {
    let t = bubble.querySelector(".wx-bubble-text");
    if (!t) {
      t = document.createElement("span");
      t.className = "wx-bubble-text";
      const bunny = bubble.querySelector(".wx-bunny-deco");
      if (bunny) bubble.insertBefore(t, bunny);
      else bubble.append(t);
    }
    return t;
  }

  function recallPeekText(msg) {
    if (!msg || !msg.recalled) return "";
    if (msg.recall_sight !== "peek") return "";
    return String(msg.peek_body || "").trim();
  }
  (function checkRecallPeek() {
    if (recallPeekText({ recalled: true, recall_sight: "miss", peek_body: "x" }) !== "")
      throw new Error("miss");
    if (recallPeekText({ recalled: true, recall_sight: "peek", peek_body: "  hi " }) !== "hi")
      throw new Error("peek");
    if (recallPeekText({ recalled: false, recall_sight: "peek", peek_body: "hi" }) !== "")
      throw new Error("open");
    if (recallPeekText({ recalled: true, recall_sight: "peek", peek_body: "  " }) !== "")
      throw new Error("blank");
  })();
  function fillBubble(bubble, msg) {
    const keepBunny = bubble.querySelector(".wx-bunny-deco");
    bubble.replaceChildren();
    bubble.classList.remove("is-media", "is-card", "is-voice", "has-think");
    bubble.style.minWidth = "";
    const kind = (msg && msg.kind) || "text";
    const finish = () => {
      if (keepBunny) {
        bubble.classList.add("has-think");
        bubble.append(keepBunny);
      }
    };
    if (kind === "sticker") {
      bubble.classList.add("is-media");
      const img = document.createElement("img");
      img.className = "sticker";
      img.alt = "贴纸";
      img.src = stickerSrc(msg.body) || "";
      bubble.append(img);
      finish();
      return;
    }
    if (kind === "image") {
      bubble.classList.add("is-media");
      const img = document.createElement("img");
      img.className = "chat-pic";
      img.alt = "图片";
      img.src = msg.body || "";
      bubble.append(img);
      finish();
      return;
    }
    if (kind === "redpacket" || kind === "transfer") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const received = p.status !== "sent";
      const isReceipt = !!p.is_receipt;
      const claimable = !isReceipt && msg.from === "bot" && !received;
      const isRp = kind === "redpacket";
      const card = document.createElement("div");
      card.className =
        "wx-money-card " +
        (isRp ? "is-redpacket" : "is-transfer") +
        (isReceipt ? " is-receipt" : "") +
        (received ? " is-received" : "") +
        (claimable || (isRp && !isReceipt) ? " is-claimable" : "");
      if (isRp) {
        const ico = document.createElement("div");
        ico.className = "ico";
        ico.setAttribute("aria-hidden", "true");
        const mid = document.createElement("div");
        mid.className = "mid";
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = p.note || "恭喜发财";
        const tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = claimable
          ? "薄巧红包"
          : moneyTagText(kind, msg);
        mid.append(note, tag);
        card.append(ico, mid);
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openRedpacketView(msg);
        });
      } else {
        /* 效果图：头行「转账给对方」+ 黄标「待确认」· 金额 · 脚注 · 右兔 */
        const head = document.createElement("div");
        head.className = "head";
        const kindLab = document.createElement("div");
        kindLab.className = "kind";
        if (isReceipt) kindLab.textContent = "转账回执";
        else if (msg.from === "you") kindLab.textContent = "转账给对方";
        else kindLab.textContent = "转账给你";
        const badge = document.createElement("span");
        badge.className = "badge";
        if (isReceipt || received) {
          badge.classList.add("is-done");
          badge.textContent = moneyTagText(kind, msg);
        } else if (claimable) {
          badge.textContent = "待确认";
        } else {
          badge.textContent = "待确认";
        }
        head.append(kindLab, badge);
        const amt = document.createElement("div");
        amt.className = "amt";
        amt.textContent = moneyText(p.amount);
        const note = document.createElement("div");
        note.className = "note";
        const noteTxt = String(p.note || "").trim();
        note.textContent = isReceipt
          ? "已收款"
          : noteTxt && noteTxt !== "转账"
            ? noteTxt
            : "薄巧系";
        card.append(head, amt, note);
        if (claimable) {
          card.setAttribute("role", "button");
          card.tabIndex = 0;
          card.addEventListener("click", (e) => {
            e.preventDefault();
            claimMoneyCard(msg.id);
          });
        }
      }
      bubble.append(card);
      finish();
      return;
    }
    if (kind === "location") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-loc-card is-claimable";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name || msg.body || "位置";
      card.append(name);
      if (p.detail) {
        const detail = document.createElement("div");
        detail.className = "detail";
        detail.textContent = p.detail;
        card.append(detail);
      }
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = "位置";
      card.append(tag);
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.addEventListener("click", (e) => {
        if (multiMode) return;
        e.preventDefault();
        e.stopPropagation();
        openLocView(p.name || msg.body || "位置", p.detail || "");
      });
      bubble.append(card);
      finish();
      return;
    }

    if (kind === "voice") {
      bubble.classList.add("is-voice");
      const p = msg.payload || {};
      const sec = voiceBubbleSec(p);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wx-voice-btn";
      const wave = document.createElement("span");
      wave.className = "wx-voice-wave";
      wave.setAttribute("aria-hidden", "true");
      wave.textContent = "♪";
      const dur = document.createElement("span");
      dur.className = "wx-voice-dur";
      dur.textContent = sec + '"';
      btn.append(wave, dur);
      btn.setAttribute("aria-label", "语音 " + sec + "秒");
      btn.addEventListener("click", () => {
        if (multiMode) return;
        const src = voicePlaySrc(p, msg && msg.body);
        if (src) {
          try {
            const a = new Audio(src);
            a.play().catch(() => shellToast("播放失败"));
          } catch (_) {
            shellToast("播放失败");
          }
        } else shellToast("语音 · 稍后");
      });
      bubble.append(btn);
      bubble.style.minWidth = Math.min(168, 56 + sec * 10) + "px";
      finish();
      return;
    }
    if (kind === "call") {
      bubble.classList.add("is-call");
      const p = msg.payload || {};
      const line = document.createElement("div");
      line.className = "wx-call-line";
      const ico = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ico.setAttribute("class", "wx-call-ico");
      ico.setAttribute("viewBox", "0 0 24 24");
      ico.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute(
        "d",
        p.media === "video"
          ? "M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 4v-11l-4 4z"
          : "M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z"
      );
      ico.append(path);
      const txt = document.createElement("span");
      txt.className = "wx-call-txt";
      txt.textContent = callBubbleLabel(msg);
      line.append(ico, txt);
      bubble.append(line);
      finish();
      return;
    }
    if (kind === "file" || kind === "music") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const name = String(p.name || msg.body || "").trim() || (kind === "music" ? "音乐" : "文件");
      const card = document.createElement("div");
      card.className = "wx-file-card" + (kind === "music" ? " is-music" : "");
      const ico = document.createElement("div");
      ico.className = "ico";
      ico.setAttribute("aria-hidden", "true");
      const mid = document.createElement("div");
      mid.className = "mid";
      const title = document.createElement("div");
      title.className = "name";
      title.textContent = name;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        kind === "music"
          ? p.lyric_share
            ? ["歌词", String(p.artist || "").trim() || "共听"]
                .filter(Boolean)
                .join(" · ")
            : p.fromPresence
              ? "共听 · 进行中"
              : p.stream_path || p.provider === "netease"
                ? [String(p.artist || "").trim() || "网易云", "整曲"].filter(Boolean).join(" · ")
                : p.apple_url || p.preview_url
                  ? [
                      String(p.artist || "").trim() || "Apple",
                      p.preview_url ? "试听30s" : "",
                      p.apple_url ? "外链" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : p.recommended
                    ? String(p.artist || "").trim() || "点歌"
                    : String(p.artist || "").trim() || "音频"
          : fileMetaLine(p, name) || "文件";
      mid.append(title, meta);
      card.append(ico, mid);
      if (
        kind === "music" &&
        (p.stream_path || p.preview_url || p.apple_url || p.provider === "netease" || p.lyric_share)
      ) {
        card.style.cursor = "pointer";
        card.addEventListener("click", (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest("a,button")) return;
          if (p.lyric_share) {
            try {
              if (
                global.ColistenApp &&
                typeof global.ColistenApp.enterPlayer === "function"
              ) {
                global.ColistenApp.enterPlayer();
              } else if (typeof global.showView === "function") {
                global.showView("colisten");
              } else {
                openMusicCard(p);
              }
            } catch (_) {
              openMusicCard(p);
            }
            return;
          }
          openMusicCard(p);
        });
      }
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
      t.textContent = msg.from === "bot" ? "\u5bf9\u65b9\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f" : "\u4f60\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f";
      bubble.append(t);
      const peek = recallPeekText(msg);
      if (peek) {
        t.classList.add("is-peek");
        const body = document.createElement("div");
        body.className = "wx-peek";
        body.hidden = true;
        body.textContent = peek;
        bubble.append(body);
        t.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          body.hidden = !body.hidden;
        });
      }
      finish();
      return;
    }
    const t = document.createElement("span");
    t.className = "wx-bubble-text";
    t.textContent = (msg && msg.body) || "";
    bubble.append(t);
    finish();
  }

  const THINK_PLACEHOLDER = "\uFF08\u672c\u8f6e\u5df2\u6df1\u5ea6\u601d\u8003\uff0c\u6a21\u578b\u672a\u8fd4\u56de\u601d\u8003\u6b63\u6587\uFF09";
  function realThinkText(raw) {
    const t = String(raw || "").trim();
    if (!t || t === THINK_PLACEHOLDER) return "";
    return t;
  }
  function thinkPanelText(raw) {
    return realThinkText(raw) || "\u8fd9\u8f6e\u6ca1\u7559\u4e0b\u601d\u8003\u6b63\u6587";
  }
  (function checkThinkPanel() {
    const hint = "\u8fd9\u8f6e\u6ca1\u7559\u4e0b\u601d\u8003\u6b63\u6587";
    if (thinkPanelText("") !== hint) throw new Error("empty think");
    if (thinkPanelText(THINK_PLACEHOLDER) !== hint) throw new Error("placeholder think");
    if (thinkPanelText("  ") !== hint) throw new Error("blank think");
    if (thinkPanelText("x") !== "x") throw new Error("real think");
  })();
  function bindBunnyThink(bubble, col, thinkText) {
    if (!bubble || !col) return;
    const body = thinkPanelText(thinkText);
    bubble.classList.add("has-think");
    let bunny = bubble.querySelector(".wx-bunny-deco");
    if (!bunny) {
      bunny = document.createElement("button");
      bunny.type = "button";
      bunny.className = "wx-bunny-deco";
      bunny.title = "深度思考";
      bunny.setAttribute("aria-label", "展开深度思考");
      bunny.setAttribute("aria-expanded", "false");
      bubble.append(bunny);
    }
    let panel = col.querySelector(".wx-think-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "wx-think-panel";
      panel.hidden = true;
      col.append(panel);
    }
    panel.textContent = body;
    if (!bunny.dataset.bound) {
      bunny.dataset.bound = "1";
      bunny.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = panel.hidden;
        panel.hidden = !open;
        bunny.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
  }

  function appendChatMessage(msg) {
    const box = document.getElementById("chatThread");
    if (!box || !msg) return null;
    if (msg.kind === "sys") {
      return appendMoneyTip(msg.body, msg.ts, msg.id);
    }
    if (msg.kind === "tool") {
      const empty = box.querySelector(".wx-empty");
      if (empty) empty.remove();
      const p = msg.payload || {};
      const row = finishToolChip(null, {
        name: p.name || msg.body,
        label: p.label,
        summary: p.summary,
        ok: p.ok !== false,
      });
      if (row && msg.id) row.dataset.msgId = msg.id;
      return row;
    }
    const empty = box.querySelector(".wx-empty");
    if (empty) empty.remove();
    /* 无独立 tool 消息时，用气泡自带的 tools 兜底（避免重开丢失） */
    if (Array.isArray(msg.tools) && msg.tools.length) {
      for (const t of msg.tools) {
        finishToolChip(null, {
          name: t.name,
          label: t.label,
          summary: t.summary,
          ok: t.ok !== false,
        });
      }
    }
    appendTimeChip(msg.ts != null ? msg.ts : Date.now());
    const youAv = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const botAv = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const row = document.createElement("div");
    row.className = "wx-row " + (msg.from === "you" ? "me" : "them");
    if (msg.id) row.dataset.msgId = msg.id;
    if (msg.kind) row.dataset.kind = msg.kind;
    const av = document.createElement("div");
    const homePeer = (activePeerId || "daily") === "daily";
    /* 完整框：自己始终有；对方仅家机 */
    av.className =
      "av" +
      (msg.from === "you" || (msg.from === "bot" && homePeer)
        ? " av-frame-full"
        : "");
    const avImg = document.createElement("img");
    avImg.alt = "";
    avImg.src = msg.from === "you" ? youAv : botAv;
    av.append(avImg);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    fillBubble(bubble, msg);
    if (msg.from === "bot") {
      const col = document.createElement("div");
      col.className = "wx-col";
      col.append(bubble);
      /* 家机气泡始终可点兔子；有 think 显示正文，否则提示 */
      bindBunnyThink(bubble, col, msg.think);
      syncVariantBar(col, msg);
      row.append(av, col);
    } else {
      row.append(av, bubble);
    }
    box.append(row);
    paintVoiceAsr(row, msg);
    bindBubbleCtx(bubble, msg);
    bindPatAvatar(row, msg);
    paintQuoteRef(row, msg);
    paintReactions(row, msg.reactions);
    if (multiMode) syncMultiMarks();
    if (nearBottom || msg.from === "you") {
      box.scrollTop = box.scrollHeight;
      setNewMsgChip(0);
    } else if (msg.from === "bot" && !suppressNewCount) {
      setNewMsgChip(newMsgPending + 1);
    }
    return bubble;
  }

  function appendChatBubble(from, text, ts, thinkOpts) {
    const msg = {
      from: from,
      kind: "text",
      body: text || "",
      ts: ts != null ? ts : Date.now(),
    };
    if (thinkOpts && (thinkOpts.think || thinkOpts.think_sec)) {
      if (thinkOpts.think) msg.think = thinkOpts.think;
      if (thinkOpts.think_sec) msg.think_sec = thinkOpts.think_sec;
    }
    return appendChatMessage(msg);
  }

  function appendMetaRow(kind, titleHtml) {
    const box = document.getElementById("chatThread");
    if (!box) return null;
    const empty = box.querySelector(".wx-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "wx-meta wx-meta-" + kind;
    const ico = document.createElement("span");
    ico.className = "wx-meta-ico";
    ico.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "wx-meta-body";
    body.innerHTML = titleHtml;
    row.append(ico, body);
    box.append(row);
    box.scrollTop = box.scrollHeight;
    return row;
  }

  function escMeta(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function appendToolChip(name, label) {
    const show = String(label || name || "").trim() || "tool";
    return appendMetaRow(
      "tool",
      "调用工具 <code>" + escMeta(show) + "</code><span class=\"wx-meta-sum\"> …</span>"
    );
  }

  function finishToolChip(row, ev) {
    const show = String((ev && ev.label) || (ev && ev.name) || "").trim() || "tool";
    const sum = String((ev && ev.summary) || "").trim();
    const ok = !ev || ev.ok !== false;
    let target = row;
    if (!target) target = appendToolChip(ev && ev.name, ev && ev.label);
    if (!target) return null;
    target.classList.toggle("is-bad", !ok);
    const body = target.querySelector(".wx-meta-body");
    if (body) {
      body.innerHTML =
        "调用工具 <code>" +
        escMeta(show) +
        "</code>" +
        (sum ? '<span class="wx-meta-sum"> · ' + escMeta(sum) + "</span>" : "");
    }
    return target;
  }

  function takePendingThinkForFirstBubble() {
    if (thinkAttached) return null;
    const text = String(pendingThink.text || "").trim();
    const sec = Number(pendingThink.sec) || 0;
    if (!text && !(sec > 0)) return null;
    thinkAttached = true;
    return {
      think: text,
      think_sec: sec > 0 ? Math.round(sec * 10) / 10 : undefined,
    };
  }

  function ensureBunnyThink(bubble, msg) {
    if (!bubble) return;
    const row = bubble.closest(".wx-row");
    if (!row) return;
    let col = row.querySelector(".wx-col");
    if (!col) {
      col = document.createElement("div");
      col.className = "wx-col";
      bubble.replaceWith(col);
      col.append(bubble);
    }
    const thinkText = String(
      (msg && msg.think) || pendingThink.text || ""
    ).trim();
    bindBunnyThink(bubble, col, thinkText);
    if (thinkText) thinkAttached = true;
  }

  function syncSendPlus() {
    const input = document.getElementById("dailyChatInput");
    const hold = document.getElementById("btnChatHold");
    const send = document.getElementById("btnChatSend");
    const plus = document.getElementById("btnChatPlus");
    if (voiceMode) {
      if (input) input.hidden = true;
      if (hold) hold.hidden = false;
      if (send) send.hidden = true;
      if (plus) plus.hidden = false;
      return;
    }
    if (input) input.hidden = false;
    if (hold) hold.hidden = true;
    const has = !!(input && String(input.value || "").trim());
    if (send) send.hidden = !has;
    if (plus) plus.hidden = has;
  }

  function setVoiceMode(on) {
    voiceMode = !!on;
    setPanels(null);
    const stick = document.getElementById("btnChatSticker");
    if (stick) {
      /* 效果图：✦ 表情 / 键盘回切 */
      stick.textContent = voiceMode ? "⌨" : "✦";
      stick.title = voiceMode ? "键盘" : "表情";
      stick.setAttribute("aria-label", voiceMode ? "键盘" : "表情");
    }
    const voiceBtn = document.getElementById("btnChatVoice");
    if (voiceBtn) {
      voiceBtn.setAttribute("aria-pressed", voiceMode ? "true" : "false");
      voiceBtn.title = voiceMode ? "键盘" : "语音";
      voiceBtn.setAttribute("aria-label", voiceMode ? "键盘" : "语音");
    }
    syncSendPlus();
    if (!voiceMode) {
      const input = document.getElementById("dailyChatInput");
      if (input) input.focus();
    }
  }

  const RP_GIFS = [
    "/assets/chat/skin/redpacket-v1.gif",
    "/assets/chat/skin/redpacket-v2.gif",
  ];
  let rpMsg = null;
  let rpBusy = false;

  function rpCanClaim(msg) {
    if (!msg || msg.kind !== "redpacket") return false;
    const st = (msg.payload && msg.payload.status) || "received";
    return msg.from === "bot" && st === "sent";
  }
  function paintRpResult(msg) {
    const fromEl = document.getElementById("chatRpFrom");
    const amtEl = document.getElementById("chatRpAmt");
    const noteEl = document.getElementById("chatRpNote");
    const statusEl = document.getElementById("chatRpStatus");
    const p = (msg && msg.payload) || {};
    const who =
      msg && msg.from === "you" ? "你" : displayPeerName();
    const claimable = rpCanClaim(msg);
    if (fromEl) fromEl.textContent = who + "的红包";
    if (amtEl) amtEl.textContent = moneyText(p.amount);
    if (noteEl) noteEl.textContent = p.note || "恭喜发财";
    if (statusEl) {
      let st = "";
      if (msg && msg.from === "you" && (p.status || "") === "sent") st = "等待对方领取";
      else if (!claimable) st = "已被领取";
      statusEl.textContent = st;
      statusEl.hidden = !st;
    }
  }
  function showRpCover() {
    const cover = document.getElementById("chatRpCover");
    const result = document.getElementById("chatRpResult");
    const openBtn = document.getElementById("chatRpOpen");
    if (cover) cover.hidden = false;
    if (result) result.hidden = true;
    if (openBtn) {
      openBtn.hidden = false;
      openBtn.disabled = false;
    }
  }
  function showRpResult(msg) {
    const cover = document.getElementById("chatRpCover");
    const result = document.getElementById("chatRpResult");
    const openBtn = document.getElementById("chatRpOpen");
    paintRpResult(msg);
    if (cover) cover.hidden = true;
    if (result) result.hidden = false;
    if (openBtn) openBtn.hidden = true;
  }
  function openRedpacketView(msg) {
    if (!msg || msg.kind !== "redpacket") return;
    const view = document.getElementById("chatRpView");
    const gif = document.getElementById("chatRpGif");
    if (!view || !gif) return;
    rpMsg = msg;
    const src = RP_GIFS[Math.floor(Math.random() * RP_GIFS.length)];
    gif.src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
    /* 每次先播竖版动画，点「開」再看回执（已领也一样） */
    showRpCover();
    view.hidden = false;
    view.classList.remove("is-in");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => view.classList.add("is-in"));
    });
  }
  function closeRedpacketView() {
    const view = document.getElementById("chatRpView");
    const gif = document.getElementById("chatRpGif");
    if (view) {
      view.classList.remove("is-in");
      view.hidden = true;
    }
    if (gif) gif.removeAttribute("src");
    rpMsg = null;
    rpBusy = false;
  }
  async function claimMoneyCard(id) {
    if (!id || sending) return null;
    try {
      const res = await fetch("/api/v1/chat/money/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withPeerBody({ id: id })),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || data.error || "领取失败");
      if (data.message) patchMessageBubble(data.message);
      if (data.tip_message) appendChatMessage(data.tip_message);
      else if (data.tip) appendMoneyTip(data.tip, Date.now());
      if (data.receipt_message) appendChatMessage(data.receipt_message);
      setChatErr("");
      return data.message || null;
    } catch (e) {
      setChatErr((e && e.message) || "领取失败");
      return null;
    }
  }
  async function openRedpacketClaim() {
    if (!rpMsg || rpBusy) return;
    if (!rpCanClaim(rpMsg)) {
      showRpResult(rpMsg);
      return;
    }
    rpBusy = true;
    const openBtn = document.getElementById("chatRpOpen");
    if (openBtn) openBtn.disabled = true;
    const updated = await claimMoneyCard(rpMsg.id);
    rpBusy = false;
    if (updated) {
      rpMsg = updated;
      showRpResult(updated);
    } else if (openBtn) {
      openBtn.disabled = false;
    }
  }


  function scrollToLatest() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    /* 只滚到底垫尽头；勿 scrollIntoView(end)，会把最后一条贴视口底边盖住 deco */
    const go = () => {
      box.scrollTop = box.scrollHeight;
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
  }

  function scrollThreadEnd() {
    scrollToLatest();
  }

  function scrollToMessage(id) {
    const box = document.getElementById("chatThread");
    if (!box || !id) return false;
    const row = box.querySelector('.wx-row[data-msg-id="' + id + '"]');
    if (!row) return false;
    try {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_) {
      row.scrollIntoView();
    }
    row.classList.add("is-flash");
    setTimeout(() => row.classList.remove("is-flash"), 1200);
    return true;
  }

  function dismissKeyboard() {
    const input = document.getElementById("dailyChatInput");
    if (input) input.blur();
  }

  function setPanels(which) {
    const stick = document.getElementById("chatStickerPanel");
    const plus = document.getElementById("chatPlusPanel");
    const sheet = document.getElementById("chatSheet");
    const stickBtn = document.getElementById("btnChatSticker");
    const plusBtn = document.getElementById("btnChatPlus");
    if (which === "sticker" || which === "plus") {
      dismissKeyboard();
      if (sheet) sheet.hidden = true;
      sheetMode = "";
    }
    if (stick) stick.hidden = which !== "sticker";
    if (plus) plus.hidden = which !== "plus";
    if (stickBtn) stickBtn.setAttribute("aria-pressed", which === "sticker" ? "true" : "false");
    if (plusBtn) plusBtn.setAttribute("aria-pressed", which === "plus" ? "true" : "false");
    if (which === "sticker" || which === "plus") {
      /* 面板入流后底垫生效，再滚到底，避开输入框小组件 */
      requestAnimationFrame(() => {
        scrollThreadEnd();
        requestAnimationFrame(scrollThreadEnd);
      });
    }
  }

  async function refreshChatThread() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    closeHist();
    setPanels(null);
    setTyping(false);
    const peer = document.getElementById("chatPeerName");
    if (peer) {
      peer.classList.remove("is-typing");
      delete peer.dataset.peerName;
      peer.textContent = (typeof displayPeerName === "function" ? displayPeerName() : deps.getPeerName()) || "家机";
    }
    box.replaceChildren();
    lastTimeBucket = -1;
    try {
      try {
        await fetchStickers();
      } catch (_) {}
      const msgs = await fetchChatMessages();
      const firstUnread = msgs.find((m) => m && m.from === "bot" && m.read === false);
      const unreadFromId = firstUnread ? String(firstUnread.id) : "";
      if (lsGet(LS.clearRead, "1") !== "0") {
        await markChatRead();
        refreshUnreadUi();
      }
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "wx-empty";
        empty.textContent = "还没有短讯。正剧请去 Chatbox。";
        box.append(empty);
        return;
      }
      suppressNewCount = true;
      try {
        for (const m of msgs) {
          if (unreadFromId && String(m.id) === unreadFromId) appendUnreadBar();
          appendChatMessage(m);
        }
      } finally {
        suppressNewCount = false;
      }
      setNewMsgChip(0);
      setChatErr("");
      const bar = unreadFromId && box.querySelector(".wx-unread-bar");
      if (bar) bar.scrollIntoView({ block: "center" });
      else scrollToLatest();
    } catch (e) {
      const empty = document.createElement("div");
      empty.className = "wx-empty";
      empty.textContent = (e && e.message) || "聊天加载失败";
      box.append(empty);
    }
  }
  function histPreview(m) {
    if (!m) return "";
    if (m.recalled || m.kind === "recall") return m.from === "bot" ? "\u5bf9\u65b9\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f" : "\u4f60\u64a4\u56de\u4e86\u4e00\u6761\u6d88\u606f";
    if (m.kind === "sys") return String(m.body || "").trim();
    const p = m.payload || {};
    /* 红包预览不露金额（微信式）；祝福有则带上 */
    if (m.kind === "redpacket") {
      const note = String(p.note || "").trim();
      return note ? "[红包] " + note : "[红包]";
    }
    if (m.kind === "transfer") {
      if (p.is_receipt) return "[转账回执] 已收款";
      return "[转账] " + moneyText(p.amount) + " " + (p.note || "");
    }
    if (m.kind === "location") return "[位置] " + (p.name || m.body || "");
    if (m.kind === "image") return "[图片]";
    if (m.kind === "sticker") return "[贴纸]";
    if (m.kind === "voice") return "[语音]";
    if (m.kind === "call") return "[通话]";
    if (m.kind === "file") return "[文件] " + (p.name || m.body || "");
    if (m.kind === "music") return "[音乐] " + (p.name || m.body || "");
    if (m.kind === "pat") return m.body || "[拍一拍]";
    if (m.kind === "tool") return "[工具] " + (m.body || "");
    if (Array.isArray(m.tools) && m.tools.length) {
      const t0 = m.tools[0] || {};
      const tip =
        String(t0.label || t0.name || "工具").trim() +
        (t0.summary ? " · " + t0.summary : "");
      const more = m.tools.length > 1 ? " +" + (m.tools.length - 1) : "";
      const body = String(m.body || "").trim();
      return "[工具] " + tip + more + (body ? " · " + body : "");
    }
    return m.body || "";
  }
  /* ponytail: H1.79 预览自检；金额泄漏即失败 */
  (function () {
    const rp = histPreview({
      kind: "redpacket",
      payload: { amount: 8.8, note: "开心收着" },
    });
    if (!rp || /¥|8\.8|8\.80/.test(rp) || rp.indexOf("开心收着") < 0) {
      throw new Error("histPreview redpacket");
    }
    const tip = histPreview({ kind: "sys", body: "对方已收款" });
    if (tip !== "对方已收款") throw new Error("histPreview sys");
    const rc = histPreview({
      kind: "transfer",
      payload: { amount: 1, note: "已收款", is_receipt: true },
    });
    if (rc.indexOf("转账回执") < 0 || /¥/.test(rc)) throw new Error("histPreview receipt");
  })();

  function paintHistGrid() {
    const box = document.getElementById("chatHistGrid");
    if (!box) return;
    box.replaceChildren();
    for (const k of HIST_CATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = k.lab;
      b.addEventListener("click", () => onHistCat(k.id));
      box.append(b);
    }
  }

  function histTopEl() {
    return document.querySelector("#chatHist .wx-hist-top");
  }

  function setHistTopVisible(on) {
    const top = histTopEl();
    if (top) top.hidden = !on;
  }

  function showHistHome() {
    const home = document.getElementById("chatHistHome");
    const dates = document.getElementById("chatHistDates");
    const list = document.getElementById("chatHistList");
    setHistTopVisible(true);
    if (home) home.hidden = false;
    if (dates) dates.hidden = true;
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
    histKind = "all";
    histDay = "";
  }

  function showHistResults() {
    const home = document.getElementById("chatHistHome");
    const dates = document.getElementById("chatHistDates");
    const list = document.getElementById("chatHistList");
    setHistTopVisible(true);
    if (home) home.hidden = true;
    if (dates) dates.hidden = true;
    if (list) list.hidden = false;
  }

  function ymdLocal(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate())
    );
  }

  function monthLab(y, m0) {
    return y + " 年 " + (m0 + 1) + " 月";
  }

  function setCalJumpLab(y, m0) {
    const lab = document.getElementById("chatHistCalJumpLab");
    if (lab) lab.textContent = monthLab(y, m0);
    const inp = document.getElementById("chatHistCalMonth");
    if (inp) {
      const pad = (n) => String(n).padStart(2, "0");
      inp.value = y + "-" + pad(m0 + 1);
    }
  }

  function paintHistCal(activeDays) {
    const box = document.getElementById("chatHistCal");
    if (!box) return;
    box.replaceChildren();
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayKey = ymdLocal(today);
    let start = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    if (activeDays && activeDays.size) {
      let minKey = null;
      for (const k of activeDays) {
        if (!minKey || k < minKey) minKey = k;
      }
      if (minKey) {
        const p = minKey.split("-").map(Number);
        const early = new Date(p[0], p[1] - 1, 1);
        if (early < start) start = early;
      }
    }
    const end = new Date(today.getFullYear(), today.getMonth(), 1);
    for (
      let cur = new Date(start.getFullYear(), start.getMonth(), 1);
      cur <= end;
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
    ) {
      const y = cur.getFullYear();
      const m0 = cur.getMonth();
      const sec = document.createElement("section");
      sec.className = "wx-cal-month";
      sec.dataset.ym = y + "-" + String(m0 + 1).padStart(2, "0");
      const lab = document.createElement("div");
      lab.className = "wx-cal-month-lab";
      lab.textContent = y + "年" + (m0 + 1) + "月";
      const grid = document.createElement("div");
      grid.className = "wx-cal-grid";
      const firstDow = new Date(y, m0, 1).getDay();
      const daysInMonth = new Date(y, m0 + 1, 0).getDate();
      for (let i = 0; i < firstDow; i++) {
        const blank = document.createElement("div");
        blank.className = "wx-cal-cell";
        blank.setAttribute("aria-hidden", "true");
        grid.append(blank);
      }
      for (let day = 1; day <= daysInMonth; day++) {
        const key =
          y +
          "-" +
          String(m0 + 1).padStart(2, "0") +
          "-" +
          String(day).padStart(2, "0");
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "wx-cal-cell";
        cell.dataset.day = key;
        const num = document.createElement("span");
        num.className = "wx-cal-num";
        num.textContent = String(day);
        cell.append(num);
        const isToday = key === todayKey;
        const has = activeDays && activeDays.has(key);
        if (isToday) {
          cell.classList.add("is-today");
          const tag = document.createElement("span");
          tag.className = "wx-cal-today-tag";
          tag.textContent = "今天";
          cell.append(tag);
        }
        if (has) {
          cell.classList.add("is-active");
          cell.addEventListener("click", () => {
            histKind = "all";
            histDay = key;
            const q = document.getElementById("chatHistQ");
            if (q) q.value = "";
            runHistSearch();
          });
        } else {
          cell.disabled = true;
        }
        grid.append(cell);
      }
      sec.append(lab, grid);
      box.append(sec);
    }
    setCalJumpLab(today.getFullYear(), today.getMonth());
    requestAnimationFrame(() => {
      const last = box.lastElementChild;
      if (last) last.scrollIntoView({ block: "end" });
    });
  }

  async function loadHistActiveDays() {
    try {
      const res = await fetch("/api/v1/chat/messages?" + peerQuery(), {
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const set = new Set();
      for (const m of msgs) {
        const t = Number(m.ts) || 0;
        if (!t) continue;
        set.add(ymdLocal(new Date(t)));
      }
      histActiveDays = set;
      return set;
    } catch (_) {
      histActiveDays = new Set();
      return histActiveDays;
    }
  }

  async function showHistDates() {
    const home = document.getElementById("chatHistHome");
    const dates = document.getElementById("chatHistDates");
    const list = document.getElementById("chatHistList");
    setHistTopVisible(false);
    if (home) home.hidden = true;
    if (list) list.hidden = true;
    if (dates) dates.hidden = false;
    const cal = document.getElementById("chatHistCal");
    if (cal) cal.textContent = "加载中…";
    const days = await loadHistActiveDays();
    paintHistCal(days);
  }

  function onHistCat(id) {
    if (id === "date") {
      histKind = "all";
      histDay = "";
      showHistDates();
      return;
    }
    histKind = id;
    histDay = "";
    const q = document.getElementById("chatHistQ");
    if (q) q.blur();
    showHistResults();
    runHistSearch();
  }

  async function runHistSearch() {
    const list = document.getElementById("chatHistList");
    if (!list) return;
    const q = String((document.getElementById("chatHistQ") || {}).value || "").trim();
    const from = histDay;
    const to = histDay;
    /* 无关键词、无分类、无日期 → 回首页，不刷记录 */
    if (!q && (!histKind || histKind === "all") && !from && !to) {
      showHistHome();
      return;
    }
    showHistResults();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (histKind && histKind !== "all") params.set("kind", histKind);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    list.textContent = "搜索中…";
    try {
      const res = await fetch("/api/v1/chat/search?" + params.toString(), {
        credentials: "same-origin",
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || "搜索失败");
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      list.replaceChildren();
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "wx-hist-empty";
        empty.textContent = "没有匹配的记录";
        list.append(empty);
        return;
      }
      for (const m of msgs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "wx-hist-row";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent =
          (m.from === "you" ? "我" : deps.getPeerName() || "家机") +
          " · " +
          chatTimeLabel(m.ts);
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = histPreview(m);
        row.append(meta, body);
        row.addEventListener("click", async () => {
          closeHist();
          await refreshChatThread();
          if (!scrollToMessage(m.id)) scrollToLatest();
        });
        list.append(row);
      }
    } catch (e) {
      list.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "wx-hist-empty";
      empty.textContent = (e && e.message) || "搜索失败";
      list.append(empty);
    }
  }

  function openHist() {
    const hist = document.getElementById("chatHist");
    if (!hist) return;
    setPanels(null);
    dismissKeyboard();
    hist.hidden = false;
    histKind = "all";
    histDay = "";
    paintHistGrid();
    const q = document.getElementById("chatHistQ");
    if (q) q.value = "";
    showHistHome();
  }

  function closeHist(opts) {
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
  }

  /** 串行发出去的消息；不等待家机回完也可继续输入/连发 */
  let sendChain = Promise.resolve();

  function setComposerBusy(busy) {
    sending = !!busy;
    /* ponytail: 不禁用输入框/发送；sending 仅给再生等旁路读状态 */
  }

  function recallStreamAction(type) {
    if (type === "you_recall") return "patch";
    if (
      type === "bot_start" ||
      type === "bot_delta" ||
      type === "bot_done" ||
      type === "bot_think" ||
      type === "bot_image" ||
      type === "bot_error" ||
      type === "done"
    )
      return "paint";
    return "";
  }
  (function checkRecallStream() {
    if (recallStreamAction("you_recall") !== "patch") throw new Error("patch");
    if (recallStreamAction("bot_delta") !== "paint") throw new Error("paint");
    if (recallStreamAction("you") !== "") throw new Error("you");
  })();
  function makeChatStream(box) {
    let botBubble = null;
    let pendingToolRow = null;
    const paintFrame = () =>
      new Promise((r) => requestAnimationFrame(() => r()));
    const handleEvent = async (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === "you" && ev.message) {
        appendChatMessage(ev.message);
        await paintFrame();
      } else if (ev.type === "you_recall" && ev.message) {
        patchMessageBubble(ev.message);
        shellToast("\u5df2\u64a4\u56de");
        await paintFrame();
      } else if (ev.type === "money_claim" && ev.message) {
        patchMessageBubble(ev.message);
        await paintFrame();
      } else if (ev.type === "money_tip") {
        if (ev.message) appendChatMessage(ev.message);
        else if (ev.text) appendMoneyTip(ev.text, ev.ts);
        await paintFrame();
      } else if (ev.type === "bot_start") {
        pendingThink = { sec: 0, text: "" };
        thinkAttached = false;
        setTyping(true);
        await paintFrame();
      } else if (ev.type === "bot_think") {
        if (ev.text) {
          pendingThink.text = pendingThink.text
            ? pendingThink.text + "\n---\n" + ev.text
            : String(ev.text);
        }
        if (Number(ev.seconds) > 0) pendingThink.sec += Number(ev.seconds);
        if (botBubble) {
          ensureBunnyThink(botBubble, {
            think: pendingThink.text,
            think_sec: pendingThink.sec,
          });
        }
        await paintFrame();
      } else if (ev.type === "bot_tool" && ev.name) {
        pendingToolRow = appendToolChip(ev.name, ev.label);
        await paintFrame();
      } else if (ev.type === "cam_check_wait") {
        onCamCheckWait(ev);
        await paintFrame();
      } else if (ev.type === "bot_tool_done") {
        const row = finishToolChip(pendingToolRow, ev);
        if (row && ev.message && ev.message.id) row.dataset.msgId = ev.message.id;
        pendingToolRow = null;
        await paintFrame();
      } else if (ev.type === "bot_delta" && ev.text) {
        if (!botBubble) {
          setTyping(true);
          botBubble = appendChatBubble(
            "bot",
            "",
            Date.now(),
            takePendingThinkForFirstBubble()
          );
        }
        if (botBubble) {
          const te = bubbleTextEl(botBubble);
          te.textContent = (te.textContent || "") + ev.text;
          if (nearBottom && box) box.scrollTop = box.scrollHeight;
        }
        await paintFrame();
      } else if (ev.type === "bot_done" && ev.message) {
        const m = ev.message;
        if (botBubble) {
          const row = botBubble.closest(".wx-row");
          if (row && m.id) row.dataset.msgId = String(m.id);
          fillBubble(botBubble, m);
          ensureBunnyThink(botBubble, m);
        } else {
          thinkAttached = true;
          appendChatMessage(m);
        }
        botBubble = null;
        setTyping(false);
      } else if (ev.type === "bot_recall" && ev.message) {
        const m = ev.message;
        let row = null;
        if (m.id && box) {
          row = box.querySelector(
            '.wx-row[data-msg-id="' + CSS.escape(String(m.id)) + '"]'
          );
        }
        if (!row && botBubble) row = botBubble.closest(".wx-row");
        if (row && m.id) row.dataset.msgId = String(m.id);
        const bubble = row && row.querySelector(".bubble");
        if (bubble) fillBubble(bubble, m);
        else appendChatMessage(m);
        const col = row && row.querySelector(".wx-col");
        if (col) syncVariantBar(col, m);
        await paintFrame();
      } else if (ev.type === "bot_money" && ev.message) {
        /* 连发后续条：不绑兔子思考 */
        appendChatMessage(ev.message);
        await paintFrame();
      } else if (ev.type === "bot_sticker" && ev.message) {
        appendChatMessage(ev.message);
        await paintFrame();
      } else if (ev.type === "bot_music" && ev.message) {
        appendChatMessage(ev.message);
        await paintFrame();
      } else if (ev.type === "bot_image" && ev.message) {
        appendChatMessage(ev.message);
        await paintFrame();
      } else if (ev.type === "react" && ev.message && ev.message.id) {
        const hit =
          box &&
          box.querySelector(
            '.wx-row[data-msg-id="' + CSS.escape(String(ev.message.id)) + '"]'
          );
        if (hit) paintReactions(hit, ev.message.reactions);
        await paintFrame();
      } else if (ev.type === "bot_error") {
        if (botBubble && !(botBubble.textContent || "").trim()) {
          const row = botBubble.closest(".wx-row");
          if (row) row.remove();
        }
        botBubble = null;
        setTyping(false);
        if (ev.code === "wallet_insufficient") setChatErr("余额不足");
      } else if (ev.type === "done") {
        setTyping(false);
        if (ev.mood) paintMoodCap(ev.mood);
        else void refreshMoodUi();
        if (ev.bot_error) {
          const tip =
            ev.bot_error.code === "budget_exhausted"
              ? ev.bot_error.message || "额度已用尽 · 你侧已留下"
              : "家机未接上：" +
                (ev.bot_error.message || ev.bot_error.code || "降级");
          setChatErr(tip);
        }
      }
    };
    return handleEvent;
  }
  async function readChatSse(res, handleEvent) {
    if (!res.body || !res.body.getReader) {
      throw new Error("\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u6d41\u5f0f\u8bfb\u53d6");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const consumeBlock = async (block) => {
      const lines = String(block || "").split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(":")) continue;
        if (!t.startsWith("data:")) continue;
        const raw = t.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let evObj;
        try {
          evObj = JSON.parse(raw);
        } catch {
          continue;
        }
        await handleEvent(evObj);
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";
      for (const part of parts) await consumeBlock(part);
    }
    if (buf.trim()) await consumeBlock(buf);
  }

  async function postChatPayload(payload) {
    const run = async () => {
      const box = document.getElementById("chatThread");
      setChatErr("");
      setComposerBusy(true);
      setPanels(null);
      try {
        const res = await fetch("/api/v1/chat/messages", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(withPeerBody(payload)),
        });
        const ctype = String(res.headers.get("content-type") || "");
        if (!res.ok && !ctype.includes("event-stream")) {
          let data = {};
          try {
            data = await res.json();
          } catch (_) {
            data = {};
          }
          if (res.status === 404) throw new Error("聊天接口未就绪：请重启 npm start 后再试");
          if (data.error === "wallet_insufficient") throw new Error("余额不足");
          throw new Error(data.message || data.error || "发送失败");
        }
        await readChatSse(res, makeChatStream(box));
        if (chatViewActive()) await markChatRead();
        else notifyUnread();
        refreshSessionList();
      } catch (e) {
        setTyping(false);
        setChatErr((e && e.message) || "发送失败");
      } finally {
        setTyping(false);
        setComposerBusy(false);
        syncSendPlus();
        const input = document.getElementById("dailyChatInput");
        if (input) input.focus();
      }
    };
    const next = sendChain.then(run, run);
    sendChain = next.catch(() => {});
    await next;
  }

  async function sendChatMessage() {
    const input = document.getElementById("dailyChatInput");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (input) input.value = "";
    syncSendPlus();
    const payload = { kind: "text", body: body };
    if (pendingQuote) {
      payload.quote = { id: pendingQuote.id, who: pendingQuote.who, text: pendingQuote.text };
    }
    clearPendingQuote();
    await postChatPayload(payload);
  }

  async function sendSticker(id) {
    if (!id) return;
    await postChatPayload({ kind: "sticker", body: id });
  }

  const ALBUM_MAX = 9;
  function clampAlbumFiles(fileList) {
    const all = Array.from(fileList || []).filter(Boolean);
    return { files: all.slice(0, ALBUM_MAX), truncated: all.length > ALBUM_MAX };
  }
  /* ponytail: H1.82 多图上限自检 */
  (function () {
    const nine = clampAlbumFiles(Array(9).fill(1));
    if (nine.files.length !== 9 || nine.truncated) throw new Error("album 9");
    const ten = clampAlbumFiles(Array(10).fill(1));
    if (ten.files.length !== 9 || !ten.truncated) throw new Error("album 10");
  })();

  async function uploadChatImage(file) {
    const res = await fetch("/api/v1/chat/media", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) throw new Error(data.message || data.error || "上传失败");
    if (!data.url) throw new Error("上传失败");
    return data.url;
  }

  async function postSilentImage(url) {
    const res = await fetch("/api/v1/chat/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withPeerBody({ kind: "image", body: url, noreply: true })
      ),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "发送失败");
    if (data.message) appendChatMessage(data.message);
  }

  async function sendPickedImages(fileList) {
    const { files, truncated } = clampAlbumFiles(fileList);
    if (!files.length) return;
    if (truncated) shellToast("一次最多 9 张");
    setChatErr("");
    setComposerBusy(true);
    const urls = [];
    try {
      for (let i = 0; i < files.length; i++) {
        urls.push(await uploadChatImage(files[i]));
      }
    } catch (e) {
      if (!urls.length) {
        setChatErr((e && e.message) || "上传失败");
        setComposerBusy(false);
        return;
      }
      setChatErr((e && e.message) || "上传失败");
    }
    try {
      for (let i = 0; i < urls.length - 1; i++) await postSilentImage(urls[i]);
      setComposerBusy(false);
      await postChatPayload({ kind: "image", body: urls[urls.length - 1] });
    } catch (e) {
      setChatErr((e && e.message) || "发送失败");
      setComposerBusy(false);
    }
  }

  async function sendPickedImage(file) {
    if (!file) return;
    await sendPickedImages([file]);
  }

  async function uploadUserSticker(file) {
    if (!file) return;
    setChatErr("");
    try {
      const res = await fetch("/api/v1/chat/stickers", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Sticker-Label": "自建",
        },
        body: file,
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || data.error || "贴纸上传失败");
      await fetchStickers(true);
      await paintStickerPanel();
      setPanels("sticker");
    } catch (e) {
      setChatErr((e && e.message) || "贴纸上传失败");
    }
  }

  async function paintStickerPanel() {
    const panel = document.getElementById("chatStickerPanel");
    if (!panel) return;
    const pack = await fetchStickers();
    panel.replaceChildren();
    const add = document.createElement("button");
    add.type = "button";
    add.className = "wx-sticker-add";
    add.title = "添加贴纸";
    add.textContent = "+";
    add.addEventListener("click", () => {
      const inp = document.getElementById("chatStickerInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
    });
    panel.append(add);
    for (const s of pack) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = s.label || s.id;
      const img = document.createElement("img");
      img.src = s.src;
      img.alt = s.label || s.id;
      b.append(img);
      b.addEventListener("click", () => sendSticker(s.id));
      panel.append(b);
    }
  }

  function paintPlusPanel() {
    const panel = document.getElementById("chatPlusPanel");
    if (!panel) return;
    panel.replaceChildren();
    const pages = document.createElement("div");
    pages.className = "wx-plus-pages";
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(PLUS_ITEMS.length / pageSize));
    for (let p = 0; p < pageCount; p++) {
      const page = document.createElement("div");
      page.className = "wx-plus-page";
      const chunk = PLUS_ITEMS.slice(p * pageSize, p * pageSize + pageSize);
      for (const item of chunk) {
        const b = document.createElement("button");
        b.type = "button";
        const tile = document.createElement("span");
        tile.className = "tile";
        tile.textContent = item.tile;
        const lab = document.createElement("span");
        lab.textContent = item.lab;
        b.append(tile, lab);
        b.addEventListener("click", () => onPlusItem(item));
        page.append(b);
      }
      pages.append(page);
    }
    panel.append(pages);
  }

  function openCallPicker() {
    const pick = document.getElementById("chatCallPick");
    if (!pick) return;
    setPanels(null);
    dismissKeyboard();
    pick.hidden = false;
  }

  function closeCallPicker() {
    const pick = document.getElementById("chatCallPick");
    if (pick) pick.hidden = true;
  }

  function sheetAmountExceeds(amount, bal) {
    if (bal == null || !Number.isFinite(Number(bal))) return false;
    return Number(amount) > Number(bal);
  }
  /* ponytail: H1.80 超额判定自检 */
  if (sheetAmountExceeds(10, 9.99) !== true || sheetAmountExceeds(1, null) !== false) {
    throw new Error("sheetAmountExceeds");
  }

  async function fetchYouBalance() {
    try {
      const res = await fetch("/api/v1/wallet", {
        credentials: "same-origin",
        cache: "no-store",
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) return null;
      const n = Number(data.you_balance);
      return Number.isFinite(n) ? n : null;
    } catch (_) {
      return null;
    }
  }

  function paintSheetBalance(bal) {
    const wrap = document.getElementById("chatSheetBalWrap");
    const lab = document.getElementById("chatSheetBal");
    if (!wrap) return;
    const money = sheetMode === "redpacket" || sheetMode === "transfer";
    wrap.hidden = !money;
    if (!money) return;
    sheetYouBalance = bal;
    if (!lab) return;
    if (bal == null) lab.textContent = "零花余额 · 暂不可用";
    else lab.textContent = "零花余额 " + moneyText(bal);
  }

  function openSheet(mode) {
    sheetMode = mode;
    sheetYouBalance = null;
    const sheet = document.getElementById("chatSheet");
    const stick = document.getElementById("chatStickerPanel");
    const plus = document.getElementById("chatPlusPanel");
    const stickBtn = document.getElementById("btnChatSticker");
    const plusBtn = document.getElementById("btnChatPlus");
    const title = document.getElementById("chatSheetTitle");
    const aw = document.getElementById("chatSheetAmountWrap");
    const nw = document.getElementById("chatSheetNoteWrap");
    const nameW = document.getElementById("chatSheetNameWrap");
    const detailW = document.getElementById("chatSheetDetailWrap");
    const balWrap = document.getElementById("chatSheetBalWrap");
    const balLab = document.getElementById("chatSheetBal");
    const noteLab = document.getElementById("chatSheetNoteLab");
    const amount = document.getElementById("chatSheetAmount");
    const note = document.getElementById("chatSheetNote");
    const name = document.getElementById("chatSheetName");
    const detail = document.getElementById("chatSheetDetail");
    if (!sheet) return;
    dismissKeyboard();
    if (stick) stick.hidden = true;
    if (plus) plus.hidden = true;
    if (stickBtn) stickBtn.setAttribute("aria-pressed", "false");
    if (plusBtn) plusBtn.setAttribute("aria-pressed", "false");
    const isMoney = mode === "redpacket" || mode === "transfer";
    if (aw) aw.hidden = !isMoney;
    if (nw) nw.hidden = !isMoney;
    if (nameW) nameW.hidden = mode !== "location";
    if (detailW) detailW.hidden = mode !== "location";
    if (balWrap) balWrap.hidden = !isMoney;
    if (title) {
      title.textContent =
        mode === "redpacket" ? "发红包" : mode === "transfer" ? "转账" : "发送位置";
    }
    if (noteLab) noteLab.textContent = mode === "redpacket" ? "祝福" : "备注";
    if (amount) amount.value = "";
    if (note) note.value = mode === "redpacket" ? "恭喜发财" : "";
    if (name) name.value = "";
    if (detail) detail.value = "";
    if (isMoney && balLab) balLab.textContent = "零花余额 …";
    sheet.hidden = false;
    requestAnimationFrame(scrollThreadEnd);
    if (isMoney) {
      fetchYouBalance().then((bal) => {
        if (sheetMode === mode) paintSheetBalance(bal);
      });
    }
  }

  function closeSheet() {
    const sheet = document.getElementById("chatSheet");
    if (sheet) sheet.hidden = true;
    sheetMode = "";
    sheetYouBalance = null;
  }

  async function confirmSheet() {
    const mode = sheetMode;
    if (mode === "redpacket" || mode === "transfer") {
      const amount = Number(
        (document.getElementById("chatSheetAmount") || {}).value
      );
      const note = String(
        (document.getElementById("chatSheetNote") || {}).value || ""
      ).trim();
      if (!(amount > 0)) {
        setChatErr("请填写金额");
        return;
      }
      if (sheetAmountExceeds(amount, sheetYouBalance)) {
        setChatErr("余额不足");
        return;
      }
      closeSheet();
      await postChatPayload({
        kind: mode,
        amount: amount,
        note: note,
      });
      return;
    }
    if (mode === "location") {
      const name = String(
        (document.getElementById("chatSheetName") || {}).value || ""
      ).trim();
      const detail = String(
        (document.getElementById("chatSheetDetail") || {}).value || ""
      ).trim();
      if (!name) {
        setChatErr("请填写位置名称");
        return;
      }
      closeSheet();
      await postChatPayload({ kind: "location", name: name, detail: detail });
    }
  }

  function onPlusItem(item) {
    if (!item || !item.ok) {
      if (item) shellToast(item.lab + " · 稍后");
      return;
    }
    if (item.id === "album") {
      const inp = document.getElementById("chatImageInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
      return;
    }
    if (item.id === "camera") {
      const inp = document.getElementById("chatCameraInput");
      if (inp) {
        inp.value = "";
        inp.click();
      }
      return;
    }
    if (item.id === "location") {
      openSheet("location");
      return;
    }
    if (item.id === "redpacket") {
      openSheet("redpacket");
      return;
    }
    if (item.id === "transfer") {
      openSheet("transfer");
      return;
    }
    if (item.id === "call") {
      openCallPicker();
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
    if (item.id === "request_song") {
      beginChatRequestSong();
      return;
    }
    if (item.id === "music") {
      shareListenOrPickMusic();
      return;
    }
  }

  const FILE_TEXT_EXT_RE =
    /\.(txt|md|markdown|json|js|ts|tsx|jsx|mjs|cjs|css|html|htm|xml|yml|yaml|toml|ini|csv|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|swift|sh|bat|ps1|sql|log|conf|cfg)$/i;
  const FILE_TEXT_MAX = 8 * 1024;

  function isReadableTextFile(file) {
    const name = String((file && file.name) || "");
    return FILE_TEXT_EXT_RE.test(name);
  }

  function readFileTextExcerpt(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        let t = String(reader.result || "").replace(/\u0000/g, "");
        if (t.length > FILE_TEXT_MAX) t = t.slice(0, FILE_TEXT_MAX);
        resolve(t);
      };
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsText(file);
    });
  }

  function chatMusicAudio() {
    if (global.CovePlayer) return global.CovePlayer.getAudio();
    if (!global.__ariadneChatAudioFallback) {
      global.__ariadneChatAudioFallback = new Audio();
    }
    return global.__ariadneChatAudioFallback;
  }

  function engageListenQuiet() {
    fetch("/api/v1/listen/engage", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {});
  }

  function postMusicSessionEvent(event_type, song, actor) {
    const body = {
      event_type,
      actor: actor || "user",
      song: song
        ? {
            provider:
              song.provider ||
              (song.stream_path ? "netease" : "apple"),
            id: song.id,
            name: song.name,
            artist: song.artist,
            cover: song.cover,
            stream_path: song.stream_path,
            apple_url: song.apple_url,
            preview_url: song.preview_url,
          }
        : undefined,
    };
    fetch("/api/v1/music/session/event", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(() => {
        if (event_type === "play" || event_type === "resume") {
          engageListenQuiet();
        }
      })
      .catch(() => {});
  }

  function explainChatMusicError(code, fallback) {
    const c = String(code || "").trim();
    const map = {
      MUSIC_NO_AUDIO: "没有可播音源（会员/版权/需扫码登录）",
      MUSIC_TRIAL_ONLY: "只有试听片段，整曲需会员或重新扫码",
      MUSIC_NOT_FOUND: "歌曲不存在或已下架",
      netease_unreachable: "连不上网易云 API（本机 :3000）",
      netease_timeout: "网易云 API 超时",
      proxy_failed: "音源代理失败",
      upstream_audio: "上游音源不可用",
    };
    if (map[c]) return map[c];
    const msg = String(fallback || "").trim();
    return msg ? msg.slice(0, 120) : "播放失败";
  }

  async function probeMusicStream(path) {
    try {
      const res = await fetch(path, {
        method: "GET",
        credentials: "same-origin",
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
      });
      if (res.ok || res.status === 206) return null;
      const ct = String(res.headers.get("content-type") || "");
      if (ct.includes("json")) {
        const data = await res.json().catch(() => ({}));
        return explainChatMusicError(data.error, data.message);
      }
      return "音源不可用（HTTP " + res.status + "）";
    } catch (_) {
      return "网络失败，连不上音源";
    }
  }

  function playAudioSrc(src, p, toastPlaying) {
    try {
      const track = p
        ? {
            provider: p.provider || (p.stream_path ? "netease" : "apple"),
            id: p.id,
            name: p.name,
            artist: p.artist,
            cover: p.cover,
            stream_path: p.stream_path,
            apple_url: p.apple_url,
            preview_url: p.preview_url,
          }
        : null;
      if (global.CovePlayer) {
        global.CovePlayer.play(src, {
          track: track,
          owner: "chat",
          volume:
            typeof global.__ariadneMusicVol === "number"
              ? global.__ariadneMusicVol
              : 0.8,
        })
          .then((out) => {
            if (out && out.toggled) {
              postMusicSessionEvent("pause", p, "user");
              shellToast("已暂停");
              return;
            }
            postMusicSessionEvent("play", p, "user");
            if (track && track.id != null) {
              fetch("/api/v1/music/queue", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "enqueue", song: track }),
              }).catch(() => {});
            }
            shellToast(toastPlaying || "播放中");
          })
          .catch(() => {
            shellToast("播放被拦截，点一下页面后再试");
          });
        return;
      }
      const a = chatMusicAudio();
      try {
        const vol =
          typeof global.__ariadneMusicVol === "number"
            ? global.__ariadneMusicVol
            : 0.8;
        a.volume = Math.max(0, Math.min(1, vol));
      } catch (_) {}
      const abs = new URL(src, window.location.origin).href;
      if ((a.src === abs || a.getAttribute("src") === src) && !a.paused) {
        a.pause();
        postMusicSessionEvent("pause", p, "user");
        shellToast("已暂停");
        return;
      }
      a.pause();
      a.onerror = () => {
        probeMusicStream(src).then((msg) => {
          shellToast(msg || "播放失败");
        });
      };
      a.src = src;
      a.play()
        .then(() => {
          postMusicSessionEvent("play", p, "user");
          if (track && track.id != null) {
            fetch("/api/v1/music/queue", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "enqueue", song: track }),
            }).catch(() => {});
          }
          shellToast(toastPlaying || "播放中");
        })
        .catch(() => {
          shellToast("播放被拦截，点一下页面后再试");
        });
    } catch (_) {
      shellToast("播放失败");
    }
  }

  async function openMusicCard(p) {
    const stream = String((p && p.stream_path) || "").trim();
    if (stream || (p && p.provider === "netease" && p.id)) {
      const path =
        stream || "/api/v1/music/stream/netease/" + String(p.id);
      const fail = await probeMusicStream(path);
      if (fail) {
        shellToast(fail);
        return;
      }
      playAudioSrc(path, p, "网易云播放中");
      return;
    }
    const preview = String((p && p.preview_url) || "").trim();
    const link = String((p && p.apple_url) || "").trim();
    if (preview) {
      playAudioSrc(preview, p, "试听中 · 约30秒");
      return;
    }
    if (link) {
      window.open(link, "_blank", "noopener,noreferrer");
      postMusicSessionEvent("ready", p, "user");
      shellToast("已打开 Apple Music");
      return;
    }
    shellToast("这张卡没有可播链接");
  }

  async function shareListenOrPickMusic() {
    try {
      const res = await fetch("/api/v1/listen/presence", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.active && data.track && data.track.title) {
        await postChatPayload({
          kind: "music",
          name: String(data.track.title).trim().slice(0, 80),
          artist: String(data.track.artist || "").trim().slice(0, 80),
          fromPresence: true,
        });
        return;
      }
    } catch (_) {}
    const inp = document.getElementById("chatMusicInput");
    if (inp) {
      inp.value = "";
      inp.click();
    }
  }

  function closeChatSongModal() {
    const m = document.getElementById("chatSongModal");
    if (m) m.hidden = true;
  }

  function beginChatRequestSong() {
    setChatErr("");
    setPanels(null);
    dismissKeyboard();
    const m = document.getElementById("chatSongModal");
    const input = document.getElementById("chatSongQuery");
    const list = document.getElementById("chatSongResults");
    const hint = document.getElementById("chatSongHint");
    if (list) list.replaceChildren();
    if (hint) hint.textContent = "搜到后点一首，发成音乐卡";
    if (m) m.hidden = false;
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
  }

  function paintChatSongResults(songs) {
    const list = document.getElementById("chatSongResults");
    const hint = document.getElementById("chatSongHint");
    if (!list) return;
    list.replaceChildren();
    if (!songs.length) {
      if (hint) hint.textContent = "没有搜到歌";
      return;
    }
    if (hint) hint.textContent = "点一首发到聊天";
    for (const s of songs) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const title = document.createElement("span");
      title.className = "chat-song-title";
      title.textContent = String(s.name || "").trim() || "未命名";
      const meta = document.createElement("span");
      meta.className = "chat-song-meta";
      meta.textContent = [s.artist, s.album].filter(Boolean).join(" · ");
      btn.append(title, meta);
      btn.addEventListener("click", () => sendChatNeteaseSong(s));
      li.append(btn);
      list.append(li);
    }
  }

  async function searchChatNeteaseSongs(query) {
    const q = String(query || "").trim();
    if (!q) throw new Error("请输入歌名");
    const res = await fetch(
      "/api/v1/music/search?provider=netease&limit=8&q=" + encodeURIComponent(q),
      { cache: "no-store", credentials: "same-origin" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "搜歌失败");
    const songs = Array.isArray(data.songs) ? data.songs : [];
    if (!songs.length) throw new Error("没有搜到歌");
    return songs;
  }

  async function sendChatNeteaseSong(track) {
    if (!track || track.id == null) {
      shellToast("无效曲目");
      return;
    }
    const id = Math.floor(Number(track.id));
    const stream =
      String(track.stream_path || "").trim() ||
      "/api/v1/music/stream/netease/" + String(id);
    closeChatSongModal();
    await postChatPayload({
      kind: "music",
      name: String(track.name || "").trim().slice(0, 80) || "未命名",
      artist: String(track.artist || "").trim().slice(0, 80),
      album: String(track.album || "").trim().slice(0, 80),
      provider: "netease",
      id,
      stream_path: stream,
      cover: String(track.cover || "").trim().slice(0, 400),
      song_key: track.song_key ? String(track.song_key).trim().slice(0, 64) : undefined,
    });
    postMusicSessionEvent(
      "ready",
      {
        provider: "netease",
        id,
        name: track.name,
        artist: track.artist,
      },
      "user"
    );
  }

  async function onChatSongSearchSubmit(e) {
    if (e) e.preventDefault();
    const input = document.getElementById("chatSongQuery");
    const hint = document.getElementById("chatSongHint");
    const q = input ? String(input.value || "").trim() : "";
    if (hint) hint.textContent = "搜歌中…";
    try {
      const songs = await searchChatNeteaseSongs(q);
      paintChatSongResults(songs);
    } catch (err) {
      paintChatSongResults([]);
      const msg = (err && err.message) || "点歌失败";
      if (hint) hint.textContent = humanizeChatNetErr(msg);
      shellToast(humanizeChatNetErr(msg));
    }
  }

  async function sendPickedFile(file, kind) {
    if (!file) return;
    setChatErr("");
    if (kind === "file" && !isReadableTextFile(file)) {
      shellToast("暂只读文本");
    }
    setComposerBusy(true);
    try {
      const payload = {
        kind: kind === "music" ? "music" : "file",
        name: file.name || "",
        size: Number(file.size) || 0,
        ext: fileExtLabel(file.name || ""),
      };
      if (kind === "file" && isReadableTextFile(file)) {
        payload.text = await readFileTextExcerpt(file);
      }
      setComposerBusy(false);
      await postChatPayload(payload);
    } catch (e) {
      setChatErr((e && e.message) || "发送失败");
      setComposerBusy(false);
    }
  }

  async function toggleStickerPanel() {
    const panel = document.getElementById("chatStickerPanel");
    if (!panel) return;
    if (!panel.hidden) {
      setPanels(null);
      return;
    }
    try {
      await paintStickerPanel();
      setPanels("sticker");
    } catch (e) {
      setChatErr((e && e.message) || "贴纸包加载失败");
    }
  }

  function togglePlusPanel() {
    const panel = document.getElementById("chatPlusPanel");
    if (!panel) return;
    if (!panel.hidden) {
      setPanels(null);
      return;
    }
    paintPlusPanel();
    setPanels("plus");
  }



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
  function toggleSessionPin(sessId) {
    const id = String(sessId || menuSessId || "daily");
    const pins = readPins();
    const i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1);
    else pins.push(id);
    writePins(pins);
    refreshSessionList();
    shellToast(pins.includes(id) ? "已置顶" : "已取消置顶");
  }
  async function toggleSessionMute(sessId) {
    const id = String(sessId || menuSessId || "daily");
    const mutes = readMutes();
    const i = mutes.indexOf(id);
    if (i >= 0) mutes.splice(i, 1);
    else mutes.push(id);
    writeMutes(mutes);
    await refreshSessionList();
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
    return peerDisplayName(sessId || activePeerId || "daily");
  }
  function refreshPeerLabels() {
    const name = displayPeerName();
    ["chatContactName", "chatProfileName", "chatClearPeerName", "chatPeerPageTitle"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = name;
    });
    const peer = document.getElementById("chatPeerName");
    if (peer && !peer.classList.contains("is-typing")) peer.textContent = name;
  }
  function paintSessBadges() {
    /* 角标在 refreshSessionList 里按行画 */
  }

  /* ========== Shell tabs / thread layer ========== */
  function threadLayerOpen() {
    const layer = document.getElementById("chatThreadLayer");
    return !!(layer && layer.classList.contains("active") && !layer.hidden);
  }
  function closeThreadLayer() {
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    closeRedpacketView();
    closePicViewer();
    layer.classList.remove("active");
    layer.hidden = true;
    closeHist({ skipReturn: true });
    setPanels(null);
    setTyping(false);
    exitMultiMode();
    persistDraft();
    refreshSessionList();
  }
  function openThreadLayer(peerId) {
    closeShellOverlays();
    if (peerId) setActivePeer(peerId);
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    layer.hidden = false;
    layer.classList.add("active");
    refreshPeerLabels();
    applyChatBg();
    restoreDraft();
    refreshChatThread();
    markChatRead().then(() => refreshUnreadUi());
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

  /** V2 CAM_CHECK：提示音 + toast；真截屏在服务端缓冲后执行 */
  function playCamCheckChime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.1, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
      o.onended = () => {
        try {
          ctx.close();
        } catch (_) {}
      };
    } catch (_) {}
  }

  function onCamCheckWait(ev) {
    const sec = Math.max(1, Math.min(10, Math.floor(Number(ev && ev.seconds) || 5)));
    /* 提示音改由壳 WebSocket monitor_alert 播，避免与 WS 叠两声 */
    if (
      !(
        window.__ariadneMonitorAlertAt &&
        Date.now() - window.__ariadneMonitorAlertAt < 2000
      )
    ) {
      playCamCheckChime();
    }
    shellToast("家机要看一眼屏幕 · " + sec + " 秒");
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
  async function fetchUnreadDetail() {
    try {
      const res = await fetch("/api/v1/chat/unread", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { count: 0, byPeer: {} };
      return {
        count: Math.max(0, Math.floor(Number(data.count) || 0)),
        byPeer: data.byPeer && typeof data.byPeer === "object" ? data.byPeer : {},
      };
    } catch (_) {
      return { count: 0, byPeer: {} };
    }
  }
  async function fetchUnreadCount() {
    const d = await fetchUnreadDetail();
    return d.count;
  }
  function unreadBadgeLabel(count, marked) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n > 99) return "99+";
    if (n > 0) return String(n);
    return marked ? "1" : "";
  }
  (function checkUnreadBadge() {
    if (unreadBadgeLabel(0, true) !== "1") throw new Error("mark");
    if (unreadBadgeLabel(3, true) !== "3") throw new Error("keep");
    if (unreadBadgeLabel(0, false) !== "") throw new Error("none");
    if (unreadBadgeLabel(100, true) !== "99+") throw new Error("cap");
  })();
  function paintShellUnread(count, byPeer) {
    const marks = readUnreadMarks();
    const mutes = readMutes();
    const map = byPeer && typeof byPeer === "object" ? byPeer : {};
    let show = false;
    const ids = new Set([...Object.keys(map), ...Object.keys(marks || {})]);
    ids.forEach((id) => {
      if (mutes.includes(id)) return;
      if ((Number(map[id]) || 0) > 0 || marks[id]) show = true;
    });
    if (!ids.size && (Number(count) || 0) > 0) show = true;
    const dot = document.getElementById("chatDockDot");
    if (dot) dot.hidden = !show;
  }
  async function refreshUnreadUi() {
    const d = await fetchUnreadDetail();
    paintShellUnread(d.count, d.byPeer);
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
  function paintSessPreview(preview, fallback) {
    if (!preview) return;
    const rec = readDraftRecord();
    const body = String(rec.body || "").trim();
    const quoteTxt = rec.quote ? String(rec.quote.text || "").trim() : "";
    if (body || quoteTxt) {
      const snip = body || "\u5f15\u7528 " + quoteTxt;
      preview.innerHTML =
        '<span class="is-draft">[\u8349\u7a3f]</span> ' + escapeHtml(snip.slice(0, 80));
      return;
    }
    preview.textContent = fallback;
  }
  function sortPeersForList(peers) {
    const pins = readPins();
    return (peers || []).slice().sort((a, b) => {
      const ap = pins.includes(a.id) ? 1 : 0;
      const bp = pins.includes(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0);
    });
  }
  async function refreshSessionList() {
    syncShellAvatars();
    const list = document.getElementById("chatSessList");
    if (!list) {
      await refreshUnreadUi();
      return;
    }
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const pins = readPins();
    const mutes = readMutes();
    const marks = readUnreadMarks();
    let peers = [];
    try {
      peers = sortPeersForList(await fetchPeers());
    } catch (err) {
      /* 旧网关无 /peers 时降级成单会话，避免整页空白 */
      try {
        console.warn("[chat] peers", err && err.message);
      } catch (_) {}
      peers = [
        {
          id: "daily",
          name: peerDisplayName("daily"),
          unread: 0,
          last: null,
          lastTs: 0,
        },
      ];
      try {
        const msgs = await fetchChatMessages();
        if (msgs.length) {
          peers[0].last = msgs[msgs.length - 1];
          peers[0].lastTs = peers[0].last.ts || 0;
        }
      } catch (_) {}
    }
    list.replaceChildren();
    peers.forEach((p) => {
      const id = p.id;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-sess";
      row.dataset.sessId = id;
      if (pins.includes(id)) row.classList.add("is-pinned");
      const unreadN = Math.max(0, Math.floor(Number(p.unread) || 0));
      const marked = !!marks[id];
      const showBadge = unreadN > 0 || marked;
      const muted = mutes.includes(id);
      row.innerHTML =
        '<span class="chat-av-wrap' +
        (id === "daily" ? " av-frame-full" : "") +
        '">' +
        '<img class="face" src="' +
        escapeHtml(bot) +
        '" alt="" />' +
        '<span class="chat-badge"' +
        (showBadge ? "" : " hidden") +
        ">" +
        escapeHtml(unreadBadgeLabel(unreadN, marked)) +
        "</span></span>" +
        '<span class="chat-sess-body">' +
        '<span class="chat-sess-row1">' +
        '<span class="chat-sess-namewrap">' +
        '<span class="chat-sess-name">' +
        escapeHtml(peerDisplayName(id)) +
        "</span>" +
        '<span class="chat-sess-pin"' +
        (pins.includes(id) ? "" : " hidden") +
        ">置顶</span>" +
        '<span class="chat-sess-mute"' +
        (muted ? "" : " hidden") +
        ">免打扰</span>" +
        "</span>" +
        '<span class="chat-sess-time">' +
        escapeHtml(p.lastTs ? sessTimeLabel(p.lastTs) : "") +
        "</span></span>" +
        '<span class="chat-sess-preview"></span></span>';
      const preview = row.querySelector(".chat-sess-preview");
      if (preview) {
        const fallback = p.last ? histPreview(p.last) || "…" : "还没有短讯";
        if (id === (activePeerId || "daily")) paintSessPreview(preview, fallback);
        else preview.textContent = fallback;
      }
      row.addEventListener("click", () => openThreadLayer(id));
      bindLongPress(row, () => openSessMenu(id));
      list.appendChild(row);
    });
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
  function quoteForStore(q) {
    if (!q || !String(q.text || "").trim()) return null;
    return {
      id: String(q.id || ""),
      who: String(q.who || ""),
      text: String(q.text).trim().slice(0, 120),
    };
  }
  function parseDraftRaw(raw) {
    const s = String(raw || "");
    if (!s) return { body: "", quote: null };
    if (s.charAt(0) === "{") {
      try {
        const o = JSON.parse(s);
        if (o && typeof o === "object" && ("body" in o || "quote" in o)) {
          return { body: String(o.body || ""), quote: quoteForStore(o.quote) };
        }
      } catch (_) {}
    }
    return { body: s, quote: null };
  }
  function readDraftRecord() {
    const key = draftKey();
    let raw = lsGet(key, "");
    if (!raw && (activePeerId || "daily") === "daily") {
      raw = lsGet("ariadne.chat.draft.daily", "");
    }
    return parseDraftRaw(raw);
  }
  (function checkDraftRecord() {
    const leg = parseDraftRaw("hi");
    const js = parseDraftRaw(
      JSON.stringify({ body: "a", quote: { id: "1", who: "w", text: "t" } })
    );
    const bad = parseDraftRaw("{not json");
    const blank = parseDraftRaw(JSON.stringify({ body: "", quote: { text: "  " } }));
    if (leg.body !== "hi" || leg.quote) throw new Error("draft legacy");
    if (js.body !== "a" || !js.quote || js.quote.text !== "t") throw new Error("draft json");
    if (bad.body !== "{not json" || bad.quote) throw new Error("draft plain");
    if (blank.body || blank.quote) throw new Error("draft blank");
  })();
  function persistDraft() {
    const input = document.getElementById("dailyChatInput");
    const body = input ? String(input.value || "") : "";
    const quote = quoteForStore(pendingQuote);
    const key = draftKey();
    if (!String(body).trim() && !quote) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      return;
    }
    lsSet(key, JSON.stringify({ body: body, quote: quote }));
  }
  function restoreDraft() {
    const input = document.getElementById("dailyChatInput");
    const rec = readDraftRecord();
    if (input && rec.body && !input.value) input.value = rec.body;
    pendingQuote = rec.quote;
    paintQuoteBar();
    syncSendPlus();
  }
  function clearPendingQuote() {
    pendingQuote = null;
    const bar = document.getElementById("chatQuoteBar");
    if (bar) bar.hidden = true;
    persistDraft();
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
      who: msg.from === "you" ? "\u4f60" : peer,
      text: String(histPreview(msg) || "").slice(0, 120),
    };
    paintQuoteBar();
    persistDraft();
  }
  function threadNearBottom() {
    const box = document.getElementById("chatThread");
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  function setNewMsgChip(n) {
    const el = document.getElementById("chatNewMsg");
    if (!el) return;
    const count = Math.max(0, Math.floor(Number(n) || 0));
    newMsgPending = count;
    if (!count) {
      el.hidden = true;
      el.replaceChildren();
      el.setAttribute("aria-label", "\u65b0\u6d88\u606f");
      return;
    }
    el.hidden = false;
    /* 效果图：双下箭头 + 数字（CSS 画箭头，避免 ∨→VV） */
    const chev = document.createElement("span");
    chev.className = "wx-new-msg-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.append(document.createElement("i"), document.createElement("i"));
    const num = document.createElement("span");
    num.className = "wx-new-msg-n";
    num.textContent = String(count);
    el.replaceChildren(chev, num);
    el.setAttribute("aria-label", count + " \u6761\u65b0\u6d88\u606f");
  }

  let locViewCopy = "";
  function openLocView(name, detail) {
    const view = document.getElementById("chatLocView");
    const nameEl = document.getElementById("chatLocName");
    const detailEl = document.getElementById("chatLocDetail");
    if (!view) return;
    const n = String(name || "").trim() || "位置";
    const d = String(detail || "").trim();
    locViewCopy = d ? n + "\n" + d : n;
    if (nameEl) nameEl.textContent = n;
    if (detailEl) {
      detailEl.textContent = d;
      detailEl.hidden = !d;
    }
    view.hidden = false;
  }
  function closeLocView() {
    const view = document.getElementById("chatLocView");
    if (view) view.hidden = true;
    locViewCopy = "";
  }

  /* ========== Pic viewer ========== */
  /** H1.83：相邻连续 image 合成一组；rows=[{id,kind,url}] */
  function adjacentImageRun(rows, msgId) {
    const list = Array.isArray(rows) ? rows : [];
    const want = String(msgId || "");
    const empty = { urls: [], idx: 0 };
    if (!want || !list.length) return empty;
    const i = list.findIndex((r) => r && String(r.id) === want);
    if (i < 0) return empty;
    const urlAt = (j) => {
      const r = list[j];
      if (!r || r.kind !== "image") return "";
      return String(r.url || "").trim();
    };
    if (!urlAt(i)) return empty;
    let lo = i;
    while (lo > 0 && urlAt(lo - 1)) lo--;
    let hi = i;
    while (hi + 1 < list.length && urlAt(hi + 1)) hi++;
    const urls = [];
    let idx = 0;
    for (let j = lo; j <= hi; j++) {
      if (j === i) idx = urls.length;
      urls.push(urlAt(j));
    }
    return { urls, idx };
  }
  /* ponytail: H1.83 连图分组自检 */
  (function () {
    const rows = [
      { id: "a", kind: "text", url: "" },
      { id: "1", kind: "image", url: "/u1" },
      { id: "2", kind: "image", url: "/u2" },
      { id: "b", kind: "text", url: "" },
      { id: "3", kind: "image", url: "/u3" },
    ];
    const g = adjacentImageRun(rows, "2");
    if (g.urls.length !== 2 || g.idx !== 1 || g.urls[0] !== "/u1") throw new Error("run mid");
    const one = adjacentImageRun(rows, "3");
    if (one.urls.length !== 1 || one.idx !== 0) throw new Error("run single");
  })();

  function collectAdjacentChatImages(msgId) {
    const box = document.getElementById("chatThread");
    if (!box) return { urls: [], idx: 0 };
    const rows = Array.from(box.querySelectorAll(".wx-row[data-msg-id]")).map((row) => {
      const img = row.querySelector("img.chat-pic");
      return {
        id: row.dataset.msgId,
        kind: row.dataset.kind || "",
        url: (img && (img.currentSrc || img.src)) || "",
      };
    });
    return adjacentImageRun(rows, msgId);
  }

  function syncPicNav() {
    const prev = document.getElementById("chatPicPrev");
    const next = document.getElementById("chatPicNext");
    if (prev) prev.hidden = picUrls.length < 2 || picIdx <= 0;
    if (next) next.hidden = picUrls.length < 2 || picIdx >= picUrls.length - 1;
  }
  function openPicViewer(urls, idx) {
    picUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
    picIdx = Math.max(0, Math.min(Number(idx) || 0, picUrls.length - 1));
    const view = document.getElementById("chatPicView");
    const img = document.getElementById("chatPicViewImg");
    if (!view || !img || !picUrls.length) return;
    img.src = picUrls[picIdx];
    view.hidden = false;
    syncPicNav();
  }
  function closePicViewer() {
    const view = document.getElementById("chatPicView");
    if (view) view.hidden = true;
  }
  function stepPic(dir) {
    if (picUrls.length < 2) return;
    const next = picIdx + (Number(dir) || 0);
    if (next < 0 || next >= picUrls.length) return;
    picIdx = next;
    const img = document.getElementById("chatPicViewImg");
    if (img) img.src = picUrls[picIdx];
    syncPicNav();
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
    if (regen) {
      const box = document.getElementById("chatThread");
      const row =
        box &&
        payload.refId &&
        box.querySelector('.wx-row[data-msg-id="' + String(payload.refId).replace(/"/g, "") + '"]');
      regen.hidden = !canRegenRow(row);
    }
    if (recall) {
      const ts = payload.msg && payload.msg.ts;
      recall.hidden =
        payload.from !== "you" ||
        !!payload.recalled ||
        recallExpiredUi(ts);
    }
    if (react) {
      const kind = payload.kind || "";
      react.hidden =
        !!payload.recalled ||
        !payload.refId ||
        kind === "tool" ||
        kind === "call" ||
        kind === "pat";
    }
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
        const run = collectAdjacentChatImages(msg.id);
        if (run.urls.length) openPicViewer(run.urls, run.idx);
        else openPicViewer([msg.body], 0);
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
        recalled: !!msg.recalled,
        msg: msg,
      });
    });
  }
  async function copyCtxText(text) {
    const t = String(text || "");
    if (!t) return false;
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
      return true;
    } catch (_) {
      shellToast("复制失败");
      return false;
    }
  }
  function canTranslateKind(kind) {
    return !/^(image|sticker|redpacket|transfer|file|music|location|voice|call|pat|tool|recall)$/.test(
      String(kind || "")
    );
  }
  function nextTranslateState(open, hasText) {
    if (open) return "hide";
    if (hasText) return "show";
    return "fetch";
  }
  (function checkTranslateToggle() {
    if (canTranslateKind("text") !== true) throw new Error("text");
    if (canTranslateKind("image") !== false) throw new Error("image");
    if (canTranslateKind("redpacket") !== false) throw new Error("money");
    if (nextTranslateState(true, true) !== "hide") throw new Error("hide");
    if (nextTranslateState(false, true) !== "show") throw new Error("show");
    if (nextTranslateState(false, false) !== "fetch") throw new Error("fetch");
  })();
  function translateHost(refId) {
    const id = String(refId || "");
    if (!id) return null;
    const row = document.querySelector('.wx-row[data-msg-id="' + CSS.escape(id) + '"]');
    if (!row) return null;
    const bubble = rowBubble(row);
    if (!bubble) return null;
    let col = row.querySelector(":scope > .wx-col");
    if (!col) {
      col = document.createElement("div");
      col.className = "wx-col";
      bubble.replaceWith(col);
      col.append(bubble);
    }
    return col;
  }
  async function translateCtxUi(p) {
    if (!p || !String(p.text || "").trim()) return;
    if (p.recalled || !canTranslateKind(p.kind)) {
      shellToast("\u8fd9\u7c7b\u6d88\u606f\u6682\u4e0d\u7ffb\u8bd1");
      return;
    }
    const col = translateHost(p.refId);
    if (!col) {
      shellToast("\u7ffb\u8bd1\u5931\u8d25");
      return;
    }
    let panel = col.querySelector(".wx-tr-panel");
    const open = !!(panel && !panel.hidden);
    const cached = panel ? String(panel.dataset.tr || "") : "";
    const step = nextTranslateState(open, !!cached);
    if (step === "hide") {
      panel.hidden = true;
      return;
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "wx-tr-panel";
      panel.hidden = true;
      col.append(panel);
    }
    if (step === "show") {
      panel.textContent = cached;
      panel.hidden = false;
      return;
    }
    if (panel.dataset.busy === "1") return;
    panel.dataset.busy = "1";
    panel.hidden = false;
    panel.textContent = "\u7ffb\u8bd1\u4e2d\u2026";
    try {
      const res = await fetch("/api/v1/chat/translate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(p.text || "").slice(0, 800) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "\u7ffb\u8bd1\u5931\u8d25");
      const translation = String(data.translation || "").trim();
      if (!translation) throw new Error("\u7ffb\u8bd1\u5931\u8d25");
      panel.dataset.tr = translation;
      panel.textContent = translation;
      panel.hidden = false;
    } catch (err) {
      panel.hidden = true;
      panel.textContent = "";
      shellToast((err && err.message) || "\u7ffb\u8bd1\u5931\u8d25");
    } finally {
      delete panel.dataset.busy;
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
  function recallExpiredUi(ts, now) {
    const t = Number(ts) || 0;
    const n = now != null ? Number(now) : Date.now();
    if (!t) return true;
    return n - t > RECALL_MAX_AGE_MS;
  }
  (function checkRecallAge() {
    if (!recallExpiredUi(Date.now() - RECALL_MAX_AGE_MS - 1)) throw new Error("old");
    if (recallExpiredUi(Date.now() - 1000)) throw new Error("fresh");
  })();
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(fallback);
      }, Math.max(0, Number(ms) || 0));
      Promise.resolve(promise).then(
        (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }
  function recallRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function recallWrapLines(ctx, text, maxWidth) {
    const chars = Array.from(String(text || ""));
    const lines = [];
    let line = "";
    for (const ch of chars) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  function loadRecallImage(src) {
    return new Promise((resolve) => {
      const url = String(src || "").trim();
      if (!url) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  async function fetchRecallImage(src) {
    const url = String(src || "").trim();
    if (!url) return null;
    if (url.indexOf("data:") === 0) return loadRecallImage(url);
    try {
      const res = await fetch(url, { credentials: "same-origin", cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const img = await loadRecallImage(obj);
      URL.revokeObjectURL(obj);
      return img;
    } catch (_) {
      return null;
    }
  }
  function canvasToPngBlob(canvas) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob || null), "image/png");
      } catch (_) {
        resolve(null);
      }
    });
  }
  async function uploadRecallShot(blob) {
    if (!blob || !blob.size) return "";
    try {
      const res = await fetch("/api/v1/chat/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) return "";
      return String(data.url);
    } catch (_) {
      return "";
    }
  }
  async function captureRecallShot(id) {
    const sid = String(id || "");
    const box = document.getElementById("chatThread");
    if (!sid || !box) return "";
    const row = box.querySelector('.wx-row[data-msg-id="' + CSS.escape(sid) + '"]');
    if (!row || !row.classList.contains("me")) return "";
    const bubble = row.querySelector(".bubble");
    if (!bubble) return "";
    const avEl = row.querySelector(".av img");
    const textEl = bubble.querySelector(".wx-bubble-text");
    const mediaEl = bubble.querySelector("img.sticker, .is-media img");
    const av = 36;
    const frameScale = 1.65;
    const frameExtra = Math.ceil((av * frameScale - av) / 2);
    const bunnySize = 48;
    const bunnyOffX = 14;
    const bunnyOffY = 20;
    const pad = 14 + Math.max(frameExtra, bunnyOffY);
    const gap = 10;
    const maxBubble = 210;
    const lineH = Math.round(15 * 1.45);
    const padX = 14;
    const padY = 10;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.font = "15px sans-serif";
    let bubbleW = 80;
    let bubbleH = 40;
    let lines = [];
    let mediaImg = null;
    const looksMedia =
      bubble.classList.contains("is-media") ||
      !!(mediaEl && (mediaEl.classList.contains("sticker") || mediaEl.closest(".is-media")));
    const customWall = String(lsGet(LS.bgPick, "") || "").trim();
    const defaultWall = "/assets/chat/skin/wallpaper.jpg";
    const assetPack = await Promise.all([
      fetchRecallImage(avEl && (avEl.currentSrc || avEl.src)),
      fetchRecallImage("/assets/chat/skin/avatar-frame.png"),
      fetchRecallImage(customWall || defaultWall),
      customWall ? fetchRecallImage(defaultWall) : Promise.resolve(null),
      fetchRecallImage("/assets/chat/skin/bubble-deco-them.png"),
      looksMedia && mediaEl
        ? fetchRecallImage(mediaEl.currentSrc || mediaEl.src)
        : Promise.resolve(null),
    ]);
    const avImg = assetPack[0];
    const frameImg = assetPack[1];
    const wallImg = assetPack[2] || assetPack[3];
    const bunnyImg = assetPack[4];
    mediaImg = assetPack[5];
    if (mediaImg) {
      const mw = Math.min(maxBubble - padX * 2, mediaImg.naturalWidth || 120);
      const mh = Math.max(
        40,
        Math.round(((mediaImg.naturalHeight || 120) * mw) / (mediaImg.naturalWidth || 120))
      );
      bubbleW = mw + padX * 2;
      bubbleH = mh + padY * 2;
    } else {
      const text = String((textEl && textEl.textContent) || bubble.innerText || "").trim() || "...";
      lines = recallWrapLines(ctx, text, maxBubble - padX * 2);
      let tw = 0;
      for (const ln of lines) tw = Math.max(tw, ctx.measureText(ln).width);
      bubbleW = Math.min(maxBubble, Math.max(48, Math.ceil(tw) + padX * 2));
      bubbleH = lines.length * lineH + padY * 2;
    }
    const W = pad * 2 + av + gap + bubbleW;
    const H = pad * 2 + Math.max(av + frameExtra, bubbleH + bunnyOffY);
    const scale = 2;
    canvas.width = Math.max(1, Math.round(W * scale));
    canvas.height = Math.max(1, Math.round(H * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (wallImg && wallImg.naturalWidth) {
      const iw = wallImg.naturalWidth;
      const ih = wallImg.naturalHeight;
      const cover = Math.max(W / iw, H / ih);
      const dw = iw * cover;
      const dh = ih * cover;
      ctx.drawImage(wallImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = "#e8f2ee";
      ctx.fillRect(0, 0, W, H);
    }
    const ax = pad;
    const ay = pad;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (avImg) ctx.drawImage(avImg, ax, ay, av, av);
    else {
      ctx.fillStyle = "#f8fcfb";
      ctx.fillRect(ax, ay, av, av);
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ax + av / 2, ay + av / 2, av / 2, 0, Math.PI * 2);
    ctx.stroke();
    if (frameImg && frameImg.naturalWidth) {
      const fs = av * frameScale;
      ctx.drawImage(frameImg, ax + (av - fs) / 2, ay + (av - fs) / 2, fs, fs);
    }
    const bx = pad + av + gap;
    const by = pad + Math.max(0, (Math.max(av, bubbleH) - bubbleH) / 2);
    ctx.fillStyle = "#b5a198";
    recallRoundRect(ctx, bx, by, bubbleW, bubbleH, 20);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    recallRoundRect(ctx, bx, by, bubbleW, bubbleH, 20);
    ctx.stroke();
    if (mediaImg) {
      ctx.drawImage(mediaImg, bx + padX, by + padY, bubbleW - padX * 2, bubbleH - padY * 2);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.font = "15px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const blockH = lines.length * lineH;
      let ty = by + (bubbleH - blockH) / 2 + lineH / 2;
      for (const ln of lines) {
        ctx.fillText(ln, bx + padX, ty);
        ty += lineH;
      }
    }
    if (bunnyImg && bunnyImg.naturalWidth) {
      ctx.drawImage(bunnyImg, bx - bunnyOffX, by - bunnyOffY, bunnySize, bunnySize);
    }
    const blob = await canvasToPngBlob(canvas);
    return uploadRecallShot(blob);
  }
  async function recallChatMessageUi(id, ts) {
    const sid = String(id || "").trim();
    if (!sid || recallBusy) return;
    if (recallExpiredUi(ts)) {
      shellToast("\u8d85\u8fc72\u5206\u949f\u4e0d\u80fd\u64a4\u56de");
      return;
    }
    const box = document.getElementById("chatThread");
    setChatErr("");
    recallBusy = true;
    let shot = "";
    try {
      shot = (await withTimeout(captureRecallShot(sid), 2500, "")) || "";
    } catch (_) {
      shot = "";
    }
    try {
      const res = await fetch("/api/v1/chat/messages/" + encodeURIComponent(sid) + "/recall", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          withPeerBody(shot ? { screenshot: shot } : {})
        ),
      });
      const ctype = String(res.headers.get("content-type") || "");
      if (!ctype.includes("event-stream")) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || "\u64a4\u56de\u5931\u8d25");
        if (data.message) patchMessageBubble(data.message);
        return;
      }
      if (!res.ok && !res.body) {
        throw new Error("\u64a4\u56de\u5931\u8d25");
      }
      await readChatSse(res, makeChatStream(box));
      if (chatViewActive()) await markChatRead();
    } catch (err) {
      shellToast((err && err.message) || "\u64a4\u56de\u5931\u8d25");
    } finally {
      recallBusy = false;
      setTyping(false);
    }
  }
  async function deleteChatMessageUi(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" + encodeURIComponent(sid) + "?" + peerQuery(),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "删除失败");
      const box = document.getElementById("chatThread");
      const row = box && box.querySelector('.wx-row[data-msg-id="' + sid + '"]');
      if (row) {
        row.remove();
        pruneOrphanTimeChips(box);
      } else await refreshChatThread();
    } catch (err) {
      shellToast((err && err.message) || "删除失败");
    }
  }
  function canRegenRow(row) {
    if (!row || row.dataset.kind !== "text" || !row.classList.contains("them")) return false;
    let n = row.nextElementSibling;
    while (n) {
      if (n.classList && n.classList.contains("wx-row")) {
        if (n.classList.contains("me")) return false;
        if (n.classList.contains("them") && n.dataset.kind === "text") return false;
      }
      n = n.nextElementSibling;
    }
    return true;
  }

  function syncVariantBar(col, msg) {
    if (!col) return;
    let bar = col.querySelector(".wx-variant-bar");
    const variants = msg && Array.isArray(msg.variants) ? msg.variants : [];
    if (variants.length < 2 || !msg || !msg.id) {
      if (bar) bar.remove();
      return;
    }
    const idx = Number(msg.variantIndex) || 0;
    const n = variants.length;
    const cur = Math.max(0, Math.min(idx, n - 1)) + 1;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wx-variant-bar";
      bar.innerHTML =
        '<button type="button" class="wx-var-prev" aria-label="\u4e0a\u4e00\u7248">\u2039</button>' +
        '<span class="wx-var-lab"></span>' +
        '<button type="button" class="wx-var-next" aria-label="\u4e0b\u4e00\u7248">\u203a</button>';
      col.append(bar);
      bar.querySelector(".wx-var-prev").addEventListener("click", (e) => {
        e.stopPropagation();
        const id = bar.dataset.msgId;
        const i = Number(bar.dataset.index) || 0;
        if (i > 0) switchMessageVariant(id, i - 1);
      });
      bar.querySelector(".wx-var-next").addEventListener("click", (e) => {
        e.stopPropagation();
        const id = bar.dataset.msgId;
        const i = Number(bar.dataset.index) || 0;
        const total = Number(bar.dataset.total) || 0;
        if (i < total - 1) switchMessageVariant(id, i + 1);
      });
    }
    bar.dataset.msgId = String(msg.id);
    bar.dataset.index = String(Math.max(0, Math.min(idx, n - 1)));
    bar.dataset.total = String(n);
    const lab = bar.querySelector(".wx-var-lab");
    if (lab) lab.textContent = cur + "/" + n;
    const prev = bar.querySelector(".wx-var-prev");
    const next = bar.querySelector(".wx-var-next");
    if (prev) prev.disabled = cur <= 1;
    if (next) next.disabled = cur >= n;
  }

  async function switchMessageVariant(id, index) {
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" + encodeURIComponent(id) + "/variant",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withPeerBody({ index: index })),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "\u5207\u6362\u5931\u8d25");
      if (data.message) patchMessageBubble(data.message);
    } catch (err) {
      shellToast((err && err.message) || "\u5207\u6362\u5931\u8d25");
    }
  }

  async function regenerateBotMessage(id) {
    if (!id || regenBusy || sending) {
      shellToast(sending || regenBusy ? "\u8bf7\u7a0d\u5019" : "\u65e0\u6cd5\u91cd\u751f");
      return;
    }
    const box = document.getElementById("chatThread");
    const row = box && box.querySelector('.wx-row[data-msg-id="' + String(id).replace(/"/g, "") + '"]');
    const bubble = row && row.querySelector(".bubble");
    if (!bubble || !canRegenRow(row)) {
      shellToast("\u53ea\u80fd\u91cd\u751f\u6700\u65b0\u4e00\u6761\u5bb6\u673a\u6587\u5b57");
      return;
    }
    regenBusy = true;
    setComposerBusy(true);
    setChatErr("");
    let pendingToolRow = null;
    const paintFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" +
          encodeURIComponent(id) +
          "/regenerate?" +
          peerQuery(),
        {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "text/event-stream" },
        }
      );
      const ctype = String(res.headers.get("content-type") || "");
      if (!res.ok && !ctype.includes("event-stream")) {
        let data = {};
        try {
          data = await res.json();
        } catch (_) {
          data = {};
        }
        throw new Error(data.message || data.error || "\u91cd\u65b0\u751f\u6210\u5931\u8d25");
      }
      if (!res.body || !res.body.getReader) throw new Error("\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u6d41\u5f0f\u8bfb\u53d6");
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let cleared = false;
      const handleEvent = async (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === "bot_start") {
          pendingThink = { sec: 0, text: "" };
          thinkAttached = false;
          cleared = false;
          setTyping(true);
        } else if (ev.type === "bot_think") {
          if (ev.text) {
            pendingThink.text = pendingThink.text
              ? pendingThink.text + "\n---\n" + ev.text
              : String(ev.text);
          }
          if (Number(ev.seconds) > 0) pendingThink.sec += Number(ev.seconds);
          ensureBunnyThink(bubble, {
            think: pendingThink.text,
            think_sec: pendingThink.sec,
          });
        } else if (ev.type === "bot_tool" && ev.name) {
          pendingToolRow = appendToolChip(ev.name, ev.label);
        } else if (ev.type === "cam_check_wait") {
          onCamCheckWait(ev);
        } else if (ev.type === "bot_tool_done") {
          finishToolChip(pendingToolRow, ev);
          pendingToolRow = null;
        } else if (ev.type === "bot_music" && ev.message) {
          appendChatMessage(ev.message);
        } else if (ev.type === "bot_delta" && ev.text) {
          if (!cleared) {
            bubbleTextEl(bubble).textContent = "";
            cleared = true;
          }
          const te = bubbleTextEl(bubble);
          te.textContent = (te.textContent || "") + ev.text;
          if (nearBottom && box) box.scrollTop = box.scrollHeight;
        } else if (ev.type === "bot_done" && ev.message) {
          fillBubble(bubble, ev.message);
          ensureBunnyThink(bubble, ev.message);
          const col = row.querySelector(".wx-col");
          if (col) syncVariantBar(col, ev.message);
          setTyping(false);
        } else if (ev.type === "bot_error") {
          setTyping(false);
          if (ev.message) shellToast(ev.message);
        } else if (ev.type === "done") {
          setTyping(false);
          if (ev.bot_error) {
            if (ev.message) {
              fillBubble(bubble, ev.message);
              ensureBunnyThink(bubble, ev.message);
              const col = row.querySelector(".wx-col");
              if (col) syncVariantBar(col, ev.message);
            }
            shellToast(ev.bot_error.message || "\u91cd\u65b0\u751f\u6210\u5931\u8d25");
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw[0] === ":") continue;
            try {
              await handleEvent(JSON.parse(raw));
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      setTyping(false);
      shellToast((err && err.message) || "\u91cd\u65b0\u751f\u6210\u5931\u8d25");
    } finally {
      regenBusy = false;
      setComposerBusy(false);
    }
  }

  function nextReactions(list, from, emoji) {
    const cur = (Array.isArray(list) ? list : []).filter((r) => r && r.emoji && r.from);
    const same = cur.findIndex((r) => r.from === from && r.emoji === emoji);
    if (same >= 0) return cur.filter((_, i) => i !== same);
    return cur.filter((r) => r.from !== from).concat([{ from: from, emoji: emoji }]);
  }
  (function checkReactions() {
    const added = nextReactions([], "you", "a");
    if (added.length !== 1 || added[0].emoji !== "a") throw new Error("add");
    if (nextReactions(added, "you", "a").length !== 0) throw new Error("toggle");
    const swapped = nextReactions(added, "you", "b");
    if (swapped.length !== 1 || swapped[0].emoji !== "b") throw new Error("swap");
    const kept = nextReactions([{ from: "bot", emoji: "c" }, { from: "you", emoji: "a" }], "you", "b");
    if (kept.length !== 2 || kept[0].from !== "bot" || kept[1].emoji !== "b") throw new Error("keep");
  })();
  function paintQuoteRef(row, msg) {
    if (!row) return;
    const bubble = rowBubble(row);
    if (!bubble) return;
    let col = row.querySelector(":scope > .wx-col");
    if (!col) {
      col = document.createElement("div");
      col.className = "wx-col";
      bubble.replaceWith(col);
      col.append(bubble);
    }
    let ref = col.querySelector(":scope > .wx-quote-ref");
    const q = msg && msg.quote;
    const text = q ? String(q.text || "").trim() : "";
    if (!text) {
      if (ref) ref.remove();
      return;
    }
    if (!ref) {
      ref = document.createElement("button");
      ref.type = "button";
      ref.className = "wx-quote-ref";
      const anchor =
        col.querySelector(":scope > .wx-voice-line") || bubble;
      const next = anchor.nextSibling;
      if (next) col.insertBefore(ref, next);
      else col.append(ref);
    }
    const who = String((q && q.who) || "").trim() || "\u2026";
    const snip = text.length > 48 ? text.slice(0, 48) + "\u2026" : text;
    ref.textContent = who + ": " + snip;
    const qid = q && q.id ? String(q.id) : "";
    ref.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!qid || !scrollToMessage(qid)) shellToast("\u539f\u6d88\u606f\u5df2\u4e0d\u5728");
    };
  }
  function paintReactions(row, reactions) {
    if (!row) return;
    const bubble = rowBubble(row);
    if (!bubble) return;
    let col = row.querySelector(":scope > .wx-col");
    if (!col) {
      col = document.createElement("div");
      col.className = "wx-col";
      bubble.replaceWith(col);
      col.append(bubble);
    }
    let bar = col.querySelector(":scope > .wx-reacts");
    const list = (Array.isArray(reactions) ? reactions : []).filter((r) => r && r.emoji);
    if (!list.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wx-reacts";
      col.append(bar);
    }
    bar.replaceChildren();
    for (const r of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wx-react " + (r.from === "you" ? "is-you" : "is-bot");
      b.textContent = r.emoji;
      if (r.from === "you") {
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          postReaction(row.getAttribute("data-msg-id"), r.emoji);
        });
      } else {
        b.disabled = true;
      }
      bar.append(b);
    }
  }
  async function postReaction(id, emoji) {
    const sid = String(id || "");
    const emo = String(emoji || "").trim();
    if (!sid || !emo) return;
    try {
      const res = await fetch("/api/v1/chat/messages/" + encodeURIComponent(sid) + "/react", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withPeerBody({ emoji: emo })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "\u6ca1\u8d34\u4e0a");
      const box = document.getElementById("chatThread");
      const row =
        box && box.querySelector('.wx-row[data-msg-id="' + CSS.escape(sid) + '"]');
      if (row) paintReactions(row, data.message && data.message.reactions);
    } catch (err) {
      shellToast((err && err.message) || "\u6ca1\u8d34\u4e0a");
    }
  }
  async function postVoiceTranscribe(id) {
    const sid = String(id || "");
    if (!sid || multiMode) return;
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" +
          encodeURIComponent(sid) +
          "/transcribe?" +
          peerQuery(),
        { method: "POST", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error((data && data.message) || "转文字失败");
      }
      if (data.message) patchMessageBubble(data.message);
    } catch (err) {
      shellToast((err && err.message) || "转文字失败");
    }
  }
  /** 转文字/收起挂在气泡外，避免展开时把语音气泡挤歪 */
  function paintVoiceAsr(row, msg) {
    if (!row) return;
    const oldLine = row.querySelector(".wx-voice-line");
    const oldBox = row.querySelector(".wx-voice-asr-box");
    if (!msg || msg.kind !== "voice") {
      if (oldLine) {
        const b = oldLine.querySelector(".bubble");
        if (b && oldLine.parentNode) {
          oldLine.parentNode.insertBefore(b, oldLine);
          oldLine.remove();
        }
      }
      if (oldBox) oldBox.remove();
      return;
    }
    let bubble = row.querySelector(".bubble.is-voice") || row.querySelector(".bubble");
    if (!bubble) return;
    let col = row.querySelector(".wx-col");
    if (!col) {
      col = document.createElement("div");
      col.className = "wx-col";
      bubble.replaceWith(col);
      col.append(bubble);
    }
    let line = col.querySelector(":scope > .wx-voice-line");
    if (!line) {
      line = document.createElement("div");
      line.className = "wx-voice-line";
      col.insertBefore(line, bubble);
    }
    if (bubble.parentElement !== line) line.append(bubble);
    let asrBtn = line.querySelector(".wx-voice-asr");
    if (!asrBtn) {
      asrBtn = document.createElement("button");
      asrBtn.type = "button";
      asrBtn.className = "wx-voice-asr";
      line.append(asrBtn);
    }
    const p = msg.payload || {};
    const showTr = !!(p.transcript && !p.transcriptHidden);
    asrBtn.textContent = showTr ? "收起" : "转文字";
    asrBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (multiMode) return;
      postVoiceTranscribe(msg.id);
    };
    let box = col.querySelector(":scope > .wx-voice-asr-box");
    if (showTr) {
      if (!box) {
        box = document.createElement("div");
        box.className = "wx-voice-asr-box";
        const after = line.nextSibling;
        if (after) col.insertBefore(box, after);
        else col.append(box);
      }
      box.classList.toggle("is-stub", !!p.transcriptStub);
      box.replaceChildren();
      const lab = document.createElement("div");
      lab.className = "lab";
      lab.textContent = "转文字";
      const body = document.createElement("div");
      body.textContent = p.transcript;
      box.append(lab, body);
      box.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (multiMode) return;
        postVoiceTranscribe(msg.id);
      };
    } else if (box) {
      box.remove();
    }
  }
  function openReactSheet(p) {
    const sheet = document.getElementById("chatReactSheet");
    const inp = document.getElementById("chatReactInput");
    if (!sheet || !p || !p.refId) return;
    reactMsgId = String(p.refId);
    sheet.hidden = false;
    if (inp) {
      inp.value = "";
      inp.focus();
      inp.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const emo = String(inp.value || "").trim();
        if (!emo) {
          shellToast("\u8bf7\u9009\u4e00\u4e2a\u8868\u60c5");
          return;
        }
        sheet.hidden = true;
        postReaction(reactMsgId, emo);
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
      const items = collectForwardables(p.refId ? [p.refId] : []);
      if (!items.length) {
        shellToast("这条不能转发");
        return;
      }
      openFwdSheet(items);
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
      await recallChatMessageUi(p.refId, p.msg && p.msg.ts);
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
    const box = document.getElementById("chatThread");
    if (!box) return;
    const lines = [];
    box.querySelectorAll(".wx-row[data-msg-id]").forEach((row) => {
      const id = row.getAttribute("data-msg-id");
      if (!multiIds.has(id)) return;
      const kind = row.dataset.kind || "";
      if (kind === "image" || kind === "sticker") return;
      const bubble = row.querySelector(".bubble");
      if (!bubble || bubble.classList.contains("is-media")) return;
      const textEl = bubble.querySelector(".wx-bubble-text");
      const text = String((textEl && textEl.textContent) || bubble.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
    });
    if (!lines.length) {
      shellToast("\u6ca1\u6709\u53ef\u590d\u5236\u7684\u6587\u5b57");
      return;
    }
    const ok = await copyCtxText(lines.join("\n"));
    if (ok) exitMultiMode();
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


  function collectForwardables(ids) {
    const box = document.getElementById("chatThread");
    const want = ids ? new Set(ids.map((id) => String(id))) : null;
    const out = [];
    if (!box) return out;
    const skip = {
      image: 1,
      sticker: 1,
      redpacket: 1,
      transfer: 1,
      file: 1,
      music: 1,
    };
    box.querySelectorAll(".wx-row[data-msg-id]").forEach((row) => {
      const id = row.getAttribute("data-msg-id");
      if (want && !want.has(id)) return;
      const kind = row.dataset.kind || "";
      if (skip[kind]) return;
      const bubble = row.querySelector(".bubble");
      if (!bubble || bubble.classList.contains("is-media")) return;
      const textEl = bubble.querySelector(".wx-bubble-text");
      const text = String((textEl && textEl.textContent) || bubble.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      out.push({
        who: row.classList.contains("me") ? "\u4f60" : displayPeerName(),
        text: text,
      });
    });
    return out;
  }
  function mergedForwardBody(items) {
    const title = "\u4f60\u548c" + displayPeerName() + "\u7684\u804a\u5929\u8bb0\u5f55";
    const lines = items.map((it) => it.who + ": " + it.text);
    return title + "\n" + lines.join("\n");
  }
  async function postSilentMessage(body) {
    const res = await fetch("/api/v1/chat/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withPeerBody({ kind: "text", body: body, noreply: true })
      ),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "\u8f6c\u53d1\u5931\u8d25");
    if (data.message) appendChatMessage(data.message);
  }
  async function sendForward(mode) {
    const sheet = document.getElementById("chatFwdSheet");
    const items = (sheet && sheet._fwdItems) || [];
    if (!items.length) {
      shellToast("\u6ca1\u6709\u53ef\u8f6c\u53d1\u7684\u6587\u5b57");
      return;
    }
    closeFwdSheet();
    exitMultiMode();
    try {
      if (mode === "merge") {
        await postChatPayload({ kind: "text", body: mergedForwardBody(items) });
        return;
      }
      for (let i = 0; i < items.length - 1; i++) await postSilentMessage(items[i].text);
      await postChatPayload({
        kind: "text",
        body: items[items.length - 1].text,
        batch: items.map((it) => it.text),
      });
    } catch (err) {
      shellToast((err && err.message) || "\u8f6c\u53d1\u5931\u8d25");
    }
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
      modes.querySelectorAll("[data-scope-mode]").forEach((b) => {
        b.classList.toggle("on", b.getAttribute("data-scope-mode") === (composeDraft.scope || "public"));
      });
    }
  }

  /* ========== Prefs / bg / clear ========== */
  function paintMoodCap(data) {
    const cap = document.getElementById("chatMoodCap");
    const prefLab = document.getElementById("chatPrefMoodLab");
    const label = data && data.label ? String(data.label) : "";
    const core =
      data && data.moodLabel ? String(data.moodLabel) : label;
    const latest = data && data.latest ? String(data.latest) : "";
    const v =
      data && data.valence != null
        ? Math.round(Number(data.valence) * 100) / 100
        : null;
    const a =
      data && data.arousal != null
        ? Math.round(Number(data.arousal) * 100) / 100
        : null;
    const vaTip =
      v != null && a != null ? "V " + v + " · A " + a : "";
    /* title：分层说明，避免「副标别扭、悬停爱你」被当成互相矛盾 */
    const tipParts = [];
    if (label) tipParts.push("现在：" + label);
    if (core && core !== label) tipParts.push("底色：" + core);
    if (latest && latest !== label && latest !== core) {
      tipParts.push("近因：" + latest);
    }
    if (vaTip) tipParts.push(vaTip);
    const tip = tipParts.join(" · ");
    if (prefLab) {
      prefLab.textContent = label
        ? label + (vaTip ? " · " + vaTip : "")
        : "—";
    }
    if (!cap) return;
    cap.classList.remove("is-cold", "is-sour", "is-up");
    if (!label) {
      cap.hidden = true;
      cap.textContent = "";
      cap.removeAttribute("title");
      return;
    }
    cap.hidden = false;
    /* 副标 = publicLabel（综合/新鲜 ambient）；悬停看分层详情 */
    cap.textContent = label;
    if (tip) cap.title = tip;
    else cap.removeAttribute("title");
    if (core === "冷战" || core === "生气" || label === "冷战" || label === "生气")
      cap.classList.add("is-cold");
    else if (
      core === "酸了" ||
      core === "吃醋" ||
      core === "别扭" ||
      label === "别扭"
    )
      cap.classList.add("is-sour");
    else if (
      core === "开心" ||
      core === "兴奋" ||
      label === "开心" ||
      label === "兴奋" ||
      (v != null && v > 0.25)
    )
      cap.classList.add("is-up");
  }
  async function refreshMoodUi() {
    try {
      const res = await fetch("/api/v1/chat/mood?" + peerQuery(), {
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
    paintChatBgLabs();
    await refreshMoodUi();
  }
  function hasCustomChatBg() {
    return !!String(lsGet(LS.bgPick, "") || "").trim();
  }
  function paintChatBgLabs() {
    const custom = hasCustomChatBg();
    const bgLab = document.getElementById("chatPrefBgLab");
    if (bgLab) bgLab.textContent = custom ? "已选相册图" : "从相册选择";
    const clearLab = document.getElementById("chatPrefBgClearLab");
    if (clearLab) clearLab.textContent = custom ? "可恢复" : "已是默认";
    const peerBg = document.getElementById("chatPeerBgVal");
    if (peerBg) peerBg.textContent = custom ? "已选相册图" : "默认";
    const peerClear = document.getElementById("btnChatPeerBgClear");
    if (peerClear) peerClear.hidden = !custom;
    const prefClear = document.getElementById("btnChatBgClear");
    if (prefClear) prefClear.hidden = !custom;
  }
  function clearChatBg() {
    if (!hasCustomChatBg()) {
      shellToast("已是默认背景");
      return;
    }
    lsSet(LS.bgPick, "");
    applyChatBg();
    paintChatBgLabs();
    shellToast("已恢复默认背景");
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
      const res = await fetch("/api/v1/chat/messages?" + peerQuery(), {
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
    const noteInp = document.getElementById("chatNoteInput");
    const nameEl = document.getElementById("chatProfileName");
    const av = document.getElementById("chatProfileAv");
    if (!el) return;
    chatSubReturn = returnTo || null;
    if (nameEl) nameEl.textContent = displayPeerName();
    if (av) av.src = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const avWrap = document.getElementById("chatProfileAvWrap");
    if (avWrap) {
      avWrap.classList.toggle(
        "av-frame-full",
        (activePeerId || "daily") === "daily"
      );
    }
    if (noteInp) noteInp.value = readNote("daily");
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
    const noteInp = document.getElementById("chatNoteInput");
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
      writeNote("daily", String((noteInp && noteInp.value) || ""));
      refreshPeerLabels();
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
    const pid = activePeerId || "daily";
    if (pinVal) pinVal.textContent = readPins().includes(pid) ? "开" : "关";
    if (muteVal) muteVal.textContent = readMutes().includes(pid) ? "开" : "关";
    paintChatBgLabs();
    refreshPeerLabels();
    paintPeerMemCount();
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
    if (act === "mood-map") {
      openMoodMapPage("peer");
      return;
    }
    if (act === "memory-add") {
      addMemoryUi();
      return;
    }
    if (act === "memory-list") {
      openMemoryPage("peer");
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
    if (act === "bg-clear") {
      clearChatBg();
      return;
    }
    if (act === "pin") {
      toggleSessionPin(activePeerId || "daily");
      paintPeerPageLabels();
      return;
    }
    if (act === "mute") {
      toggleSessionMute(activePeerId || "daily").then(() => paintPeerPageLabels());
      return;
    }
  }

  function moodMapStarPath(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = (-Math.PI / 2) + (i * 2 * Math.PI) / 5;
      const b = a + Math.PI / 5;
      pts.push(
        (cx + Math.cos(a) * r).toFixed(1) +
          "," +
          (cy + Math.sin(a) * r).toFixed(1)
      );
      pts.push(
        (cx + Math.cos(b) * r * 0.42).toFixed(1) +
          "," +
          (cy + Math.sin(b) * r * 0.42).toFixed(1)
      );
    }
    return pts.join(" ");
  }

  function paintMoodMap(data) {
    const hint = document.getElementById("chatMoodMapHint");
    const svg = document.getElementById("chatMoodMapSvg");
    const list = document.getElementById("chatMoodMapList");
    const label = data && data.label ? String(data.label) : "—";
    const core = data && data.moodLabel ? String(data.moodLabel) : label;
    const points = Array.isArray(data && data.points) ? data.points : [];
    if (hint) {
      hint.textContent =
        "此刻「" +
        label +
        "」" +
        (core && core !== label ? " · 底色 " + core : "") +
        " · 小宇宙只读";
    }
    if (svg) {
      const pad = 22;
      const W = 280;
      const H = 200;
      const innerW = W - pad * 2;
      const innerH = H - pad * 2;
      const parts = [];
      parts.push(
        '<defs>' +
          '<radialGradient id="mmCandy" cx="35%" cy="30%" r="70%">' +
          '<stop offset="0%" stop-color="#ffd6c9"/>' +
          '<stop offset="100%" stop-color="#e8a090"/>' +
          "</radialGradient>" +
          '<radialGradient id="mmMint" cx="35%" cy="30%" r="70%">' +
          '<stop offset="0%" stop-color="#d8f3ea"/>' +
          '<stop offset="100%" stop-color="#7ec4b0"/>' +
          "</radialGradient>" +
          '<filter id="mmSoft" x="-40%" y="-40%" width="180%" height="180%">' +
          '<feDropShadow dx="0" dy="1.2" stdDeviation="1.4" flood-color="#8b5e4b" flood-opacity="0.18"/>' +
          "</filter>" +
          "</defs>"
      );
      parts.push(
        '<ellipse class="mm-glow" cx="' +
          W / 2 +
          '" cy="' +
          H / 2 +
          '" rx="88" ry="62"/>'
      );
      parts.push(
        '<line class="axis" x1="' +
          pad +
          '" y1="' +
          H / 2 +
          '" x2="' +
          (W - pad) +
          '" y2="' +
          H / 2 +
          '"/>'
      );
      parts.push(
        '<line class="axis" x1="' +
          W / 2 +
          '" y1="' +
          pad +
          '" x2="' +
          W / 2 +
          '" y2="' +
          (H - pad) +
          '"/>'
      );
      parts.push(
        '<circle class="mm-origin" cx="' +
          W / 2 +
          '" cy="' +
          H / 2 +
          '" r="2.5"/>'
      );
      points.slice(0, 36).forEach((p) => {
        const v = Number(p.valence);
        const a = Number(p.arousal);
        if (!Number.isFinite(v) || !Number.isFinite(a)) return;
        const cx = pad + ((v + 1) / 2) * innerW;
        const cy = pad + (1 - a) * innerH;
        const r = 4.2 + Math.min(3.5, (Number(p.importance) || 3) * 0.32);
        const op = Math.max(0.35, Math.min(1, Number(p.w) || 0.55));
        if (p.kind === "ambient") {
          parts.push(
            '<polygon class="dot ambient" points="' +
              moodMapStarPath(cx, cy, r) +
              '" opacity="' +
              op.toFixed(2) +
              '" filter="url(#mmSoft)"/>'
          );
        } else {
          parts.push(
            '<circle class="dot score" cx="' +
              cx.toFixed(1) +
              '" cy="' +
              cy.toFixed(1) +
              '" r="' +
              r.toFixed(1) +
              '" opacity="' +
              op.toFixed(2) +
              '" filter="url(#mmSoft)"/>'
          );
        }
      });
      if (data && data.valence != null && data.arousal != null) {
        const cx = pad + ((Number(data.valence) + 1) / 2) * innerW;
        const cy = pad + (1 - Number(data.arousal)) * innerH;
        parts.push(
          '<circle class="now-halo" cx="' +
            cx.toFixed(1) +
            '" cy="' +
            cy.toFixed(1) +
            '" r="11"/>'
        );
        parts.push(
          '<circle class="now" cx="' +
            cx.toFixed(1) +
            '" cy="' +
            cy.toFixed(1) +
            '" r="6.5" filter="url(#mmSoft)"/>'
        );
        parts.push(
          '<circle class="now-core" cx="' +
            cx.toFixed(1) +
            '" cy="' +
            cy.toFixed(1) +
            '" r="2.2"/>'
        );
      }
      svg.innerHTML = parts.join("");
    }
    if (list) {
      if (!points.length) {
        list.innerHTML =
          '<p class="chat-mood-map-empty">还没有小星星 · 聊几句再来看</p>';
      } else {
        list.innerHTML = points
          .slice(0, 12)
          .map((p) => {
            const lab = String(
              p.label || (p.kind === "ambient" ? "日常" : "情绪")
            ).slice(0, 18);
            const kind = p.kind === "ambient" ? "✦ 饰" : "★ 评";
            const age =
              p.ageH != null
                ? Number(p.ageH) < 1
                  ? "刚刚"
                  : Number(p.ageH) + "h前"
                : "";
            return (
              '<div class="chat-mood-map-row' +
              (p.kind === "ambient" ? " is-ambient" : "") +
              '">' +
              '<span class="k">' +
              kind +
              '</span><span class="t">' +
              lab +
              '</span><span class="m">' +
              (age || "") +
              "</span></div>"
            );
          })
          .join("");
      }
    }
  }

  async function openMoodMapPage(returnTo) {
    chatSubReturn = returnTo || null;
    const el = document.getElementById("chatOvMoodMap");
    if (!el) return;
    if (returnTo === "peer") closePeerPage();
    try {
      const res = await fetch("/api/v1/chat/mood?" + peerQuery(), {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      paintMoodMap(data);
      paintMoodCap(data);
    } catch (err) {
      paintMoodMap({ label: "—", points: [] });
      shellToast((err && err.message) || "读取失败");
    }
    showChatOverlay("chatOvMoodMap");
  }

  function backFromMoodMap() {
    const ret = chatSubReturn;
    chatSubReturn = null;
    const el = document.getElementById("chatOvMoodMap");
    if (el) {
      el.classList.remove("active");
      el.hidden = true;
    }
    if (ret === "peer") {
      openPeerPage();
      return;
    }
    if (ret === "prefs") {
      loadChatPrefsUi();
      openShellOverlay("chatOvPrefs");
      return;
    }
    closeShellOverlays();
  }

  async function addMemoryUi() {
    const text = window.prompt("记一条（只对本会话生效）", "");
    if (text == null) return;
    const content = String(text || "").trim();
    if (!content) {
      shellToast("内容为空");
      return;
    }
    const kwRaw = window.prompt("关键词（逗号分隔，可空）", "") || "";
    try {
      const res = await fetch("/api/v1/chat/memory", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withPeerBody({
            content: content,
            importance: 6,
            category: "日常",
            keywords: kwRaw,
            unresolved: false,
          })
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "写入失败");
      shellToast("已记住");
      paintPeerMemCount();
      const bank = document.getElementById("chatOvMemory");
      if (bank && !bank.hidden) loadMemoryBank();
    } catch (err) {
      shellToast((err && err.message) || "写入失败");
    }
  }

  function paintMemoryBank(list, total) {
    const box = document.getElementById("chatMemoryList");
    const items = Array.isArray(list) ? list : [];
    void total;
    if (!box) return;
    box.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "chat-memory-empty";
      empty.textContent = "还没有记忆 · 点右上角 + 记一条";
      box.append(empty);
      return;
    }
    for (const m of items) {
      const row = document.createElement("div");
      row.className = "chat-memory-row" + (m.unresolved ? " is-open" : "");
      row.dataset.id = m.id;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "chat-memory-pin";
      pin.title = m.unresolved ? "取消待办" : "标为待办";
      pin.textContent = m.unresolved ? "📌" : "○";
      pin.addEventListener("click", (e) => {
        e.preventDefault();
        toggleMemoryUnresolved(m.id);
      });
      const mid = document.createElement("div");
      mid.className = "chat-memory-mid";
      const body = document.createElement("div");
      body.className = "chat-memory-body";
      body.textContent = String(m.content || "");
      body.addEventListener("click", () => editMemoryUi(m));
      const meta = document.createElement("div");
      meta.className = "chat-memory-meta";
      const kws = Array.isArray(m.keywords) ? m.keywords : [];
      meta.textContent =
        (m.category || "日常") +
        " · 重要" +
        (m.importance != null ? m.importance : 5) +
        (kws.length ? " · " + kws.slice(0, 4).join("、") : "");
      mid.append(body, meta);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "chat-memory-del";
      del.setAttribute("aria-label", "删除");
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        deleteMemoryUi(m.id);
      });
      row.append(pin, mid, del);
      box.append(row);
    }
  }

  async function refreshMemoryDigestHint(totalOpt) {
    const hint = document.getElementById("chatMemoryHint");
    if (!hint) return;
    let pending = null;
    try {
      const res = await fetch(
        "/api/v1/chat/memory/digest-status?" + peerQuery(),
        { credentials: "same-origin", cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) pending = Number(data.pending) || 0;
    } catch (_) {}
    const totalBit =
      totalOpt != null ? "本会话 " + totalOpt + " 条" : "本会话记忆";
    hint.textContent =
      totalBit +
      " · 待办优先" +
      (pending != null ? " · 待总结 " + pending + " 条对话" : "");
  }

  async function loadMemoryBank() {
    const qEl = document.getElementById("chatMemoryQ");
    const q = qEl ? String(qEl.value || "").trim() : "";
    try {
      const url =
        "/api/v1/chat/memory?" +
        peerQuery() +
        (q ? "&q=" + encodeURIComponent(q) : "") +
        "&limit=120";
      const res = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      const list = Array.isArray(data.memories) ? data.memories : [];
      const total = data.total != null ? data.total : list.length;
      paintMemoryBank(list, total);
      paintPeerMemCount(total);
      await refreshMemoryDigestHint(total);
    } catch (err) {
      paintMemoryBank([]);
      shellToast((err && err.message) || "读取失败");
    }
  }

  async function runMemoryDigest() {
    const btn = document.getElementById("btnChatMemoryDigest");
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "总结中…";
    }
    try {
      const res = await fetch("/api/v1/chat/memory/digest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withPeerBody({})),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "总结失败");
      const n = Array.isArray(data.added) ? data.added.length : 0;
      shellToast(data.message || (n ? "记入 " + n + " 条" : "完成"));
      await loadMemoryBank();
    } catch (err) {
      shellToast((err && err.message) || "总结失败");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "总结新记忆";
      }
    }
  }

  async function openMemoryPage(returnTo) {
    chatSubReturn = returnTo || null;
    const el = document.getElementById("chatOvMemory");
    if (!el) return;
    if (returnTo === "peer") closePeerPage();
    const qEl = document.getElementById("chatMemoryQ");
    if (qEl) qEl.value = "";
    await loadMemoryBank();
    showChatOverlay("chatOvMemory");
  }

  function backFromMemory() {
    const ret = chatSubReturn;
    chatSubReturn = null;
    const el = document.getElementById("chatOvMemory");
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

  async function editMemoryUi(m) {
    const cur = m || {};
    const text = window.prompt("改记忆正文", String(cur.content || ""));
    if (text == null) return;
    const content = String(text || "").trim();
    if (!content) {
      shellToast("内容为空");
      return;
    }
    const kwRaw = window.prompt(
      "关键词（逗号分隔）",
      (Array.isArray(cur.keywords) ? cur.keywords : []).join(",")
    );
    if (kwRaw == null) return;
    try {
      const res = await fetch(
        "/api/v1/chat/memory/" + encodeURIComponent(cur.id) + "?" + peerQuery(),
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withPeerBody({ content: content, keywords: kwRaw })
          ),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      shellToast("已改");
      await loadMemoryBank();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }

  async function deleteMemoryUi(id) {
    if (!window.confirm("删掉这条记忆？")) return;
    try {
      const res = await fetch(
        "/api/v1/chat/memory/" + encodeURIComponent(id) + "?" + peerQuery(),
        { method: "DELETE", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "删除失败");
      shellToast("已删");
      await loadMemoryBank();
    } catch (err) {
      shellToast((err && err.message) || "删除失败");
    }
  }

  async function toggleMemoryUnresolved(id) {
    try {
      const res = await fetch(
        "/api/v1/chat/memory/" +
          encodeURIComponent(id) +
          "/unresolved?" +
          peerQuery(),
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withPeerBody({})),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "更新失败");
      await loadMemoryBank();
    } catch (err) {
      shellToast((err && err.message) || "更新失败");
    }
  }

  async function paintPeerMemCount(nOpt) {
    const el = document.getElementById("chatPeerMemVal");
    if (!el) return;
    if (nOpt != null) {
      el.textContent = String(nOpt);
      return;
    }
    try {
      const res = await fetch("/api/v1/chat/memory?" + peerQuery(), {
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        el.textContent = "—";
        return;
      }
      el.textContent = Array.isArray(data.memories)
        ? String(data.memories.length)
        : "0";
    } catch (_) {
      el.textContent = "—";
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
  function openSessMenu(sessId) {
    const el = document.getElementById("chatSessMenu");
    if (!el) return;
    menuSessId = String(sessId || activePeerId || "daily");
    const pinBtn = document.getElementById("btnChatSessPin");
    const muteBtn = document.getElementById("btnChatSessMute");
    if (pinBtn) pinBtn.textContent = readPins().includes(menuSessId) ? "取消置顶" : "置顶";
    if (muteBtn) muteBtn.textContent = readMutes().includes(menuSessId) ? "关闭免打扰" : "消息免打扰";
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
  let callTalkRec = null;
  let callTalkChunks = [];
  let callTalkBusy = false;
  let callAudioEl = null;

  function callBubbleLabel(msg) {
    const body = String((msg && msg.body) || "").trim();
    if (body) return body;
    const p = (msg && msg.payload) || {};
    const media = p.media === "video" ? "视频" : "语音";
    const out = p.dir === "out";
    const clock = formatCallClockUi(p.durationSec);
    switch (p.phase) {
      case "invite":
        return out ? "等待对方接听" : "邀请你" + media + "通话";
      case "rejected":
        return "对方已拒绝";
      case "declined":
        return out ? "已取消" : "已拒绝";
      case "answered":
        return out ? "对方已接听" : "已接听";
      case "active":
        return "通话中 " + clock;
      case "ended":
        return Number(p.durationSec) > 0 ? "通话时长 " + clock : media + "通话";
      case "missed":
        return "未接" + media + "通话";
      default:
        return media + "通话";
    }
  }

  function setCallTalkUi(on) {
    const talk = document.getElementById("chatCallTalk");
    const cap = document.getElementById("chatCallCaption");
    const acts = document.getElementById("chatCallActs");
    const answer = document.getElementById("chatCallAnswer");
    const outbound = !!(callSession && callSession.dir === "out");
    if (talk) talk.hidden = !on;
    if (cap) {
      if (!on) {
        cap.hidden = true;
        cap.textContent = "";
      }
    }
    if (acts) acts.classList.toggle("is-active", !!on || outbound);
    /* 拨出从不显示接听；接通后也用 hidden，不单靠 CSS */
    if (answer) answer.hidden = outbound || !!on;
  }

  function speakBrowserTts(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text || ""));
      u.lang = "zh-CN";
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  /** 在用户手势里解锁朗读，避免接通延时后被浏览器静音 */
  function primeSpeechSynth() {
    try {
      if (!window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.lang = "zh-CN";
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  function playCallAudioBase64(b64, contentType) {
    try {
      if (callAudioEl) {
        callAudioEl.pause();
        callAudioEl = null;
      }
      const mime = contentType || "audio/mpeg";
      const src = "data:" + mime + ";base64," + b64;
      const a = new Audio(src);
      callAudioEl = a;
      a.play().catch(() => {});
    } catch (_) {}
  }

  function paintCallCaption(userText, botText) {
    const cap = document.getElementById("chatCallCaption");
    if (!cap) return;
    const u = String(userText || "").trim();
    const b = String(botText || "").trim();
    if (!u && !b) {
      cap.hidden = true;
      cap.textContent = "";
      return;
    }
    cap.hidden = false;
    cap.textContent =
      (u ? "你：" + u.slice(0, 40) : "") +
      (u && b ? "\n" : "") +
      (b ? "家机：" + b.slice(0, 60) : "");
  }

  async function beginCallTalkHold(ev) {
    if (ev) ev.preventDefault();
    if (!callSession || callSession.phase !== "active" || callTalkBusy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      shellToast("无法录音");
      return;
    }
    const talk = document.getElementById("chatCallTalk");
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      callTalkChunks = [];
      callTalkRec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      callTalkRec.ondataavailable = (e) => {
        if (e.data && e.data.size) callTalkChunks.push(e.data);
      };
      callTalkRec.start(200);
      if (talk) {
        talk.classList.add("is-pressing");
        talk.textContent = "松开 发送";
      }
    } catch (_) {
      shellToast("麦克风不可用");
    }
  }

  async function endCallTalkHold(ev) {
    if (ev) ev.preventDefault();
    const talk = document.getElementById("chatCallTalk");
    if (talk) {
      talk.classList.remove("is-pressing");
      talk.textContent = "按住 说话";
    }
    if (!callTalkRec) return;
    const rec = callTalkRec;
    callTalkRec = null;
    await new Promise((resolve) => {
      rec.onstop = resolve;
      try {
        rec.stop();
      } catch (_) {
        resolve();
      }
    });
    try {
      const tracks = rec.stream && rec.stream.getTracks();
      if (tracks) tracks.forEach((t) => t.stop());
    } catch (_) {}
    if (callTalkBusy) return;
    const blob = new Blob(callTalkChunks, {
      type: (rec.mimeType || "audio/webm").split(";")[0],
    });
    callTalkChunks = [];
    if (!blob.size || blob.size < 800) {
      shellToast("太短了");
      return;
    }
    callTalkBusy = true;
    if (talk) talk.disabled = true;
    paintCallCaption("", "听你说…");
    try {
      const res = await fetch("/api/v1/chat/voice-turn?" + peerQuery(), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": blob.type || "audio/webm",
        },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "没接上");
      if (data.skipped) {
        paintCallCaption(data.user_text || "", "（冷战中，先挂了）");
        shellToast("家机不想接");
        return;
      }
      paintCallCaption(data.user_text || "", data.bot_text || "");
      if (data.provider === "fish" && data.audio_base64) {
        playCallAudioBase64(data.audio_base64, data.content_type);
      } else if (data.bot_text) {
        speakBrowserTts(data.bot_text);
        if (data.tts_error) shellToast("Fish 未通，先用系统音");
      }
    } catch (err) {
      paintCallCaption("", "");
      shellToast((err && err.message) || "通话回合失败");
    } finally {
      callTalkBusy = false;
      if (talk) talk.disabled = false;
    }
  }

  function armCallTalkClock(stateEl) {
    if (callTimer) {
      clearTimeout(callTimer);
      clearInterval(callTimer);
    }
    callTimer = setInterval(() => {
      if (!callSession || callSession.phase !== "active") return;
      const sec = Math.floor((Date.now() - callSession.activeAt) / 1000);
      if (stateEl) stateEl.textContent = "通话中 " + formatCallClockUi(sec);
    }, 1000);
  }

  function enterActiveCallUi(stateEl) {
    if (!callSession) return;
    callSession.phase = "active";
    callSession.activeAt = Date.now();
    if (stateEl) stateEl.textContent = "通话中…";
    setCallTalkUi(true);
    armCallTalkClock(stateEl);
    /* 接通先短声提示；之后按住说话才走 ASR→LLM→TTS */
    speakBrowserTts("喂，我在。按住说话就可以了");
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
    callSession = {
      media,
      phase: "invite",
      activeAt: 0,
      started: Date.now(),
      dir: "out",
    };
    if (kindEl) kindEl.textContent = media === "video" ? "视频通话" : "语音通话";
    if (peerEl) peerEl.textContent = displayPeerName();
    if (stateEl) stateEl.textContent = "等待接听…";
    primeSpeechSynth();
    setCallTalkUi(false);
    modal.hidden = false;
    if (callTimer) clearTimeout(callTimer);
    callTimer = setTimeout(() => {
      if (!callSession) return;
      enterActiveCallUi(stateEl);
    }, 900);
    /* ponytail: 挂断时再落一条通话气泡，避免 start 再多一条「等待接听」；有 phase API 后再绑 call id */
  }
  function closeCall() {
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = true;
    setCallTalkUi(false);
    if (callTalkRec) {
      try {
        callTalkRec.stop();
      } catch (_) {}
      callTalkRec = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (callAudioEl) {
      try {
        callAudioEl.pause();
      } catch (_) {}
      callAudioEl = null;
    }
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
    const dir = (callSession && callSession.dir) || "out";
    callSession = null;
    postChatPayload({
      kind: "call",
      media: media,
      dir: dir,
      phase: dur > 0 ? "ended" : "declined",
      durationSec: dur,
    }).catch(() => {});
  }
  function answerCallSession() {
    if (!callSession || callSession.dir === "out") return;
    if (callSession.phase !== "invite") return;
    enterActiveCallUi(document.getElementById("chatCallState"));
  }
  function voiceBubbleSec(p) {
    const src = p || {};
    const ms = Number(src.durationMs);
    if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.round(ms / 1000));
    const sec = Number(src.duration != null ? src.duration : src.sec);
    if (Number.isFinite(sec) && sec > 0) return Math.max(1, Math.round(sec));
    return 1;
  }
  function voiceHoldMs(started, now) {
    if (!started) return 1000;
    const ms = Math.floor(Number(now) - Number(started));
    if (!Number.isFinite(ms) || ms < 1000) return 1000;
    if (ms > 120000) return 120000;
    return ms;
  }
  function voicePlaySrc(payload, body) {
    const p = payload || {};
    const raw = String(p.url || body || "").trim();
    if (/^(https?:|blob:|\/)/i.test(raw)) return raw;
    return "";
  }
  (function checkVoiceHold() {
    if (voiceBubbleSec({ durationMs: 2400 }) !== 2) throw new Error("ms");
    if (voiceBubbleSec({ durationMs: 400 }) !== 1) throw new Error("short ms");
    if (voiceBubbleSec({ duration: 5 }) !== 5) throw new Error("legacy sec");
    if (voiceBubbleSec({ durationMs: 0, sec: 3 }) !== 3) throw new Error("zero ms");
    if (voiceBubbleSec({}) !== 1) throw new Error("empty");
    if (voiceHoldMs(1000, 3400) !== 2400) throw new Error("hold");
    if (voiceHoldMs(0, 999999) !== 1000) throw new Error("no start");
    if (voiceHoldMs(1, 130000) !== 120000) throw new Error("cap");
    if (voicePlaySrc({}, "/api/v1/chat/media/a") !== "/api/v1/chat/media/a") throw new Error("body");
    if (voicePlaySrc({}, "memo") !== "") throw new Error("plain");
    if (
      callBubbleLabel({
        body: "",
        payload: { media: "voice", dir: "out", phase: "declined", durationSec: 0 },
      }) !== "已取消"
    )
      throw new Error("call declined");
    if (
      callBubbleLabel({
        body: "",
        payload: { media: "voice", dir: "out", phase: "ended", durationSec: 7 },
      }) !== "通话时长 00:07"
    )
      throw new Error("call ended");
  })();
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
    voiceHoldStarted = 0;
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
      voiceHoldStarted = Date.now();
    } catch (_) {
      voiceRec = null;
    }
  }
  async function endVoiceHold() {
    const durationMs = voiceHoldMs(voiceHoldStarted, Date.now());
    voiceHoldStarted = 0;
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
      await postChatPayload({
        kind: "voice",
        body: data.url,
        durationMs: durationMs,
      });
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
          body: JSON.stringify(withPeerBody({})),
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


  function bindShell() {
    document.querySelectorAll("#view-chat .chat-dock [data-chat-go]").forEach((b) => {
      b.addEventListener("click", () => goChatTab(b.getAttribute("data-chat-go")));
    });
    const home = document.getElementById("btnChatShellHome");
    if (home) home.addEventListener("click", () => deps.showView("home"));
    const add = document.getElementById("btnChatShellAdd");
    if (add) {
      add.addEventListener("click", () =>
        shellToast("已有家机 + 薄巧测试两条会话")
      );
    }
    const contact = document.getElementById("btnChatContactHome");
    if (contact) {
      contact.addEventListener("click", () => {
        setActivePeer("daily");
        openPeerPage();
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
        const on = document.querySelector("#chatScopeModes .on[data-scope-mode]");
        composeDraft.scope = (on && on.getAttribute("data-scope-mode")) || "public";
        paintComposeDraft();
        closeScopeSheet();
      });
    }
    const scopeModes = document.getElementById("chatScopeModes");
    if (scopeModes) {
      scopeModes.addEventListener("click", (e) => {
        const b = e.target.closest("[data-scope-mode]");
        if (!b) return;
        scopeModes.querySelectorAll("[data-scope-mode]").forEach((x) => x.classList.remove("on"));
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
    const moodMapPrefs = document.getElementById("btnChatMoodMapPrefs");
    if (moodMapPrefs) {
      moodMapPrefs.addEventListener("click", () => openMoodMapPage("prefs"));
    }
    const moodMapBack = document.getElementById("btnChatMoodMapBack");
    if (moodMapBack) moodMapBack.addEventListener("click", () => backFromMoodMap());
    const memoryBack = document.getElementById("btnChatMemoryBack");
    if (memoryBack) memoryBack.addEventListener("click", () => backFromMemory());
    const memoryAdd = document.getElementById("btnChatMemoryAdd");
    if (memoryAdd) memoryAdd.addEventListener("click", () => addMemoryUi());
    const memoryDigest = document.getElementById("btnChatMemoryDigest");
    if (memoryDigest) {
      memoryDigest.addEventListener("click", () => runMemoryDigest());
    }
    const memoryQ = document.getElementById("chatMemoryQ");
    if (memoryQ) {
      let memTimer = null;
      memoryQ.addEventListener("input", () => {
        if (memTimer) clearTimeout(memTimer);
        memTimer = setTimeout(() => loadMemoryBank(), 220);
      });
    }
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
    const btnBgClear = document.getElementById("btnChatBgClear");
    if (btnBgClear) btnBgClear.addEventListener("click", () => clearChatBg());
    const bgInp = document.getElementById("chatBgInput");
    if (bgInp) {
      bgInp.addEventListener("change", () => {
        const f = bgInp.files && bgInp.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          lsSet(LS.bgPick, String(reader.result || ""));
          applyChatBg();
          paintChatBgLabs();
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
        toggleSessionPin(menuSessId);
        closeSessMenu();
      });
    }
    const sessMute = document.getElementById("btnChatSessMute");
    if (sessMute) {
      sessMute.addEventListener("click", () => {
        toggleSessionMute(menuSessId);
        closeSessMenu();
      });
    }
    const sessUnread = document.getElementById("btnChatSessUnread");
    if (sessUnread) {
      sessUnread.addEventListener("click", () => {
        const marks = readUnreadMarks();
        marks[menuSessId || "daily"] = true;
        writeUnreadMarks(marks);
        refreshSessionList();
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
    const fwdEach = document.getElementById("btnChatFwdEach");
    if (fwdEach) fwdEach.addEventListener("click", () => sendForward("each"));
    const fwdMerge = document.getElementById("btnChatFwdMerge");
    if (fwdMerge) fwdMerge.addEventListener("click", () => sendForward("merge"));
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
    /* H1.84：大图开着时 ←/→ 翻页、Esc 关闭；关着不抢输入 */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const song = document.getElementById("chatSongModal");
        if (song && !song.hidden) {
          e.preventDefault();
          closeChatSongModal();
          return;
        }
      }
      const view = document.getElementById("chatPicView");
      if (!view || view.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closePicViewer();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPic(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepPic(1);
      }
    });
    const rpScrim = document.getElementById("chatRpScrim");
    if (rpScrim) rpScrim.addEventListener("click", () => closeRedpacketView());
    const rpOpen = document.getElementById("chatRpOpen");
    if (rpOpen) rpOpen.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRedpacketClaim();
    });
    const rpDone = document.getElementById("chatRpDone");
    if (rpDone) rpDone.addEventListener("click", () => closeRedpacketView());
    const locScrim = document.getElementById("chatLocScrim");
    if (locScrim) locScrim.addEventListener("click", closeLocView);
    const locClose = document.getElementById("chatLocClose");
    if (locClose) locClose.addEventListener("click", closeLocView);
    const locCopy = document.getElementById("chatLocCopy");
    if (locCopy) {
      locCopy.addEventListener("click", async () => {
        if (!locViewCopy) return;
        const ok = await copyCtxText(locViewCopy);
        if (ok) shellToast("已复制");
      });
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    bindShell();
    const back = document.getElementById("btnChatBack");
    if (back) {
      back.addEventListener("click", () => {
        const song = document.getElementById("chatSongModal");
        if (song && !song.hidden) {
          closeChatSongModal();
          return;
        }
        const rp = document.getElementById("chatRpView");
        if (rp && !rp.hidden) {
          closeRedpacketView();
          return;
        }
        const loc = document.getElementById("chatLocView");
        if (loc && !loc.hidden) {
          closeLocView();
          return;
        }
        const pic = document.getElementById("chatPicView");
        if (pic && !pic.hidden) {
          closePicViewer();
          return;
        }
        closeThreadLayer();
      });
    }
    const more = document.getElementById("btnChatPeerMore");
    if (more) more.addEventListener("click", () => openPeerPage());
    const quoteClear = document.getElementById("btnChatQuoteClear");
    if (quoteClear) quoteClear.addEventListener("click", () => clearPendingQuote());
    const newMsg = document.getElementById("chatNewMsg");
    if (newMsg) {
      newMsg.addEventListener("click", () => {
        scrollToLatest();
        setNewMsgChip(0);
      });
    }
    const thread = document.getElementById("chatThread");
    if (thread) {
      thread.addEventListener(
        "scroll",
        () => {
          nearBottom = threadNearBottom();
          if (nearBottom) setNewMsgChip(0);
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
    const chatErrEl = document.getElementById("chatErr");
    if (chatErrEl) {
      chatErrEl.addEventListener("click", () => setChatErr(""));
    }
    const songForm = document.getElementById("chatSongForm");
    if (songForm) {
      songForm.addEventListener("submit", onChatSongSearchSubmit);
    }
    const songClose = document.getElementById("chatSongModalClose");
    if (songClose) songClose.addEventListener("click", closeChatSongModal);
    const songModal = document.getElementById("chatSongModal");
    if (songModal) {
      songModal.addEventListener("click", (e) => {
        if (e.target === songModal) closeChatSongModal();
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
        closeChatSongModal();
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
    const voiceBtn = document.getElementById("btnChatVoice");
    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => setVoiceMode(!voiceMode));
    }
    const plus = document.getElementById("btnChatPlus");
    if (plus) plus.addEventListener("click", () => togglePlusPanel());
    const hang = document.getElementById("chatCallHang");
    if (hang) hang.addEventListener("click", closeCall);
    const answer = document.getElementById("chatCallAnswer");
    if (answer) answer.addEventListener("click", answerCallSession);
    const callTalk = document.getElementById("chatCallTalk");
    if (callTalk) {
      callTalk.addEventListener("pointerdown", beginCallTalkHold);
      callTalk.addEventListener("pointerup", endCallTalkHold);
      callTalk.addEventListener("pointercancel", endCallTalkHold);
      callTalk.addEventListener("pointerleave", (e) => {
        if (callTalk.classList.contains("is-pressing")) endCallTalkHold(e);
      });
    }
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
        if (img.files && img.files.length) sendPickedImages(img.files);
        img.value = "";
      });
    }
    const cam = document.getElementById("chatCameraInput");
    if (cam) {
      cam.addEventListener("change", () => {
        const f = cam.files && cam.files[0];
        if (f) sendPickedImage(f);
        cam.value = "";
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
    const balGo = document.getElementById("chatSheetBalGo");
    if (balGo) {
      balGo.addEventListener("click", () => {
        closeSheet();
        try {
          deps.showView("wallet");
        } catch (_) {
          shellToast("打不开资产");
        }
      });
    }
    const multiDel = document.getElementById("chatMultiDel");
    if (multiDel) multiDel.addEventListener("click", () => multiDeleteUi());
    const multiCopy = document.getElementById("chatMultiCopy");
    if (multiCopy) multiCopy.addEventListener("click", () => multiCopyUi());
    const multiFwd = document.getElementById("chatMultiFwd");
    if (multiFwd) {
      multiFwd.addEventListener("click", () => {
        const items = collectForwardables(Array.from(multiIds));
        if (!items.length) {
          shellToast("\u6ca1\u6709\u53ef\u8f6c\u53d1\u7684\u6587\u5b57");
          return;
        }
        openFwdSheet(items);
      });
    }
    syncSendPlus();
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    try {
      const saved = String(localStorage.getItem(LS.activePeer) || "").trim();
      if (saved) activePeerId = saved;
    } catch (_) {}
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
