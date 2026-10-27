    const openSearch = document.getElementById("btnChatShellSearch");
    if (openSearch) {
      openSearch.addEventListener("click", () => {
        openShellOverlay("chatOvSearch");
        const q = document.getElementById("chatShellSearchQ");
        if (q) q.value = "";
        paintSearchEmpty();
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
    const searchHits = document.getElementById("chatShellSearchHits");
    if (searchHits) {
      searchHits.addEventListener("click", (e) => {
        const more = e.target.closest("[data-search-chat-more]");
        if (more) {
          shellSearchChatMore = true;
          const q = document.getElementById("chatShellSearchQ");
          runShellSearch(q ? q.value : shellSearchLastQ, { keepMore: true });
          return;
        }
        const fav = e.target.closest("[data-jump-fav]");
        if (fav) {
          const id = fav.getAttribute("data-jump-fav");
          const item = (favItems || []).find((x) => x.id === id);
          if (item) jumpFavorite(item);
          else shellToast("原消息不在了");
          return;
        }
        const mom = e.target.closest("[data-jump-mom]");
        if (mom) {
          jumpToMomentPost(mom.getAttribute("data-jump-mom"));
          return;
        }
        const contact = e.target.closest("[data-jump-contact]");
        if (contact) {
          openShellOverlay("chatOvProfile");
          return;
        }
        const msg = e.target.closest("[data-jump-msg]");
        if (msg) jumpToChatMessage(msg.getAttribute("data-jump-msg"));
      });
    }
