  function setTyping(on) {
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
  }

  function paintMoodCap(data) {
    const cap = document.getElementById("chatMoodCap");
    const prefLab = document.getElementById("chatPrefMoodLab");
    const label = data && data.label ? String(data.label) : "";
    if (prefLab) prefLab.textContent = label || "—";
    if (!cap) return;
    if (!label) {
      cap.hidden = true;
      cap.textContent = "";
      cap.classList.remove("is-cold", "is-sour", "is-up");
      return;
    }
    cap.hidden = false;
    cap.textContent = label;
    cap.classList.toggle("is-cold", label === "冷战");
    cap.classList.toggle("is-sour", label === "别扭" || label === "低落");
    cap.classList.toggle("is-up", label === "开心");
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
    try {
      const res = await fetch("/api/v1/chat/prefs", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const slow = document.getElementById("chatTogSlow");
      if (slow) {
        slow.classList.toggle("on", data.slow_reply !== false);
      }
    } catch (_) {}
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