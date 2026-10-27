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