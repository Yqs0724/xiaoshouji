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
    const shortTa = document.getElementById("chatPersonaInput");
    const cardTa = document.getElementById("chatPersonaCardInput");
    const nameEl = document.getElementById("chatProfileName");
    const av = document.getElementById("chatProfileAv");
    if (!el) return;
    chatSubReturn = returnTo || null;
    if (nameEl) nameEl.textContent = deps.getPeerName() || "家机";
    if (av) av.src = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    if (shortTa) shortTa.value = "";
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
        if (shortTa) shortTa.value = String(data.persona || "");
        if (cardTa) cardTa.value = String(data.persona_card || "");
      } else {
        const local = (data.persona_apps && data.persona_apps.chat) || {};
        if (shortTa) shortTa.value = String(local.persona || "");
        if (cardTa) cardTa.value = String(local.persona_card || "");
      }
    } catch (err) {
      shellToast((err && err.message) || "读取资料失败");
    }
    showChatOverlay("chatOvProfile");
    try {
      if (shortTa) shortTa.focus();
    } catch (_) {}
  }

  async function saveProfilePage() {
    const shortTa = document.getElementById("chatPersonaInput");
    const cardTa = document.getElementById("chatPersonaCardInput");
    const useCb = document.getElementById("chatPersonaUseHut");
    if (!shortTa || !cardTa) return;
    const persona = String(shortTa.value || "").slice(0, 2000);
    const persona_card = String(cardTa.value || "").slice(0, 12000);
    const inherit = !useCb || useCb.checked;
    const body = { persona_use_hut: { chat: inherit } };
    if (inherit) {
      body.persona = persona;
      body.persona_card = persona_card;
    } else {
      body.persona_apps = { chat: { persona, persona_card } };
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
      shellToast("已保存");
      backFromProfile();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }