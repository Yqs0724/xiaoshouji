  function bindShell() {
    document.querySelectorAll("#view-chat .chat-dock [data-chat-go]").forEach((b) => {
      b.addEventListener("click", () => goChatTab(b.getAttribute("data-chat-go")));
    });
    const home = document.getElementById("btnChatShellHome");
    if (home) home.addEventListener("click", () => deps.showView("home"));
    const add = document.getElementById("btnChatShellAdd");
    if (add) add.addEventListener("click", () => shellToast("单 peer 够用 · 多会话后置"));
    const sess = document.getElementById("btnChatSessHome");
    if (sess) sess.addEventListener("click", () => openThreadLayer());
    const contact = document.getElementById("btnChatContactHome");
    if (contact) contact.addEventListener("click", () => openShellOverlay("chatOvProfile"));
    const profileBack = document.getElementById("btnChatProfileBack");
    if (profileBack) profileBack.addEventListener("click", () => closeShellOverlays());
    const profileChat = document.getElementById("btnChatProfileChat");
    if (profileChat) {
      profileChat.addEventListener("click", () => {
        closeShellOverlays();
        openThreadLayer();
      });
    }
    const profileCall = document.getElementById("btnChatProfileCall");
    if (profileCall) {
      profileCall.addEventListener("click", () => shellToast("通话后置 · 已记备忘"));
    }
    const openSearch = document.getElementById("btnChatShellSearch");
    if (openSearch) {
      openSearch.addEventListener("click", () => {
        openShellOverlay("chatOvSearch");
        const q = document.getElementById("chatShellSearchQ");
        if (q) q.value = "";
        runShellSearch("");
        if (q) q.focus();
      });
    }
    const searchClose = document.getElementById("btnChatShellSearchClose");
    if (searchClose) searchClose.addEventListener("click", () => closeShellOverlays());
    const searchQ = document.getElementById("chatShellSearchQ");
    if (searchQ) {
      searchQ.addEventListener("input", () => {
        if (shellSearchTimer) clearTimeout(shellSearchTimer);
        shellSearchTimer = setTimeout(() => runShellSearch(searchQ.value), 220);
      });
    }
    const compose = document.getElementById("btnChatMomCompose");
    if (compose) {
      compose.addEventListener("click", () => {
        const ta = document.getElementById("chatComposeTxt");
        if (ta) ta.value = "";
        openShellOverlay("chatOvCompose");
      });
    }
    const composeBack = document.getElementById("btnChatComposeBack");
    if (composeBack) composeBack.addEventListener("click", () => closeShellOverlays());
    const composePost = document.getElementById("btnChatComposePost");
    if (composePost) {
      composePost.addEventListener("click", () => {
        const ta = document.getElementById("chatComposeTxt");
        const txt = String((ta && ta.value) || "").trim();
        if (!txt) {
          shellToast("写点什么再发");
          return;
        }
        ensureMomPosts().unshift({
          id: Date.now(),
          name: "你",
          av: deps.getAvatarYou() || "/assets/cafe/avatar-you.png",
          txt,
          time: "刚刚",
          liked: false,
          likes: [],
          comments: [],
        });
        renderMomFeed();
        closeShellOverlays();
        goChatTab("moments");
        shellToast("已发（本机示意）");
      });
    }
    const feed = document.getElementById("chatMomFeed");
    if (feed) {
      feed.addEventListener("click", (e) => {
        const likeBtn = e.target.closest("[data-mom-like]");
        if (likeBtn) {
          const id = Number(likeBtn.getAttribute("data-mom-like"));
          const p = ensureMomPosts().find((x) => x.id === id);
          if (!p) return;
          p.liked = !p.liked;
          if (p.liked) {
            if (!p.likes.includes("你")) p.likes.unshift("你");
          } else {
            p.likes = p.likes.filter((x) => x !== "你");
          }
          renderMomFeed();
          return;
        }
        const cmtBtn = e.target.closest("[data-mom-cmt]");
        if (cmtBtn) {
          const id = cmtBtn.getAttribute("data-mom-cmt");
          const row = feed.querySelector(`[data-mom-cmt-row="${id}"]`);
          if (row) row.classList.toggle("open");
          return;
        }
        const send = e.target.closest("[data-mom-cmt-send]");
        if (send) {
          const id = Number(send.getAttribute("data-mom-cmt-send"));
          const p = ensureMomPosts().find((x) => x.id === id);
          const input = send.parentElement && send.parentElement.querySelector("input");
          const txt = String((input && input.value) || "").trim();
          if (!p || !txt) return;
          p.comments.push({ who: "你", txt });
          if (input) input.value = "";
          renderMomFeed();
        }
      });
    }
    const fav = document.getElementById("btnChatFav");
    if (fav) {
      fav.addEventListener("click", () => {
        renderFavList();
        openShellOverlay("chatOvFav");
      });
    }
    const favBack = document.getElementById("btnChatFavBack");
    if (favBack) favBack.addEventListener("click", () => closeShellOverlays());
    const prefs = document.getElementById("btnChatPrefs");
    if (prefs) prefs.addEventListener("click", () => openShellOverlay("chatOvPrefs"));
    const prefsBack = document.getElementById("btnChatPrefsBack");
    if (prefsBack) prefsBack.addEventListener("click", () => closeShellOverlays());
    const wallet = document.getElementById("btnChatWallet");
    if (wallet) {
      wallet.addEventListener("click", () => {
        shellToast("跳转资产 · 微信钱包");
        try {
          deps.showView("wallet");
        } catch (_) {}
      });
    }
    const bank = document.getElementById("btnChatBank");
    if (bank) {
      bank.addEventListener("click", () => {
        shellToast("跳转资产 · 银行卡");
        try {
          deps.showView("wallet");
        } catch (_) {}
      });
    }
    ["chatTogSound", "chatTogRead"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", () => {
        el.classList.toggle("on");
        if (id === "chatTogSound") {
          shellToast(el.classList.contains("on") ? "提示音开" : "提示音关");
        }
      });
    });
  }

  function bind() {
    if (bound) return;
    bound = true;
    bindShell();
    const back = document.getElementById("btnChatBack");
    if (back) back.addEventListener("click", () => closeThreadLayer());