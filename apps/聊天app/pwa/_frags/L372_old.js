      feed.addEventListener("click", async (e) => {
        const likeBtn = e.target.closest("[data-mom-like]");
        if (likeBtn) {
          const id = likeBtn.getAttribute("data-mom-like");
          try {
            const res = await fetch(
              "/api/v1/moments/" + encodeURIComponent(id) + "/like",
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "点赞失败");
            await refreshMoments();
          } catch (err) {
            shellToast((err && err.message) || "点赞失败");
          }
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
          const id = send.getAttribute("data-mom-cmt-send");
          const input = send.parentElement && send.parentElement.querySelector("input");
          const txt = String((input && input.value) || "").trim();
          if (!txt) return;
          try {
            const res = await fetch(
              "/api/v1/moments/" + encodeURIComponent(id) + "/comments",
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: txt }),
              }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "评论失败");
            if (input) input.value = "";
            await refreshMoments();
          } catch (err) {
            shellToast((err && err.message) || "评论失败");
          }
        }
      });
    }