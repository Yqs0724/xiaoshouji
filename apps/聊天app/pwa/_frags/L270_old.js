    const openSearch = document.getElementById("btnChatShellSearch");
    if (openSearch) {
      openSearch.addEventListener("click", () => {
        openShellOverlay("chatOvSearch");
        shellSearchCat = "";
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
        const cat = e.target.closest("[data-search-cat]");
        if (cat) {
          const id = cat.getAttribute("data-search-cat") || "";
          shellSearchCat = shellSearchCat === id ? "" : id;
          const q = document.getElementById("chatShellSearchQ");
          if (q && String(q.value || "").trim()) runShellSearch(q.value);
          else paintSearchEmpty();
          if (q) q.focus();
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
