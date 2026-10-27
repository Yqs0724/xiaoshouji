/**
 * 日常聊天 App 前端（≠ 共读短聊 / 共看吐槽）。
 * 微信底栏：语音占位 | 输入 | 表情 | +/发送；加号与表情面板互斥。
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

  const PLUS_ITEMS = [
    { id: "album", lab: "相册", tile: "相册", ok: true },
    { id: "camera", lab: "拍摄", tile: "拍摄", ok: true },
    { id: "location", lab: "位置", tile: "位置", ok: true },
    { id: "voicein", lab: "语音输入", tile: "语音", ok: false },
    { id: "redpacket", lab: "红包", tile: "红包", ok: true },
    { id: "transfer", lab: "转账", tile: "转账", ok: true },
    { id: "fav", lab: "收藏", tile: "收藏", ok: false },
    { id: "card", lab: "名片", tile: "名片", ok: false },
    { id: "file", lab: "文件", tile: "文件", ok: false },
    { id: "music", lab: "音乐", tile: "音乐", ok: false },
  ];

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

  function setChatErr(text) {
    const el = document.getElementById("chatErr");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  async function fetchChatMessages() {
    const res = await fetch("/api/v1/chat/messages", { credentials: "same-origin" });
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
    try {
      await fetch("/api/v1/chat/read", {
        method: "POST",
        credentials: "same-origin",
      });
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

  function fillBubble(bubble, msg) {
    bubble.replaceChildren();
    bubble.classList.remove("is-media", "is-card");
    const kind = (msg && msg.kind) || "text";
    if (kind === "sticker") {
      bubble.classList.add("is-media");
      const img = document.createElement("img");
      img.className = "sticker";
      img.alt = "贴纸";
      img.src = stickerSrc(msg.body) || "";
      bubble.append(img);
      return;
    }
    if (kind === "image") {
      bubble.classList.add("is-media");
      const img = document.createElement("img");
      img.className = "chat-pic";
      img.alt = "图片";
      img.src = msg.body || "";
      bubble.append(img);
      return;
    }
    if (kind === "redpacket" || kind === "transfer") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-money-card";
      const amt = document.createElement("div");
      amt.className = "amt";
      amt.textContent = moneyText(p.amount);
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = p.note || (kind === "redpacket" ? "恭喜发财" : "转账");
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = kind === "redpacket" ? "微信红包" : "转账";
      card.append(amt, note, tag);
      bubble.append(card);
      return;
    }
    if (kind === "location") {
      bubble.classList.add("is-card");
      const p = msg.payload || {};
      const card = document.createElement("div");
      card.className = "wx-loc-card";
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
      bubble.append(card);
      return;
    }
    bubble.textContent = (msg && msg.body) || "";
  }

  function appendChatMessage(msg) {
    const box = document.getElementById("chatThread");
    if (!box || !msg) return null;
    const empty = box.querySelector(".wx-empty");
    if (empty) empty.remove();
    appendTimeChip(msg.ts != null ? msg.ts : Date.now());
    const youAv = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const botAv = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const row = document.createElement("div");
    row.className = "wx-row " + (msg.from === "you" ? "me" : "them");
    const av = document.createElement("div");
    av.className = "av";
    const avImg = document.createElement("img");
    avImg.alt = "";
    avImg.src = msg.from === "you" ? youAv : botAv;
    av.append(avImg);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    fillBubble(bubble, msg);
    row.append(av, bubble);
    box.append(row);
    box.scrollTop = box.scrollHeight;
    return bubble;
  }

  function appendChatBubble(from, text, ts) {
    return appendChatMessage({
      from: from,
      kind: "text",
      body: text || "",
      ts: ts != null ? ts : Date.now(),
    });
  }

  function syncSendPlus() {
    const input = document.getElementById("dailyChatInput");
    const send = document.getElementById("btnChatSend");
    const plus = document.getElementById("btnChatPlus");
    const has = !!(input && String(input.value || "").trim());
    if (send) send.hidden = !has;
    if (plus) plus.hidden = has;
  }

  function setPanels(which) {
    const stick = document.getElementById("chatStickerPanel");
    const plus = document.getElementById("chatPlusPanel");
    const stickBtn = document.getElementById("btnChatSticker");
    const plusBtn = document.getElementById("btnChatPlus");
    if (stick) stick.hidden = which !== "sticker";
    if (plus) plus.hidden = which !== "plus";
    if (stickBtn) stickBtn.setAttribute("aria-pressed", which === "sticker" ? "true" : "false");
    if (plusBtn) plusBtn.setAttribute("aria-pressed", which === "plus" ? "true" : "false");
  }

  async function refreshChatThread() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    const peer = document.getElementById("chatPeerName");
    if (peer) peer.textContent = deps.getPeerName() || "家机";
    await markChatRead();
    box.replaceChildren();
    lastTimeBucket = -1;
    try {
      try {
        await fetchStickers();
      } catch (_) {}
      const msgs = await fetchChatMessages();
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "wx-empty";
        empty.textContent = "还没有短讯。正剧请去 Chatbox。";
        box.append(empty);
        return;
      }
      for (const m of msgs) appendChatMessage(m);
      box.scrollTop = box.scrollHeight;
      setChatErr("");
    } catch (e) {
      const empty = document.createElement("div");
      empty.className = "wx-empty";
      empty.textContent = (e && e.message) || "聊天加载失败";
      box.append(empty);
    }
  }

  function setComposerBusy(busy) {
    sending = !!busy;
    ["btnChatSend", "btnChatPlus", "btnChatSticker", "btnChatVoice", "dailyChatInput"].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = sending;
      }
    );
  }

  async function postChatPayload(payload) {
    const box = document.getElementById("chatThread");
    setChatErr("");
    setComposerBusy(true);
    setPanels(null);
    let botBubble = null;
    const paintFrame = () =>
      new Promise((r) => requestAnimationFrame(() => r()));
    try {
      const res = await fetch("/api/v1/chat/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
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
      if (!res.body || !res.body.getReader) {
        throw new Error("浏览器不支持流式读取");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      const handleEvent = async (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === "you" && ev.message) {
          appendChatMessage(ev.message);
          await paintFrame();
        } else if (ev.type === "bot_start") {
          botBubble = appendChatBubble("bot", "", Date.now());
          await paintFrame();
        } else if (ev.type === "bot_delta" && ev.text) {
          if (!botBubble) botBubble = appendChatBubble("bot", "", Date.now());
          if (botBubble) {
            botBubble.textContent = (botBubble.textContent || "") + ev.text;
            if (box) box.scrollTop = box.scrollHeight;
          }
          await paintFrame();
        } else if (ev.type === "bot_done" && ev.message) {
          if (botBubble) fillBubble(botBubble, ev.message);
          botBubble = null;
        } else if (ev.type === "bot_sticker" && ev.message) {
          appendChatMessage(ev.message);
          await paintFrame();
        } else if (ev.type === "bot_error") {
          if (botBubble && !(botBubble.textContent || "").trim()) {
            const row = botBubble.closest(".wx-row");
            if (row) row.remove();
          }
          botBubble = null;
          if (ev.code === "wallet_insufficient") setChatErr("余额不足");
        } else if (ev.type === "done") {
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
      if (chatViewActive()) await markChatRead();
      else notifyUnread();
    } catch (e) {
      setChatErr((e && e.message) || "发送失败");
    } finally {
      setComposerBusy(false);
      syncSendPlus();
      const input = document.getElementById("dailyChatInput");
      if (input) input.focus();
    }
  }

  async function sendChatMessage() {
    if (sending) return;
    const input = document.getElementById("dailyChatInput");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (input) input.value = "";
    syncSendPlus();
    await postChatPayload({ kind: "text", body: body });
  }

  async function sendSticker(id) {
    if (sending || !id) return;
    await postChatPayload({ kind: "sticker", body: id });
  }

  async function sendPickedImage(file) {
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
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || data.error || "上传失败");
      if (!data.url) throw new Error("上传失败");
      setComposerBusy(false);
      await postChatPayload({ kind: "image", body: data.url });
    } catch (e) {
      setChatErr((e && e.message) || "上传失败");
      setComposerBusy(false);
    }
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
    if (!panel || panel.dataset.ready === "1") return;
    panel.replaceChildren();
    for (const item of PLUS_ITEMS) {
      const b = document.createElement("button");
      b.type = "button";
      const tile = document.createElement("span");
      tile.className = "tile";
      tile.textContent = item.tile;
      const lab = document.createElement("span");
      lab.textContent = item.lab;
      b.append(tile, lab);
      b.addEventListener("click", () => onPlusItem(item));
      panel.append(b);
    }
    panel.dataset.ready = "1";
  }

  function openSheet(mode) {
    sheetMode = mode;
    const sheet = document.getElementById("chatSheet");
    const title = document.getElementById("chatSheetTitle");
    const aw = document.getElementById("chatSheetAmountWrap");
    const nw = document.getElementById("chatSheetNoteWrap");
    const nameW = document.getElementById("chatSheetNameWrap");
    const detailW = document.getElementById("chatSheetDetailWrap");
    const noteLab = document.getElementById("chatSheetNoteLab");
    const amount = document.getElementById("chatSheetAmount");
    const note = document.getElementById("chatSheetNote");
    const name = document.getElementById("chatSheetName");
    const detail = document.getElementById("chatSheetDetail");
    if (!sheet) return;
    if (aw) aw.hidden = mode !== "redpacket" && mode !== "transfer";
    if (nw) nw.hidden = mode !== "redpacket" && mode !== "transfer";
    if (nameW) nameW.hidden = mode !== "location";
    if (detailW) detailW.hidden = mode !== "location";
    if (title) {
      title.textContent =
        mode === "redpacket" ? "发红包" : mode === "transfer" ? "转账" : "发送位置";
    }
    if (noteLab) noteLab.textContent = mode === "redpacket" ? "祝福" : "备注";
    if (amount) amount.value = "";
    if (note) note.value = mode === "redpacket" ? "恭喜发财" : "";
    if (name) name.value = "";
    if (detail) detail.value = "";
    sheet.hidden = false;
    setPanels(null);
  }

  function closeSheet() {
    const sheet = document.getElementById("chatSheet");
    if (sheet) sheet.hidden = true;
    sheetMode = "";
  }

  async function confirmSheet() {
    if (sheetMode === "redpacket" || sheetMode === "transfer") {
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
      closeSheet();
      await postChatPayload({
        kind: sheetMode === "redpacket" ? "redpacket" : "transfer",
        amount: amount,
        note: note,
      });
      return;
    }
    if (sheetMode === "location") {
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
    if (!item.ok) {
      setChatErr(item.lab + "未开");
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

  function bind() {
    if (bound) return;
    bound = true;
    const back = document.getElementById("btnChatBack");
    if (back) back.addEventListener("click", () => deps.showView("home"));
    const form = document.getElementById("chatForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendChatMessage();
      });
    }
    const input = document.getElementById("dailyChatInput");
    if (input) {
      input.addEventListener("input", syncSendPlus);
      input.addEventListener("focus", () => setPanels(null));
    }
    const stick = document.getElementById("btnChatSticker");
    if (stick) stick.addEventListener("click", () => toggleStickerPanel());
    const plus = document.getElementById("btnChatPlus");
    if (plus) plus.addEventListener("click", () => togglePlusPanel());
    const voice = document.getElementById("btnChatVoice");
    if (voice) {
      voice.addEventListener("click", () => {
        setChatErr("语音未开");
        setPanels(null);
      });
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
    syncSendPlus();
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  global.ChatApp = {
    mount: mount,
    refreshThread: refreshChatThread,
  };
})(typeof window !== "undefined" ? window : globalThis);
