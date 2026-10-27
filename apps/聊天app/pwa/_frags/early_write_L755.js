/**
 * 日常聊天 App 前端（≠ 共读短聊 / 共看吐槽）。
 * DOM 由壳注入 view.html；真源本文件。发送强制 SSE 边出边画。
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

  async function fetchStickers() {
    if (stickerCache) return stickerCache;
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
    } catch (_) {
      /* 角标稍后刷新即可 */
    }
    try {
      deps.onUnreadChange();
    } catch (_) {}
  }

  function notifyUnread() {
    try {
      deps.onUnreadChange();
    } catch (_) {}
  }

  function fillBubble(bubble, msg) {
    bubble.replaceChildren();
    bubble.classList.remove("is-media");
    const kind = msg && msg.kind === "sticker" ? "sticker" : msg && msg.kind === "image" ? "image" : "text";
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
      } catch (_) {
        /* 贴纸包失败仍可画文字/已落库图 */
      }
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
    const btn = document.getElementById("btnChatSend");
    const input = document.getElementById("dailyChatInput");
    const stick = document.getElementById("btnChatSticker");
    const imgBtn = document.getElementById("btnChatImage");
    if (btn) btn.disabled = sending;
    if (input) input.disabled = sending;
    if (stick) stick.disabled = sending;
    if (imgBtn) imgBtn.disabled = sending;
  }

  async function postChatPayload(payload) {
    const box = document.getElementById("chatThread");
    setChatErr("");
    setComposerBusy(true);
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
          if (botBubble) {
            fillBubble(botBubble, ev.message);
          }
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
    await postChatPayload({ kind: "text", body: body });
  }

  async function sendSticker(id) {
    if (sending || !id) return;
    setStickerPanel(false);
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
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
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

  function setStickerPanel(open) {
    const panel = document.getElementById("chatStickerPanel");
    const btn = document.getElementById("btnChatSticker");
    if (!panel) return;
    panel.hidden = !open;
    if (btn) btn.setAttribute("aria-pressed", open ? "true" : "false");
  }

  async function toggleStickerPanel() {
    const panel = document.getElementById("chatStickerPanel");
    if (!panel) return;
    if (!panel.hidden) {
      setStickerPanel(false);
      return;
    }
    try {
      const pack = await fetchStickers();
      panel.replaceChildren();
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
      setStickerPanel(true);
    } catch (e) {
      setChatErr((e && e.message) || "贴纸包加载失败");
    }
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
    const stick = document.getElementById("btnChatSticker");
    if (stick) stick.addEventListener("click", () => toggleStickerPanel());
    const imgBtn = document.getElementById("btnChatImage");
    const file = document.getElementById("chatImageInput");
    if (imgBtn && file) {
      imgBtn.addEventListener("click", () => {
        setStickerPanel(false);
        file.value = "";
        file.click();
      });
      file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        if (f) sendPickedImage(f);
      });
    }
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
