  async function runShellSearch(q) {
    const box = document.getElementById("chatShellSearchHits");
    if (!box) return;
    const qq = String(q || "").trim();
    try {
      const params = new URLSearchParams();
      if (qq) params.set("q", qq);
      params.set("kind", "all");
      const res = await fetch("/api/v1/chat/search?" + params.toString(), {
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      const hits = Array.isArray(data.messages) ? data.messages : [];
      if (!hits.length) {
        box.innerHTML = `<p class="chat-hint-line">无结果</p>`;
        return;
      }
      box.innerHTML = hits
        .slice(0, 40)
        .map((m) => {
          const preview = histPreview(m);
          const meta = sessTimeLabel(m.ts);
          const mid = m && m.id ? String(m.id) : "";
          return `<button type="button" class="chat-hit-item" data-jump-msg="${escapeHtml(mid)}">
            <div><div class="t">${escapeHtml(preview)}</div><div class="meta">${escapeHtml(meta)}</div></div>
          </button>`;
        })
        .join("");
      box.querySelectorAll("[data-jump-msg]").forEach((el) => {
        el.addEventListener("click", () => {
          jumpToChatMessage(el.getAttribute("data-jump-msg"));
        });
      });
    } catch (_) {
      box.innerHTML = `<p class="chat-hint-line">搜索失败</p>`;
    }
  }
