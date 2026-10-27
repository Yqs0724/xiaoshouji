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