  function openCall(kind) {
    const modal = document.getElementById("chatCallModal");
    const kindEl = document.getElementById("chatCallKind");
    const peerEl = document.getElementById("chatCallPeer");
    const stateEl = document.getElementById("chatCallState");
    if (!modal) return;
    closeCallPicker();
    setPanels(null);
    if (kindEl) kindEl.textContent = kind === "video" ? "视频通话" : "语音通话";
    if (peerEl) peerEl.textContent = deps.getPeerName() || "家机";
    if (stateEl) stateEl.textContent = "等待接听…";
    modal.hidden = false;
    if (callTimer) clearTimeout(callTimer);
    callTimer = setTimeout(() => {
      if (stateEl) stateEl.textContent = "通话中…";
    }, 1200);
  }

  function closeCall() {
    const modal = document.getElementById("chatCallModal");
    if (modal) modal.hidden = true;
    if (callTimer) {
      clearTimeout(callTimer);
      callTimer = null;
    }
  }