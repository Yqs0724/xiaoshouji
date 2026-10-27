  function formatCallClockUi(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }

  function clearCallTimers() {
    if (!callSession) return;
    if (callSession.tick) {
      clearInterval(callSession.tick);
      callSession.tick = null;
    }
    if (callSession.autoAnswer) {
      clearTimeout(callSession.autoAnswer);
      callSession.autoAnswer = null;
    }
  }

  function syncCallModal() {
    const modal = document.getElementById("chatCallModal");
    const kindEl = document.getElementById("chatCallKind");
    const peerEl = document.getElementById("chatCallPeer");
    const stateEl = document.getElementById("chatCallState");
    const acts = document.getElementById("chatCallActs");
    if (!callSession || !modal) return;
    const media = callSession.media === "video" ? "video" : "voice";
    const lab = media === "video" ? "视频通话" : "语音通话";
    const peer = deps.getPeerName() || "家机";
    if (kindEl) kindEl.textContent = lab;
    if (peerEl) peerEl.textContent = peer;
    const phase = callSession.phase;
    if (acts) acts.classList.toggle("is-active", phase === "active" || phase === "answered");
    if (stateEl) {
      if (phase === "invite") stateEl.textContent = "邀请你" + lab;
      else if (phase === "answered") stateEl.textContent = "已接听";
      else if (phase === "active") {
        const sec = Math.floor((Date.now() - callSession.activeAt) / 1000);
        stateEl.textContent = "通话中 " + formatCallClockUi(sec);
      } else stateEl.textContent = lab;
    }
  }

  async function patchCallPhase(phase, durationSec) {
    if (!callSession || !callSession.id) return null;
    const res = await fetch(
      "/api/v1/chat/call/" + encodeURIComponent(callSession.id) + "/phase",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          durationSec: durationSec != null ? durationSec : undefined,
        }),
      }
    );
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) throw new Error(data.message || data.error || "通话更新失败");
    if (data.message) {
      callSession.phase = (data.message.payload && data.message.payload.phase) || phase;
      patchMessageBubble(data.message);
    }
    return data.message || null;
  }

  async function consumeCallFinishSse(res) {
    if (!res.body || !res.body.getReader) throw new Error("浏览器不支持流式读取");
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let botBubble = null;
    const paintFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const handleEvent = async (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === "call" && ev.message) {
        patchMessageBubble(ev.message);
        await paintFrame();
      } else if (ev.type === "bot_start") {
        pendingThink = { sec: 0, text: "" };
        thinkAttached = false;
        setTyping(true);
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
          const box = document.getElementById("chatThread");
          if (box) box.scrollTop = box.scrollHeight;
        }
      } else if (ev.type === "bot_done" && ev.message) {
        if (botBubble) {
          fillBubble(botBubble, ev.message);
          ensureBunnyThink(botBubble, ev.message);
        } else {
          thinkAttached = true;
          appendChatMessage(ev.message);
        }
        botBubble = null;
        setTyping(false);
      } else if (ev.type === "bot_money" && ev.message) {
        appendChatMessage(ev.message);
      } else if (ev.type === "bot_sticker" && ev.message) {
        appendChatMessage(ev.message);
      } else if (ev.type === "bot_error") {
        setTyping(false);
        if (ev.message) shellToast(ev.message);
      } else if (ev.type === "done") {
        setTyping(false);
      }
      await paintFrame();
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const chunk of parts) {
        const lines = chunk.split("\n");
        let dataLine = "";
        for (const line of lines) {
          if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          await handleEvent(JSON.parse(dataLine));
        } catch (_) {}
      }
    }
  }

  async function finishCallRemote(phase, durationSec) {
    if (!callSession || !callSession.id) return;
    const id = callSession.id;
    const res = await fetch(
      "/api/v1/chat/call/" + encodeURIComponent(id) + "/finish",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ phase, durationSec }),
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
      throw new Error(data.message || data.error || "结束通话失败");
    }
    await consumeCallFinishSse(res);
  }

  function startCallTicker() {
    if (!callSession) return;
    if (callSession.tick) clearInterval(callSession.tick);
    callSession.tick = setInterval(() => {
      if (!callSession || callSession.phase !== "active") return;
      const sec = Math.floor((Date.now() - callSession.activeAt) / 1000);
      syncCallModal();
      const row = document.querySelector(
        '.wx-row[data-msg-id="' + callSession.id + '"] .wx-call-txt'
      );
      if (row) row.textContent = "通话中 " + formatCallClockUi(sec);
    }, 1000);
  }

  async function answerCallSession() {
    if (!callSession || callSession.phase !== "invite") return;
    if (callSession.autoAnswer) {
      clearTimeout(callSession.autoAnswer);
      callSession.autoAnswer = null;
    }
    try {
      await patchCallPhase("answered", 0);
      syncCallModal();
      await new Promise((r) => setTimeout(r, 380));
      if (!callSession) return;
      callSession.activeAt = Date.now();
      await patchCallPhase("active", 0);
      callSession.phase = "active";
      syncCallModal();
      startCallTicker();
    } catch (e) {
      shellToast((e && e.message) || "接听失败");
      hideCallModal();
      callSession = null;
    }
  }

  function hideCallModal() {
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = true;
  }

  async function openCall(kind) {
    if (callSession) {
      shellToast("通话进行中");
      return;
    }
    const media = kind === "video" ? "video" : "voice";
    closeCallPicker();
    setPanels(null);
    setChatErr("");
    try {
      const res = await fetch("/api/v1/chat/call/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || data.error || "发起通话失败");
      if (!data.message || !data.message.id) throw new Error("发起通话失败");
      callSession = {
        id: data.message.id,
        media,
        phase: "invite",
        activeAt: 0,
        tick: null,
        autoAnswer: null,
      };
      appendChatMessage(data.message);
      scrollToLatest();
      const modal = document.getElementById("chatCallModal");
      if (modal) modal.hidden = false;
      syncCallModal();
      callSession.autoAnswer = setTimeout(() => {
        answerCallSession();
      }, 1200);
    } catch (e) {
      shellToast((e && e.message) || "发起通话失败");
      callSession = null;
    }
  }

  async function hangCall() {
    if (!callSession) {
      hideCallModal();
      return;
    }
    clearCallTimers();
    const phase = callSession.phase;
    const durationSec =
      phase === "active" && callSession.activeAt
        ? Math.max(1, Math.floor((Date.now() - callSession.activeAt) / 1000))
        : 0;
    const finPhase =
      phase === "active" || phase === "answered" ? "ended" : "declined";
    const id = callSession.id;
    hideCallModal();
    callSession = null;
    try {
      if (finPhase === "ended") {
        await finishCallRemote("ended", durationSec);
      } else {
        await finishCallRemote("declined", 0);
      }
    } catch (e) {
      shellToast((e && e.message) || "结束通话失败");
      try {
        await patchCallPhaseForId(id, finPhase, durationSec);
      } catch (_) {}
    }
  }

  async function patchCallPhaseForId(id, phase, durationSec) {
    const res = await fetch(
      "/api/v1/chat/call/" + encodeURIComponent(id) + "/phase",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, durationSec }),
      }
    );
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (data.message) patchMessageBubble(data.message);
  }

  function closeCall() {
    hangCall();
  }