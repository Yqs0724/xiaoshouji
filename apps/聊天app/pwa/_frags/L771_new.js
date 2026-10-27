  async function finishCallRemote(id, phase, durationSec) {
    const sid = String(id || "").trim();
    if (!sid) return;
    const res = await fetch(
      "/api/v1/chat/call/" + encodeURIComponent(sid) + "/finish",
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

  async function enterActiveCall() {
    if (!callSession) return;
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
      shellToast((e && e.message) || "接通失败");
      hideCallModal();
      callSession = null;
    }
  }

  /** 来电：你点接听 */
  async function answerCallSession() {
    if (!callSession || callSession.phase !== "invite") return;
    if (callSession.dir === "out") return;
    if (callSession.peerTimer) {
      clearTimeout(callSession.peerTimer);
      callSession.peerTimer = null;
    }
    await enterActiveCall();
  }

  /** 拨出：对方随机接 / 拒 */
  function schedulePeerDecision() {
    if (!callSession || callSession.dir !== "out") return;
    if (callSession.peerTimer) clearTimeout(callSession.peerTimer);
    const delay = 1800 + Math.floor(Math.random() * 6200);
    const accept = Math.random() < 0.62;
    callSession.peerTimer = setTimeout(async () => {
      if (!callSession || callSession.phase !== "invite") return;
      callSession.peerTimer = null;
      if (accept) {
        await enterActiveCall();
      } else {
        const id = callSession.id;
        clearCallTimers();
        hideCallModal();
        callSession = null;
        try {
          await finishCallRemote(id, "rejected", 0);
        } catch (e) {
          shellToast((e && e.message) || "对方已拒绝");
          try {
            await patchCallPhaseForId(id, "rejected", 0);
          } catch (_) {}
        }
      }
    }, delay);
  }

  function hideCallModal() {
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = true;
  }

  function attachCallSession(msg, opts) {
    const p = (msg && msg.payload) || {};
    callSession = {
      id: msg.id,
      media: p.media === "video" ? "video" : "voice",
      dir: p.dir === "out" ? "out" : "in",
      phase: p.phase || "invite",
      activeAt: 0,
      tick: null,
      peerTimer: null,
    };
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = false;
    syncCallModal();
    if (callSession.dir === "out" && callSession.phase === "invite") {
      schedulePeerDecision();
    }
    if (opts && opts.append) {
      appendChatMessage(msg);
      scrollToLatest();
    }
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
        body: JSON.stringify({ media, dir: "out" }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) throw new Error(data.message || data.error || "发起通话失败");
      if (!data.message || !data.message.id) throw new Error("发起通话失败");
      attachCallSession(data.message, { append: true });
    } catch (e) {
      shellToast((e && e.message) || "发起通话失败");
      callSession = null;
    }
  }

  /** 来电：线程里未接邀请 → 弹出接听 */
  function resumeInboundIfNeeded(msgs) {
    if (callSession) return;
    if (!Array.isArray(msgs) || !msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (!last || last.kind !== "call" || last.from !== "bot") return;
    const p = last.payload || {};
    if (p.dir === "out" || p.phase !== "invite") return;
    if (Date.now() - (Number(last.ts) || 0) > 90000) return;
    attachCallSession(last, { append: false });
  }

  async function hangCall() {
    if (!callSession) {
      hideCallModal();
      return;
    }
    clearCallTimers();
    const phase = callSession.phase;
    const id = callSession.id;
    const durationSec =
      phase === "active" && callSession.activeAt
        ? Math.max(1, Math.floor((Date.now() - callSession.activeAt) / 1000))
        : 0;
    const finPhase =
      phase === "active" || phase === "answered" ? "ended" : "declined";
    hideCallModal();
    callSession = null;
    try {
      await finishCallRemote(id, finPhase, durationSec);
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

  function clearCallTimers() {
    if (!callSession) return;
    if (callSession.tick) {
      clearInterval(callSession.tick);
      callSession.tick = null;
    }
    if (callSession.peerTimer) {
      clearTimeout(callSession.peerTimer);
      callSession.peerTimer = null;
    }
    if (callSession.autoAnswer) {
      clearTimeout(callSession.autoAnswer);
      callSession.autoAnswer = null;
    }
  }

  function closeCall() {
    hangCall();
  }