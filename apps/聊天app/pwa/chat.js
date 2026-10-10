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
  };

  let bound = false;

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

  async function refreshChatThread() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    const peer = document.getElementById("chatPeerName");
    if (peer) peer.textContent = deps.getPeerName() || "家机";
    box.replaceChildren();
    try {
      const msgs = await fetchChatMessages();
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "wx-empty";
        empty.textContent = "还没有短讯。正剧请去 Chatbox。";
        box.append(empty);
        return;
      }
      let lastBucket = 0;
      const youAv = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
      const botAv = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
      for (const m of msgs) {
        const bucket = Math.floor((Number(m.ts) || 0) / 300000);
        if (bucket !== lastBucket) {
          lastBucket = bucket;
          const t = document.createElement("div");
          t.className = "wx-time";
          t.textContent = chatTimeLabel(m.ts);
          box.append(t);
        }
        const row = document.createElement("div");
        row.className = "wx-row " + (m.from === "you" ? "me" : "them");
        const av = document.createElement("div");
        av.className = "av";
        const avImg = document.createElement("img");
        avImg.alt = "";
        avImg.src = m.from === "you" ? youAv : botAv;
        av.append(avImg);
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = m.body || "";
        row.append(av, bubble);
        box.append(row);
      }
      box.scrollTop = box.scrollHeight;
      setChatErr("");
    } catch (e) {
      const empty = document.createElement("div");
      empty.className = "wx-empty";
      empty.textContent = (e && e.message) || "聊天加载失败";
      box.append(empty);
    }
  }

  function appendChatBubble(from, text) {
    const box = document.getElementById("chatThread");
    if (!box) return null;
    const empty = box.querySelector(".wx-empty");
    if (empty) empty.remove();
    const youAv = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const botAv = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const row = document.createElement("div");
    row.className = "wx-row " + (from === "you" ? "me" : "them");
    const av = document.createElement("div");
    av.className = "av";
    const avImg = document.createElement("img");
    avImg.alt = "";
    avImg.src = from === "you" ? youAv : botAv;
    av.append(avImg);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    row.append(av, bubble);
    box.append(row);
    box.scrollTop = box.scrollHeight;
    return bubble;
  }

  async function sendChatMessage() {
    const input = document.getElementById("dailyChatInput");
    const btn = document.getElementById("btnChatSend");
    const box = document.getElementById("chatThread");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (btn) btn.disabled = true;
    if (input) input.disabled = true;
    setChatErr("");
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
        body: JSON.stringify({ body: body }),
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
      if (input) input.value = "";
      if (!res.body || !res.body.getReader) {
        throw new Error("浏览器不支持流式读取");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      const handleEvent = async (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === "you" && ev.message) {
          appendChatBubble("you", ev.message.body || "");
          await paintFrame();
        } else if (ev.type === "bot_start") {
          botBubble = appendChatBubble("bot", "");
          await paintFrame();
        } else if (ev.type === "bot_delta" && ev.text) {
          if (!botBubble) botBubble = appendChatBubble("bot", "");
          if (botBubble) {
            botBubble.textContent = (botBubble.textContent || "") + ev.text;
            if (box) box.scrollTop = box.scrollHeight;
          }
          await paintFrame();
        } else if (ev.type === "bot_done" && ev.message) {
          if (botBubble) {
            botBubble.textContent = ev.message.body || botBubble.textContent || "";
          }
          botBubble = null;
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
    } catch (e) {
      setChatErr((e && e.message) || "发送失败");
    } finally {
      if (btn) btn.disabled = false;
      if (input) {
        input.disabled = false;
        input.focus();
      }
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
