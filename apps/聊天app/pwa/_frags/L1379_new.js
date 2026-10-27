  function escapeWorldHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function readChatDocx(file) {
    const res = await fetch("/api/v1/import/docx", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || "docx 导入失败");
    return String(data.text || "");
  }

  function paintChatWorldBooks(books, activeCap) {
    const list = document.getElementById("chatWorldList");
    if (!list) return;
    if (!books.length) {
      list.innerHTML = '<p class="chat-hint-line">还没有世界书。导入 JSON / txt / docx。</p>';
      return;
    }
    const cap = activeCap || 3;
    list.innerHTML = books
      .map((b) => {
        const id = String(b.id || "").replace(/"/g, "");
        const nm = escapeWorldHtml(b.name || "未命名");
        const fn = String(b.filename || "").trim();
        const n = Number(b.entry_count) || 0;
        const meta = n + " 条" + (fn ? " · " + escapeWorldHtml(fn) : "");
        return (
          '<div class="chat-world-row" data-world-id="' +
          id +
          '">' +
          '<input type="checkbox" class="chat-world-active" ' +
          (b.active ? "checked " : "") +
          'title="最多 ' +
          cap +
          ' 本" />' +
          '<span class="nm" title="' +
          nm +
          '">' +
          nm +
          "</span>" +
          '<span class="meta">' +
          meta +
          "</span>" +
          '<button type="button" class="chat-world-del">删</button>' +
          "</div>"
        );
      })
      .join("");
  }

  async function openWorldPage(returnTo) {
    const el = document.getElementById("chatOvWorld");
    if (!el) return;
    chatSubReturn = returnTo || null;
    const en = document.getElementById("chatWorldEnabled");
    const depth = document.getElementById("chatWorldScanDepth");
    const bud = document.getElementById("chatWorldBudget");
    if (en) en.checked = false;
    if (depth) depth.value = "4";
    if (bud) bud.value = "6000";
    paintChatWorldBooks([], 3);
    try {
      const [sRes, wRes] = await Promise.all([
        fetch("/api/v1/settings", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/v1/world", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const s = await sRes.json().catch(() => ({}));
      const w = await wRes.json().catch(() => ({}));
      if (!sRes.ok) throw new Error(s.message || "读取设定失败");
      if (!wRes.ok) throw new Error(w.message || "读取世界书失败");
      if (en) en.checked = !!s.worldbook_enabled;
      if (depth) depth.value = String(s.worldbook_scan_depth != null ? s.worldbook_scan_depth : 4);
      if (bud) bud.value = String(s.worldbook_budget_chars != null ? s.worldbook_budget_chars : 6000);
      paintChatWorldBooks(w.books || [], w.active_cap || 3);
    } catch (err) {
      shellToast((err && err.message) || "读取世界书失败");
    }
    showChatOverlay("chatOvWorld");
  }

  async function saveWorldPage() {
    const en = document.getElementById("chatWorldEnabled");
    const depth = document.getElementById("chatWorldScanDepth");
    const bud = document.getElementById("chatWorldBudget");
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worldbook_enabled: !!(en && en.checked),
          worldbook_scan_depth: Number(depth && depth.value) || 0,
          worldbook_budget_chars: Number(bud && bud.value) || 6000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      shellToast("已保存");
      backFromWorld();
    } catch (err) {
      shellToast((err && err.message) || "保存失败");
    }
  }

  function backFromWorld() {
    const ret = chatSubReturn;
    chatSubReturn = null;
    const el = document.getElementById("chatOvWorld");
    if (el) {
      el.classList.remove("active");
      el.hidden = true;
    }
    if (ret === "peer") {
      openPeerPage();
      return;
    }
    if (ret === "prefs") {
      openShellOverlay("chatOvPrefs");
      return;
    }
    closeShellOverlays();
  }

  async function onChatWorldFileChange(ev) {
    const input = ev && ev.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      const name = String(file.name || "");
      let text;
      if (/\.docx$/i.test(name)) text = await readChatDocx(file);
      else text = await file.text();
      const res = await fetch("/api/v1/world/books", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, name, filename: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "导入失败");
      paintChatWorldBooks(data.books || [], data.active_cap || 3);
      shellToast("已导入「" + ((data.book && data.book.name) || name) + "」");
    } catch (err) {
      shellToast((err && err.message) || "导入失败");
    } finally {
      if (input) input.value = "";
    }
  }

  async function onChatWorldListClick(ev) {
    const row = ev.target.closest(".chat-world-row");
    if (!row) return;
    const id = row.getAttribute("data-world-id");
    if (!id) return;
    if (ev.target.classList.contains("chat-world-del")) {
      try {
        const res = await fetch("/api/v1/world/books/" + encodeURIComponent(id), {
          method: "DELETE",
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "删除失败");
        paintChatWorldBooks(data.books || [], data.active_cap || 3);
      } catch (err) {
        shellToast((err && err.message) || "删除失败");
      }
      return;
    }
    if (ev.target.classList.contains("chat-world-active")) {
      const active = !!ev.target.checked;
      try {
        const res = await fetch("/api/v1/world/books/" + encodeURIComponent(id), {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          ev.target.checked = !active;
          throw new Error(data.message || "更新失败");
        }
        paintChatWorldBooks(data.books || [], data.active_cap || 3);
      } catch (err) {
        shellToast((err && err.message) || "更新失败");
      }
    }
  }

  function runPeerAct(act) {
    if (act === "profile") {
      openProfilePage("peer");
      return;
    }
    if (act === "world") {
      openWorldPage("peer");
      return;
    }
    if (act === "moments") {