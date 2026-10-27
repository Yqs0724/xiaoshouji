  function showChatOverlay(id) {
    document.querySelectorAll("#view-chat .chat-overlay").forEach((el) => {
      const on = el.id === id;
      el.classList.toggle("active", on);
      el.hidden = !on;
    });
  }

  function closePeerPage() {
    const el = document.getElementById("chatOvPeer");
    if (!el) return;
    el.classList.remove("active");
    el.hidden = true;
  }

  function paintPeerPageLabels() {
    const pinVal = document.getElementById("chatPeerPinVal");
    const muteVal = document.getElementById("chatPeerMuteVal");
    if (pinVal) pinVal.textContent = readPins().includes("daily") ? "开" : "关";
    if (muteVal) muteVal.textContent = readMutes().includes("daily") ? "开" : "关";
    const title = document.getElementById("chatPeerPageTitle");
    if (title) title.textContent = deps.getPeerName() || "家机";
  }

  function openPeerPage() {
    closeSessMenu();
    closePersonaEditor();
    closeHist({ skipReturn: true });
    chatSubReturn = null;
    histReturnTo = null;
    paintPeerPageLabels();
    showChatOverlay("chatOvPeer");
  }

  function closePersonaEditor() {
    const el = document.getElementById("chatOvPersona");
    if (!el) return;
    el.classList.remove("active");
    el.hidden = true;
  }

  async function openPersonaEditor() {
    const el = document.getElementById("chatOvPersona");
    const ta = document.getElementById("chatPersonaInput");
    if (!el || !ta) return;
    chatSubReturn = "peer";
    ta.value = "";
    try {
      const res = await fetch("/api/v1/settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取人设失败");
      ta.value = String(data.persona || "");
    } catch (err) {
      shellToast((err && err.message) || "读取人设失败");
    }
    showChatOverlay("chatOvPersona");
    try {
      ta.focus();
    } catch (_) {}
  }

  async function savePersonaEditor() {
    const ta = document.getElementById("chatPersonaInput");
    if (!ta) return;
    const persona = String(ta.value || "").slice(0, 2000);
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      shellToast("已保存");
      backFromPersona();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }

  function backFromPersona() {
    closePersonaEditor();
    if (chatSubReturn === "peer") {
      chatSubReturn = null;
      openPeerPage();
      return;
    }
    chatSubReturn = null;
  }

  function openProfileFromPeer() {
    chatSubReturn = "peer";
    showChatOverlay("chatOvProfile");
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

  function runPeerAct(act) {
    if (act === "profile") {
      openProfileFromPeer();
      return;
    }
    if (act === "moments") {
      /* 朋友圈是底栏主 Tab，会离开会话栈 */
      goChatTab("moments");
      return;
    }
    if (act === "hist") {
      histReturnTo = "peer";
      closePeerPage();
      openHist();
      return;
    }
    if (act === "persona") {
      openPersonaEditor();
      return;
    }
    if (act === "note") {
      shellToast("备注 · 稍后");
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

  function openShellOverlay(id) {
    chatSubReturn = null;
    histReturnTo = null;
    closeThreadLayer();
    showChatOverlay(id);
  }