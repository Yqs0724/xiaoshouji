    bindBubbleCtx(bubble, msg);
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

  function closeCtxMenu() {
    const el = document.getElementById("chatCtx");
    if (el) el.hidden = true;
    ctxPayload = null;
  }

  function openCtxMenu(clientX, clientY, payload) {
    const root = document.getElementById("view-chat");
    const el = document.getElementById("chatCtx");
    const panel = document.getElementById("chatCtxPanel");
    if (!root || !el || !panel || !payload || !payload.text) return;
    ctxPayload = payload;
    el.hidden = false;
    panel.style.left = "0px";
    panel.style.top = "0px";
    const rr = root.getBoundingClientRect();
    const pw = panel.offsetWidth || 168;
    const ph = panel.offsetHeight || 280;
    let x = clientX - rr.left;
    let y = clientY - rr.top;
    x = Math.max(8, Math.min(x, rr.width - pw - 8));
    y = Math.max(8, Math.min(y, rr.height - ph - 8));
    /* 优先出现在触点上方，少挡正文 */
    if (clientY - rr.top > ph + 24) y = clientY - rr.top - ph - 8;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
  }

  function bindLongPress(el, onHold) {
    if (!el || typeof onHold !== "function") return;
    let holdTimer = null;
    let armed = false;
    let sx = 0;
    let sy = 0;
    const clear = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      clear();
      armed = false;
      sx = e.clientX;
      sy = e.clientY;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        armed = true;
        onHold(e.clientX || sx, e.clientY || sy);
      }, 520);
    });
    el.addEventListener("pointermove", (e) => {
      if (!holdTimer) return;
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) clear();
    });
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointerleave", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener(
      "click",
      (e) => {
        if (!armed) return;
        armed = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function bindBubbleCtx(bubble, msg) {
    if (!bubble || !msg) return;
    const text = String(histPreview(msg) || "").trim();
    if (!text || msg.kind === "tool") return;
    const peer = deps.getPeerName() || "家机";
    const who = msg.from === "you" ? "你" : peer;
    bindLongPress(bubble, (x, y) => {
      openCtxMenu(x, y, {
        src: "chat",
        refId: msg.id ? String(msg.id) : "",
        text: text.slice(0, 400),
        meta: "聊天 · " + who,
      });
    });
  }

  async function copyCtxText(text) {
    const t = String(text || "");
    if (!t) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
      } else {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      shellToast("已复制");
    } catch (_) {
      shellToast("复制失败");
    }
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

  async function runCtxAction(action) {
    const p = ctxPayload;
    closeCtxMenu();
    if (!p || !action) return;
    if (action === "copy") {
      await copyCtxText(p.text);
      return;
    }
    if (action === "fav") {
      await addFavoriteFromUi({
        src: p.src || "chat",
        refId: p.refId || "",
        text: p.text,
        meta: p.meta || "",
      });
      return;
    }
    const labels = {
      translate: "翻译",
      forward: "转发",
      multi: "多选",
      quote: "引用",
      recall: "撤回",
      delete: "删除",
    };
    shellToast((labels[action] || "该操作") + " · 未开");
  }
