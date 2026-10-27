/**
 * 便签 App 前端（薄巧）。DOM 由壳注入 view.html。
 */
(function (global) {
  let deps = { showView: function () {} };
  let bound = false;
  let cache = { keys: [], notes: [] };
  let pane = "home"; // home | keys | editor | keyEdit
  let filter = "all"; // all | star | keys
  let query = "";
  let starOn = false;

  function $(id) {
    return document.getElementById(id);
  }

  function fmtWhen(ts) {
    const t = Number(ts) || 0;
    if (!t) return "";
    const d = new Date(t);
    const now = Date.now();
    const days = Math.floor((now - t) / 86400000);
    const md =
      d.getMonth() +
      1 +
      "月" +
      d.getDate() +
      "日 " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0");
    if (days <= 0) return "今天 " + md;
    if (days === 1) return "昨天 " + md;
    if (days < 60) return days + "天前 " + md;
    return md;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function plainFromHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = String(html || "");
    return String(d.innerText || d.textContent || "").replace(/\s+/g, " ").trim();
  }

  function bodyToEditorHtml(raw) {
    const s = String(raw || "");
    if (!s) return "";
    if (/<[a-z][\s\S]*>/i.test(s)) return s;
    return escapeHtml(s).replace(/\n/g, "<br>");
  }

  function sanitizeBodyHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = String(html || "");
    d.querySelectorAll("script,style,iframe,object,embed").forEach(function (n) {
      n.remove();
    });
    d.querySelectorAll("*").forEach(function (n) {
      Array.from(n.attributes || []).forEach(function (a) {
        if (/^on/i.test(a.name) || String(a.value || "").indexOf("javascript:") === 0) {
          n.removeAttribute(a.name);
        }
      });
    });
    return d.innerHTML.slice(0, 16000);
  }

  function preview(text, n) {
    const s = plainFromHtml(text);
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function titleFor() {
    if (filter === "keys" || pane === "keys") return "密钥";
    if (filter === "star") return "加星便签";
    return "全部便签";
  }

  function setMenuOpen(on) {
    const menu = $("memoMenu");
    const btn = $("memoTitleBtn");
    if (!menu || !btn) return;
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", on ? "true" : "false");
  }

  function syncBars() {
    const list = $("memoListBar");
    const edit = $("memoEditBar");
    const editing = pane === "editor" || pane === "keyEdit";
    if (list) list.hidden = editing;
    if (edit) edit.hidden = !editing;
    if ($("memoEditBarTitle")) {
      $("memoEditBarTitle").textContent = pane === "keyEdit" ? "密钥" : "写便签";
    }
  }

  function setPane(name) {
    pane = name;
    ["memoHome", "memoKeys", "memoKeyEdit", "memoEditor"].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      const on =
        (name === "home" && id === "memoHome") ||
        (name === "keys" && id === "memoKeys") ||
        (name === "keyEdit" && id === "memoKeyEdit") ||
        (name === "editor" && id === "memoEditor");
      el.classList.toggle("on", on);
    });
    if ($("memoTitle")) $("memoTitle").textContent = titleFor();
    setMenuOpen(false);
    syncBars();
    if (name !== "editor") hideFmt();
    paintMenu();
  }

  function setFilter(f) {
    filter = f;
    if (f === "keys") {
      setPane("keys");
      paint();
      // 进密钥页强制再拉一次（顺带触发服务端补种）
      Promise.resolve()
        .then(function () {
          return fetch("/api/v1/wallet/pocket-keys", {
            credentials: "same-origin",
            cache: "no-store",
          });
        })
        .catch(function () {})
        .then(function () {
          return refresh();
        });
      return;
    }
    setPane("home");
    paint();
  }

  function paintMenu() {
    const notes = cache.notes || [];
    const keys = cache.keys || [];
    const star = notes.filter(function (n) {
      return !!n.pinned;
    }).length;
    if ($("memoMenuAll")) $("memoMenuAll").textContent = String(notes.length);
    if ($("memoMenuStar")) $("memoMenuStar").textContent = String(star);
    if ($("memoMenuKeys")) $("memoMenuKeys").textContent = String(keys.length);
    document.querySelectorAll("#memoMenu .memo-menu-item").forEach(function (btn) {
      const f = btn.getAttribute("data-filter");
      const on =
        (f === "keys" && (pane === "keys" || filter === "keys")) ||
        (f !== "keys" && pane !== "keys" && filter === f);
      btn.classList.toggle("on", on);
    });
  }

  function makeClip(opts) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "memo-clip-meta";
    const when = document.createElement("span");
    when.textContent = opts.when || "";
    meta.append(when);
    const actions = document.createElement("div");
    actions.className = "memo-clip-actions";
    if (opts.star) {
      const star = document.createElement("span");
      star.className = "star";
      star.textContent = "★";
      actions.append(star);
    }
    if (opts.onDel) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "删";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        opts.onDel();
      });
      actions.append(del);
    }
    meta.append(actions);
    li.append(meta);
    const title = document.createElement("div");
    title.className = "memo-clip-title";
    title.textContent = opts.title || "—";
    li.append(title);
    if (opts.body) {
      const body = document.createElement("div");
      body.className = "memo-clip-body";
      body.textContent = opts.body;
      li.append(body);
    }
    li.addEventListener("click", function () {
      if (opts.onClick) opts.onClick();
    });
    return li;
  }

  function paintNotes() {
    const el = $("memoClipList");
    if (!el) return;
    el.replaceChildren();
    let rows = (cache.notes || []).slice();
    if (filter === "star") {
      rows = rows.filter(function (n) {
        return !!n.pinned;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (n) {
        return (
          String(n.title || "")
            .toLowerCase()
            .indexOf(q) >= 0 ||
          plainFromHtml(n.body).toLowerCase().indexOf(q) >= 0
        );
      });
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "memo-empty";
      empty.textContent = q
        ? "没有匹配的便签"
        : filter === "star"
          ? "还没有加星便签"
          : "还没有便签，点右上角新建";
      el.append(empty);
      return;
    }
    rows.forEach(function (n) {
      el.append(
        makeClip({
          when: fmtWhen(n.updated_at),
          title: n.title || "无标题",
          body: preview(n.body, 72),
          star: !!n.pinned,
          onClick: function () {
            openEditor(n);
          },
        })
      );
    });
  }

  function paintKeys() {
    const el = $("memoKeyList");
    if (!el) return;
    el.replaceChildren();
    const keys = cache.keys || [];
    if (!keys.length) {
      const empty = document.createElement("div");
      empty.className = "memo-empty";
      empty.textContent = "还没有密钥，点右上角 ＋ 添加";
      el.append(empty);
      return;
    }
    keys
      .slice()
      .sort(function (a, b) {
        return (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
      })
      .forEach(function (k) {
        const raw = String((k && k.value) || "");
        el.append(
          makeClip({
            when: fmtWhen(k.updated_at),
            title: k.label || "密钥",
            // 列表脱敏：点子页才见明文
            body: raw ? "••••••••" : "（空）",
            onClick: function () {
              openKeyEditor(k);
            },
          })
        );
      });
  }

  function openKeyEditor(key) {
    $("memoKeyId").value = (key && key.id) || "";
    $("memoKeyLabel").value = (key && key.label) || "";
    $("memoKeyValue").value = (key && key.value) || "";
    if ($("memoKeyDel")) $("memoKeyDel").hidden = !(key && key.id);
    setPane("keyEdit");
    setTimeout(function () {
      if ($("memoKeyLabel")) $("memoKeyLabel").focus();
    }, 40);
  }

  async function saveKey() {
    const body = {
      id: $("memoKeyId").value || undefined,
      label: $("memoKeyLabel").value,
      value: $("memoKeyValue").value,
    };
    if (!String(body.label || "").trim() && !String(body.value || "").trim()) {
      setFilter("keys");
      return;
    }
    const data = await api("POST", "/api/v1/memo/keys", body);
    cache = { keys: data.keys || [], notes: data.notes || [] };
    setFilter("keys");
    paint();
  }

  function paint() {
    paintMenu();
    if (pane === "keys") paintKeys();
    else if (pane === "home") paintNotes();
  }

  function deriveTitle(html, fallback) {
    const d = document.createElement("div");
    d.innerHTML = String(html || "");
    const h = d.querySelector("h1, h2, h3, .memo-h");
    if (h) {
      const t = plainFromHtml(h.innerHTML).slice(0, 80);
      if (t) return t;
    }
    const plain = plainFromHtml(html);
    if (plain) return plain.slice(0, 80);
    return String(fallback || "").trim().slice(0, 80) || "无标题";
  }

  function syncEditMeta(note) {
    const folder =
      filter === "star" ? "加星便签" : filter === "keys" ? "全部便签" : titleFor();
    if ($("memoEditFolder")) $("memoEditFolder").textContent = folder;
    if ($("memoEditWhen")) {
      $("memoEditWhen").textContent = note && note.updated_at
        ? fmtWhen(note.updated_at)
        : "今天 " +
          String(new Date().getHours()).padStart(2, "0") +
          ":" +
          String(new Date().getMinutes()).padStart(2, "0");
    }
    updateCount();
    setStar(starOn);
  }

  function updateCount() {
    const body = plainFromHtml(($("memoNoteBody") && $("memoNoteBody").innerHTML) || "");
    if ($("memoEditCount")) $("memoEditCount").textContent = String(body.length);
  }

  function syncFmtActive() {
    const bar = $("memoFmt");
    if (!bar || bar.hidden) return;
    bar.querySelectorAll(".memo-fmt-btn").forEach(function (btn) {
      const kind = btn.getAttribute("data-fmt");
      let on = false;
      try {
        if (kind === "bold") on = document.queryCommandState("bold");
        else if (kind === "center") on = document.queryCommandState("justifyCenter");
        else if (kind === "list") on = document.queryCommandState("insertUnorderedList");
        else if (kind === "h") {
          const b = document.queryCommandValue("formatBlock") || "";
          on = /h2|h1/i.test(b);
        } else if (kind === "quote") {
          const b = document.queryCommandValue("formatBlock") || "";
          on = /blockquote/i.test(b);
        }
      } catch (_) {}
      btn.classList.toggle("on", !!on);
    });
  }

  function setStar(on) {
    starOn = !!on;
    const btn = $("memoNoteStar");
    if (!btn) return;
    btn.setAttribute("aria-pressed", starOn ? "true" : "false");
    btn.textContent = starOn ? "★" : "☆";
  }

  function openEditor(note) {
    $("memoNoteId").value = (note && note.id) || "";
    $("memoNoteTitle").value = (note && note.title) || "";
    const ed = $("memoNoteBody");
    if (ed) ed.innerHTML = bodyToEditorHtml(note && note.body);
    starOn = !!(note && note.pinned);
    $("memoNoteDel").hidden = !(note && note.id);
    setPane("editor");
    syncEditMeta(note);
    setTimeout(function () {
      const body = $("memoNoteBody");
      if (body) body.focus();
    }, 40);
  }

  async function saveNote() {
    const html = sanitizeBodyHtml(($("memoNoteBody") && $("memoNoteBody").innerHTML) || "");
    const plain = plainFromHtml(html);
    const prevTitle = String(($("memoNoteTitle") && $("memoNoteTitle").value) || "");
    const body = {
      id: $("memoNoteId").value || undefined,
      title: deriveTitle(html, prevTitle),
      body: html,
      pinned: starOn,
    };
    if (!plain) {
      setFilter(filter === "keys" ? "all" : filter);
      return;
    }
    const data = await api("POST", "/api/v1/memo/notes", body);
    cache = { keys: data.keys || [], notes: data.notes || [] };
    setFilter(filter === "keys" ? "all" : filter);
    paint();
  }

  async function api(method, url, body) {
    const opts = { method: method, credentials: "same-origin", cache: "no-store" };
    if (body != null) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok || !data.ok) {
      throw new Error((data && data.message) || "请求失败");
    }
    return data;
  }

  async function refresh() {
    try {
      const data = await api("GET", "/api/v1/memo");
      cache = { keys: data.keys || [], notes: data.notes || [] };
      paint();
    } catch (e) {
      cache = { keys: [], notes: [] };
      paint();
      const host = pane === "keys" ? $("memoKeyList") : $("memoClipList");
      if (host) {
        host.innerHTML =
          '<div class="memo-empty">' + ((e && e.message) || "加载失败") + "</div>";
      }
    }
  }

  function leaveEditor() {
    hideFmt();
    if (pane === "keyEdit" || filter === "keys") setFilter("keys");
    else setFilter(filter === "keys" ? "all" : filter);
  }

  function showFmt() {
    const bar = $("memoFmt");
    const root = $("view-memo");
    if (!bar) return;
    bar.hidden = false;
    if (root) root.classList.add("memo-fmt-on");
    placeFmt();
  }

  function hideFmt() {
    const bar = $("memoFmt");
    const root = $("view-memo");
    if (bar) bar.hidden = true;
    if (root) root.classList.remove("memo-fmt-on");
  }

  function placeFmt() {
    const bar = $("memoFmt");
    if (!bar || bar.hidden) return;
    const vv = window.visualViewport;
    if (vv) {
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      bar.style.bottom = gap + "px";
    } else {
      bar.style.bottom = "0px";
    }
  }

  function applyFmt(kind) {
    const ed = $("memoNoteBody");
    if (!ed) return;
    ed.focus();
    try {
      if (kind === "bold") document.execCommand("bold");
      else if (kind === "center") document.execCommand("justifyCenter");
      else if (kind === "list") document.execCommand("insertUnorderedList");
      else if (kind === "h") document.execCommand("formatBlock", false, "h2");
      else if (kind === "quote") document.execCommand("formatBlock", false, "blockquote");
      else if (kind === "todo") {
        document.execCommand(
          "insertHTML",
          false,
          '<div class="memo-todo"><span class="box" contenteditable="false"></span><span class="txt">待办事项</span></div><div><br></div>'
        );
      }
    } catch (_) {}
    updateCount();
    syncFmtActive();
  }

  function bind() {
    if (bound) return;
    bound = true;
    $("btnMemoBack").addEventListener("click", function () {
      setMenuOpen(false);
      if (pane === "home" && filter === "all") deps.showView("home");
      else setFilter("all");
    });
    $("btnMemoEditBack").addEventListener("click", function () {
      leaveEditor();
    });
    $("btnMemoEditDone").addEventListener("click", async function () {
      try {
        if (pane === "keyEdit") await saveKey();
        else await saveNote();
      } catch (e) {
        alert((e && e.message) || "保存失败");
      }
    });
    $("memoTitleBtn").addEventListener("click", function () {
      if (pane === "editor" || pane === "keyEdit") return;
      const menu = $("memoMenu");
      setMenuOpen(!!(menu && menu.hidden));
    });
    document.querySelectorAll("#memoMenu .memo-menu-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setFilter(btn.getAttribute("data-filter") || "all");
      });
    });
    $("btnMemoCompose").addEventListener("click", function () {
      if (filter === "keys" || pane === "keys") openKeyEditor(null);
      else openEditor(null);
    });
    $("memoSearch").addEventListener("input", function () {
      query = $("memoSearch").value || "";
      paintNotes();
    });
    $("memoNoteStar").addEventListener("click", function () {
      setStar(!starOn);
    });
    const ed = $("memoNoteBody");
    if (ed) {
      ed.addEventListener("input", function () {
        updateCount();
        syncFmtActive();
      });
      ed.addEventListener("keyup", syncFmtActive);
      ed.addEventListener("mouseup", syncFmtActive);
      ed.addEventListener("focus", function () {
        if (pane === "editor") showFmt();
      });
      ed.addEventListener("blur", function () {
        setTimeout(function () {
          const a = document.activeElement;
          if (a && a.id === "memoNoteBody") return;
          if (a && a.closest && a.closest("#memoFmt")) return;
          hideFmt();
        }, 120);
      });
      ed.addEventListener("click", function (e) {
        const box = e.target && e.target.closest ? e.target.closest(".memo-todo .box") : null;
        if (!box) return;
        e.preventDefault();
        box.classList.toggle("on");
        updateCount();
      });
    }
    const fmt = $("memoFmt");
    if (fmt) {
      fmt.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      fmt.querySelectorAll(".memo-fmt-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          applyFmt(btn.getAttribute("data-fmt") || "");
        });
      });
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", placeFmt);
      window.visualViewport.addEventListener("scroll", placeFmt);
    }
    window.addEventListener("resize", placeFmt);
    if ($("memoKeyDel")) {
      $("memoKeyDel").addEventListener("click", async function () {
        const id = $("memoKeyId").value;
        if (!id || !confirm("删除这条密钥？")) return;
        try {
          const data = await api("DELETE", "/api/v1/memo/keys/" + encodeURIComponent(id));
          cache = { keys: data.keys || [], notes: data.notes || [] };
          setFilter("keys");
          paint();
        } catch (e) {
          alert((e && e.message) || "删除失败");
        }
      });
    }
    $("memoNoteDel").addEventListener("click", async function () {
      const id = $("memoNoteId").value;
      if (!id || !confirm("删除这篇便签？")) return;
      try {
        const data = await api("DELETE", "/api/v1/memo/notes/" + encodeURIComponent(id));
        cache = { keys: data.keys || [], notes: data.notes || [] };
        setFilter(filter === "keys" ? "all" : filter);
        paint();
      } catch (e) {
        alert((e && e.message) || "删除失败");
      }
    });
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  function onShow() {
    bind();
    filter = "all";
    query = "";
    if ($("memoSearch")) $("memoSearch").value = "";
    setPane("home");
    refresh();
  }

  global.MemoApp = { mount: mount, onShow: onShow };
})(typeof window !== "undefined" ? window : global);
