    bindBubbleFavorite(bubble, msg);
    if (msg.from === "bot") {
      const col = document.createElement("div");
      col.className = "wx-col";
      col.append(bubble);
      /* 家机气泡始终可点兔子；有 think 显示正文，否则提示 */
      bindBunnyThink(bubble, col, msg.think);
      row.append(av, col);
    } else {
      row.append(av, bubble);
    }
    box.append(row);
    box.scrollTop = box.scrollHeight;
    return bubble;
  }

  function bindBubbleFavorite(bubble, msg) {
    if (!bubble || !msg) return;
    const text = String(histPreview(msg) || "").trim();
    if (!text || msg.kind === "tool") return;
    const peer = deps.getPeerName() || "家机";
    const who = msg.from === "you" ? "你" : peer;
    bubble.dataset.favText = text.slice(0, 400);
    bubble.dataset.favMeta = "聊天 · " + who;
    if (msg.id) bubble.dataset.favRef = String(msg.id);
    let holdTimer = null;
    let armed = false;
    const clear = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    bubble.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      clear();
      armed = false;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        armed = true;
        addFavoriteFromUi({
          src: "chat",
          refId: bubble.dataset.favRef || "",
          text: bubble.dataset.favText || "",
          meta: bubble.dataset.favMeta || "聊天",
        });
      }, 520);
    });
    bubble.addEventListener("pointerup", clear);
    bubble.addEventListener("pointerleave", clear);
    bubble.addEventListener("pointercancel", clear);
    bubble.addEventListener("click", (e) => {
      if (!armed) return;
      armed = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    bubble.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  async function addFavoriteFromUi(patch) {
    try {
      const res = await fetch("/api/v1/chat/favorites", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404) throw new Error("接口未就绪：请重启 npm start");
        if (res.status === 401 || data.error === "gate_locked") {
          throw new Error(data.message || "请先解锁访问密码");
        }
        throw new Error(data.message || "收藏失败");
      }
      shellToast(data.existed ? "已在收藏里" : "已收藏");
    } catch (err) {
      shellToast((err && err.message) || "收藏失败");
    }
  }
