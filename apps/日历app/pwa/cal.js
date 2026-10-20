/**
 * 日历 App 前端。DOM 由壳注入 view.html；真源本文件。
 * 枢纽月格 + 日程/纪念日图标下钻。
 */
(function (global) {
  let deps = {
    showView: function () {},
    onCalendarChanged: function () {},
    getAnnivs: function () {
      return [];
    },
    getPinAnnivId: function () {
      return "";
    },
    applyAnnivs: function () {},
  };

  let annivEditId = null;

  let bound = false;
  let calCursor = new Date();
  let calSelected = localDateISO(new Date());
  let calMonthDots = new Set();
  let proposeBackView = "cal";
  let proposeDraft = []; // event + note 提议混排
  let datePopEl = null;
  let datePopTarget = null;
  let datePopCursor = new Date();
  let datePopDocBound = false;

  function localDateISO(d) {
    const x = d instanceof Date ? d : new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const day = String(x.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function formatHubDay(iso) {
    const parts = String(iso || "").split("-");
    if (parts.length < 3) return iso || "—";
    return Number(parts[1]) + "月" + Number(parts[2]) + "日";
  }

  function setCalMsg(text, kind) {
    const el = document.getElementById("calMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cal-msg" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
  }

  async function fetchCalEvents(params) {
    const q = new URLSearchParams(params || {});
    const res = await fetch("/api/v1/cal/events?" + q.toString(), {
      cache: "no-store",
      credentials: "same-origin",
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("日历接口未就绪：请重启 npm start 后再试");
      }
      if (res.status === 401 || data.error === "gate_locked") {
        throw new Error(data.message || "请先解锁访问密码");
      }
      throw new Error(data.message || data.error || "读取失败");
    }
    return Array.isArray(data.events) ? data.events : [];
  }

  function paintCalGrid() {
    const grid = document.getElementById("calGrid");
    const ym = document.getElementById("calYm");
    if (!grid || !ym) return;
    const y = calCursor.getFullYear();
    const m = calCursor.getMonth();
    ym.textContent = y + "年" + (m + 1) + "月";
    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayIso = localDateISO(new Date());
    grid.replaceChildren();
    for (let i = 0; i < startPad; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mute";
      b.disabled = true;
      b.textContent = "";
      grid.append(b);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = localDateISO(new Date(y, m, day));
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(day);
      b.dataset.date = iso;
      if (iso === calSelected) b.classList.add("on");
      if (iso === todayIso) {
        b.classList.add("today");
        b.title = "今天";
      }
      if (calMonthDots.has(iso)) b.classList.add("has");
      b.addEventListener("click", () => selectDay(iso));
      grid.append(b);
    }
  }

  /** 只选中日子，刷新下方矮摘要卡；不整页跳转 */
  function selectDay(iso) {
    calSelected = String(iso || localDateISO(new Date()));
    paintCalGrid();
    renderDaySummary();
    renderDayNotes();
  }

  /** 进完整日页（添加/删除） */
  function openDay(iso) {
    calSelected = String(iso || calSelected || localDateISO(new Date()));
    paintCalGrid();
    deps.showView("cal-agenda");
    refreshAgenda();
  }

  async function renderDaySummary() {
    const list = document.getElementById("calTodayList");
    const title = document.getElementById("calDaySummaryTitle");
    if (!list) return;
    const today = localDateISO(new Date());
    const day = calSelected || today;
    if (title) title.textContent = day === today ? "今日" : formatHubDay(day);
    list.replaceChildren();
    try {
      const events = await fetchCalEvents({ date: day });
      if (!events.length) {
        const li = document.createElement("li");
        li.className = "cal-empty";
        li.textContent = day === today ? "今日无安排" : "这天还没有日程";
        list.append(li);
        return;
      }
      for (const ev of events.slice(0, 4)) {
        const li = document.createElement("li");
        li.className = ownerClass(ev.owner);
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = ownerLabel(ev.owner);
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = ev.time
          ? String(ev.time) + " · " + ev.title
          : ev.title;
        li.append(chip, t);
        list.append(li);
      }
    } catch (e) {
      const li = document.createElement("li");
      li.className = "cal-empty";
      li.textContent = (e && e.message) || "加载失败";
      list.append(li);
    }
  }

  async function loadCalMonthDots() {
    const y = calCursor.getFullYear();
    const m = calCursor.getMonth();
    const from = localDateISO(new Date(y, m, 1));
    const to = localDateISO(new Date(y, m + 1, 0));
    try {
      const events = await fetchCalEvents({ from: from, to: to });
      calMonthDots = new Set(events.map((e) => e.date));
    } catch (_) {
      calMonthDots = new Set();
    }
    paintCalGrid();
  }

  async function renderCalDayList() {
    const head = document.getElementById("calDayHead");
    const list = document.getElementById("calDayList");
    if (head) head.textContent = formatHubDay(calSelected);
    if (!list) return;
    list.replaceChildren();
    try {
      const events = await fetchCalEvents({ date: calSelected });
      if (!events.length) {
        const p = document.createElement("div");
        p.className = "cal-empty";
        p.textContent = "这天还没有日程";
        list.append(p);
        return;
      }
      for (const ev of events) {
        const li = document.createElement("li");
        li.className = ownerClass(ev.owner);
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = ownerLabel(ev.owner);
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = ev.time
          ? String(ev.time) + " · " + ev.title
          : ev.title;
        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "编辑";
        edit.addEventListener("click", () => editCalEvent(ev));
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          if (!window.confirm("删除「" + ev.title + "」？")) return;
          try {
            const res = await fetch(
              "/api/v1/cal/events/" + encodeURIComponent(ev.id),
              { method: "DELETE", credentials: "same-origin" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || "删除失败");
            setCalMsg("已删除", "ok");
            await refreshAgenda();
            await refreshHub();
            deps.onCalendarChanged();
          } catch (e) {
            setCalMsg((e && e.message) || "删除失败", "bad");
          }
        });
        li.append(chip, t, edit, del);
        list.append(li);
      }
    } catch (e) {
      const p = document.createElement("div");
      p.className = "cal-empty";
      p.textContent = (e && e.message) || "加载失败";
      list.append(p);
    }
  }

  function setAnnivMsg(text, kind) {
    const el = document.getElementById("annivMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cal-msg" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
  }

  async function patchAnnivState(annivs, pin_anniv_id) {
    const res = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ annivs, pin_anniv_id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "http");
    deps.applyAnnivs(data.annivs || [], data.pin_anniv_id || "");
    return data;
  }

  function showAnnivCompose(on, edit) {
    const box = document.getElementById("calAnnivCompose");
    if (!box) return;
    box.hidden = !on;
    if (!on) {
      annivEditId = null;
      return;
    }
    annivEditId = edit && edit.id ? String(edit.id) : null;
    const titleEl = document.getElementById("inAnnivTitle");
    const dateEl = document.getElementById("inAnnivDate");
    if (titleEl) titleEl.value = edit ? String(edit.title || "") : "";
    if (dateEl) dateEl.value = edit ? String(edit.date || "") : "";
    if (titleEl) setTimeout(() => titleEl.focus(), 30);
  }

  function paintAnnivList() {
    const ul = document.getElementById("calAnnivList");
    const unpin = document.getElementById("btnAnnivUnpin");
    if (!ul) return;
    const annivs = deps.getAnnivs() || [];
    const pinId = String(deps.getPinAnnivId() || "");
    ul.replaceChildren();
    if (unpin) unpin.hidden = !pinId;
    if (!annivs.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "还没有纪念日，点「加一条」";
      ul.append(empty);
      return;
    }
    for (const a of annivs) {
      const li = document.createElement("li");
      li.className = "cal-anniv-item" + (a.id === pinId ? " pinned" : "");
      const meta = document.createElement("div");
      meta.className = "meta";
      const strong = document.createElement("strong");
      strong.textContent = a.title || "纪念日";
      const span = document.createElement("span");
      span.textContent = a.date || "";
      meta.append(strong, span);
      const acts = document.createElement("div");
      acts.className = "acts";
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "pin" + (a.id === pinId ? " on" : "");
      pinBtn.textContent = a.id === pinId ? "已钉" : "钉桌面";
      pinBtn.addEventListener("click", () => setPinnedAnniv(a.id === pinId ? "" : a.id));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "改";
      editBtn.addEventListener("click", () => showAnnivCompose(true, a));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "删";
      delBtn.addEventListener("click", () => deleteAnniv(a));
      acts.append(pinBtn, editBtn, delBtn);
      li.append(meta, acts);
      ul.append(li);
    }
  }

  async function setPinnedAnniv(id) {
    setAnnivMsg("保存中…");
    try {
      await patchAnnivState(deps.getAnnivs() || [], id || "");
      paintAnnivList();
      setAnnivMsg(id ? "已钉到桌面" : "已卸钉", "ok");
    } catch (e) {
      setAnnivMsg((e && e.message) || "保存失败", "bad");
    }
  }

  async function deleteAnniv(a) {
    if (!a || !a.id) return;
    if (!window.confirm("删掉「" + (a.title || "这条") + "」？")) return;
    setAnnivMsg("删除中…");
    try {
      const next = (deps.getAnnivs() || []).filter((x) => x.id !== a.id);
      let pinId = String(deps.getPinAnnivId() || "");
      if (pinId === a.id) pinId = "";
      await patchAnnivState(next, pinId);
      if (annivEditId === a.id) showAnnivCompose(false);
      paintAnnivList();
      setAnnivMsg("已删除", "ok");
    } catch (e) {
      setAnnivMsg((e && e.message) || "删除失败", "bad");
    }
  }

  async function saveAnnivCompose() {
    setAnnivMsg("保存中…");
    const title =
      (document.getElementById("inAnnivTitle") &&
        document.getElementById("inAnnivTitle").value) ||
      "";
    const date =
      (document.getElementById("inAnnivDate") &&
        document.getElementById("inAnnivDate").value) ||
      "";
    const t = String(title).trim();
    const d = String(date).trim();
    if (!t || !d) {
      setAnnivMsg("标题和日期都要填", "bad");
      return;
    }
    try {
      const list = (deps.getAnnivs() || []).slice();
      let pinId = String(deps.getPinAnnivId() || "");
      if (annivEditId) {
        const i = list.findIndex((x) => x.id === annivEditId);
        if (i < 0) throw new Error("找不到这条");
        list[i] = { ...list[i], title: t, date: d };
      } else {
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : "anniv-" + Date.now();
        list.push({ id, title: t, date: d });
      }
      await patchAnnivState(list, pinId);
      showAnnivCompose(false);
      paintAnnivList();
      setAnnivMsg("已保存", "ok");
    } catch (e) {
      setAnnivMsg((e && e.message) || "保存失败", "bad");
    }
  }

  async function fetchDayNotes(date) {
    const res = await fetch(
      "/api/v1/cal/notes?date=" + encodeURIComponent(date),
      { credentials: "same-origin" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "读取便签失败");
    return Array.isArray(data.notes) ? data.notes : [];
  }

  function showMemoCard(on) {
    const memo = document.getElementById("calMemo");
    if (!memo) return;
    memo.hidden = !on;
  }

  async function deleteMemoNote(note) {
    if (!note || !note.id) return;
    if (!window.confirm("撕掉这句便签？")) return;
    try {
      const res = await fetch(
        "/api/v1/cal/notes/" + encodeURIComponent(note.id),
        { method: "DELETE", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "删除失败");
      await renderDayNotes();
    } catch (e) {
      window.alert((e && e.message) || "删除失败");
    }
  }

  async function toggleMemoLike(note, btn) {
    if (!note || !note.id) return;
    const liked = !note.liked;
    if (btn) {
      btn.disabled = true;
      btn.classList.toggle("on", liked);
      btn.textContent = liked ? "♥" : "♡";
      btn.setAttribute("aria-pressed", liked ? "true" : "false");
    }
    try {
      const res = await fetch(
        "/api/v1/cal/notes/" + encodeURIComponent(note.id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ liked }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "点赞失败");
      note.liked = liked;
      if (btn) btn.disabled = false;
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.classList.toggle("on", !!note.liked);
        btn.textContent = note.liked ? "♥" : "♡";
        btn.setAttribute("aria-pressed", note.liked ? "true" : "false");
      }
      window.alert((e && e.message) || "点赞失败");
    }
  }

  function appendMemoLine(lines, note, manage) {
    const row = document.createElement("div");
    row.className =
      "cal-memo-line" +
      (note.owner === "companion" ? " owner-companion" : "") +
      (manage ? " manage" : "");
    row.dataset.noteId = note.id;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = ownerLabel(note.owner);
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = note.body;
    const like = document.createElement("button");
    like.type = "button";
    like.className = "like" + (note.liked ? " on" : "");
    like.textContent = note.liked ? "♥" : "♡";
    like.title = note.liked ? "取消喜欢" : "喜欢";
    like.setAttribute("aria-pressed", note.liked ? "true" : "false");
    like.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleMemoLike(note, like);
    });
    row.append(who, body, like);
    if (manage) {
      const acts = document.createElement("span");
      acts.className = "acts";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "act";
      edit.textContent = "改";
      edit.addEventListener("click", () => beginComposeMemoLine(note));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "act del";
      del.textContent = "删";
      del.addEventListener("click", () => deleteMemoNote(note));
      acts.append(edit, del);
      row.append(acts);
    }
    lines.append(row);
  }

  async function beginComposeMemoLine(noteOrNull) {
    const lines = document.getElementById("calMemoLines");
    if (!lines) return;
    const day = calSelected || localDateISO(new Date());
    const editingId = noteOrNull && noteOrNull.id ? noteOrNull.id : "";
    const cur = noteOrNull && noteOrNull.body ? String(noteOrNull.body) : "";
    showMemoCard(true);
    let notes = [];
    try {
      notes = await fetchDayNotes(day);
    } catch (_) {
      notes = [];
    }
    lines.replaceChildren();
    for (const note of notes) {
      if (editingId && note.id === editingId) continue;
      appendMemoLine(lines, note, true); /* 贴便签管理态才露改/删 */
    }
    const box = document.createElement("div");
    box.className = "cal-memo-compose";
    const ta = document.createElement("textarea");
    ta.maxLength = 200;
    ta.rows = 2;
    ta.value = cur;
    ta.placeholder = editingId ? "改这句…" : "在这张便签上写一句…";
    const bar = document.createElement("div");
    bar.className = "bar";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "算了";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ok";
    save.textContent = editingId ? "保存" : "贴上";
    cancel.addEventListener("click", () => renderDayNotes());
    if (editingId) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "删除";
      del.addEventListener("click", () => deleteMemoNote(noteOrNull));
      bar.append(cancel, del, save);
    } else {
      bar.append(cancel, save);
    }
    save.addEventListener("click", async () => {
      save.disabled = true;
      cancel.disabled = true;
      const body = String(ta.value || "");
      try {
        let res;
        if (editingId && !body.trim()) {
          res = await fetch(
            "/api/v1/cal/notes/" + encodeURIComponent(editingId),
            { method: "DELETE", credentials: "same-origin" }
          );
        } else if (editingId) {
          res = await fetch(
            "/api/v1/cal/notes/" + encodeURIComponent(editingId),
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ body }),
            }
          );
        } else {
          if (!body.trim()) {
            save.disabled = false;
            cancel.disabled = false;
            return;
          }
          res = await fetch("/api/v1/cal/notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ date: day, body, owner: "you" }),
          });
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || "保存失败");
        await renderDayNotes();
      } catch (e) {
        save.disabled = false;
        cancel.disabled = false;
        window.alert((e && e.message) || "保存失败");
      }
    });
    box.append(ta, bar);
    lines.append(box);
    ta.focus();
  }

  async function renderDayNotes() {
    const lines = document.getElementById("calMemoLines");
    if (!lines) return;
    const day = calSelected || localDateISO(new Date());
    try {
      const notes = await fetchDayNotes(day);
      if (!notes.length) {
        showMemoCard(false);
        lines.replaceChildren();
        return;
      }
      showMemoCard(true);
      lines.replaceChildren();
      for (const note of notes) appendMemoLine(lines, note);
    } catch (e) {
      showMemoCard(false);
      lines.replaceChildren();
    }
  }

  async function refreshHub() {
    await loadCalMonthDots();
    await renderDaySummary();
    await renderDayNotes();
  }

  async function refreshAgenda() {
    await renderCalDayList();
  }

  async function refreshAnniv() {
    paintAnnivList();
    closeDatePop();
  }

  function ensureDatePop() {
    if (datePopEl) return datePopEl;
    datePopEl = document.createElement("div");
    datePopEl.className = "cal-date-pop";
    datePopEl.hidden = true;
    datePopEl.addEventListener("click", (e) => e.stopPropagation());
    return datePopEl;
  }

  function closeDatePop() {
    if (!datePopEl) return;
    datePopEl.hidden = true;
    datePopTarget = null;
  }

  function paintDatePop() {
    const pop = ensureDatePop();
    const y = datePopCursor.getFullYear();
    const m = datePopCursor.getMonth();
    const selected = datePopTarget ? String(datePopTarget.value || "").trim() : "";
    const todayIso = localDateISO(new Date());
    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const dow = ["日", "一", "二", "三", "四", "五", "六"]
      .map((w) => "<span>" + w + "</span>")
      .join("");
    let cells = "";
    for (let i = 0; i < startPad; i++) {
      const d = new Date(y, m, 1 - (startPad - i));
      cells +=
        '<button type="button" class="mute" data-iso="' +
        localDateISO(d) +
        '">' +
        d.getDate() +
        "</button>";
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = localDateISO(new Date(y, m, day));
      const cls =
        (iso === selected ? " on" : "") + (iso === todayIso ? " today" : "");
      cells +=
        '<button type="button" class="' +
        cls.trim() +
        '" data-iso="' +
        iso +
        '">' +
        day +
        "</button>";
    }
    pop.innerHTML =
      '<div class="cal-date-pop-hd">' +
      '<button type="button" data-y="-1" aria-label="上一年">«</button>' +
      '<button type="button" data-m="-1" aria-label="上一月">‹</button>' +
      '<div class="cal-date-pop-ym">' +
      y +
      "年" +
      (m + 1) +
      "月</div>" +
      '<button type="button" data-m="1" aria-label="下一月">›</button>' +
      '<button type="button" data-y="1" aria-label="下一年">»</button>' +
      "</div>" +
      '<div class="cal-date-pop-dow">' +
      dow +
      "</div>" +
      '<div class="cal-date-pop-grid">' +
      cells +
      "</div>" +
      '<div class="cal-date-pop-ft">' +
      '<button type="button" data-act="clear">清空</button>' +
      '<button type="button" data-act="today">今天</button>' +
      "</div>";
    pop.querySelectorAll("[data-m]").forEach((btn) => {
      btn.addEventListener("click", () => {
        datePopCursor = new Date(y, m + Number(btn.getAttribute("data-m")), 1);
        paintDatePop();
      });
    });
    pop.querySelectorAll("[data-y]").forEach((btn) => {
      btn.addEventListener("click", () => {
        datePopCursor = new Date(y + Number(btn.getAttribute("data-y")), m, 1);
        paintDatePop();
      });
    });
    pop.querySelectorAll(".cal-date-pop-grid [data-iso]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!datePopTarget) return;
        datePopTarget.value = btn.getAttribute("data-iso") || "";
        closeDatePop();
      });
    });
    const clearBtn = pop.querySelector('[data-act="clear"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (datePopTarget) datePopTarget.value = "";
        closeDatePop();
      });
    }
    const todayBtn = pop.querySelector('[data-act="today"]');
    if (todayBtn) {
      todayBtn.addEventListener("click", () => {
        if (!datePopTarget) return;
        datePopTarget.value = todayIso;
        closeDatePop();
      });
    }
  }

  function placeDatePop(input) {
    const pop = ensureDatePop();
    const host = document.getElementById("view-cal-anniv") || document.body;
    host.appendChild(pop);
    const r = input.getBoundingClientRect();
    const w = Math.min(272, window.innerWidth - 24);
    let left = r.left;
    if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
    if (left < 12) left = 12;
    let top = r.bottom + 6;
    const estH = 300;
    if (top + estH > window.innerHeight - 8) {
      top = Math.max(8, r.top - estH - 6);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function openDatePop(input) {
    if (!input) return;
    datePopTarget = input;
    const cur = String(input.value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cur)) {
      const [yy, mm] = cur.split("-").map(Number);
      datePopCursor = new Date(yy, mm - 1, 1);
    } else {
      const n = new Date();
      datePopCursor = new Date(n.getFullYear(), n.getMonth(), 1);
    }
    paintDatePop();
    placeDatePop(input);
    ensureDatePop().hidden = false;
    if (!datePopDocBound) {
      datePopDocBound = true;
      document.addEventListener(
        "click",
        (e) => {
          if (!datePopEl || datePopEl.hidden) return;
          if (datePopEl.contains(e.target)) return;
          if (e.target && e.target.classList && e.target.classList.contains("cal-date-input")) {
            return;
          }
          closeDatePop();
        },
        true
      );
    }
  }

  function bindDateInputs() {
    ["inAnnivDate"].forEach((id) => {
      const input = document.getElementById(id);
      if (!input || input.dataset.datePopBound) return;
      input.dataset.datePopBound = "1";
      input.addEventListener("click", (e) => {
        e.stopPropagation();
        if (datePopTarget === input && datePopEl && !datePopEl.hidden) {
          closeDatePop();
          return;
        }
        openDatePop(input);
      });
    });
  }

  async function refreshCalView() {
    await refreshHub();
  }

  function setProposeMsg(text, kind) {
    const el = document.getElementById("calProposeMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "cal-msg" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
  }

  function openPropose(fromView) {
    proposeBackView = fromView === "cal-agenda" ? "cal-agenda" : "cal";
    deps.showView("cal-propose");
  }

  function ownerLabel(owner) {
    if (owner === "companion") return "家机";
    if (owner === "both") return "两人";
    return "你";
  }

  function ownerClass(owner) {
    if (owner === "companion") return "owner-companion";
    if (owner === "both") return "owner-both";
    return "owner-you";
  }

  function addDaysISO(iso, n) {
    const parts = String(iso || "").split("-").map(Number);
    const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
    d.setDate(d.getDate() + n);
    return localDateISO(d);
  }

  /** ponytail: 前端兜底瞎编；正常走网关 LLM */
  function buildMockProposals() {
    const pool = [
      "傍晚散步半小时",
      "一起买点菜做饭",
      "窝着看一部轻松片",
      "下午茶歇会儿",
      "早点睡补觉",
    ];
    const base = calSelected || localDateISO(new Date());
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    return pool.slice(0, 3).map((title, i) => ({
      id: "p-" + Date.now() + "-" + i,
      kind: "event",
      title,
      date: addDaysISO(base, i),
      status: "proposed",
    }));
  }

  function paintProposeList() {
    const list = document.getElementById("calProposeList");
    if (!list) return;
    list.replaceChildren();
    for (const p of proposeDraft) {
      const isNote = p.kind === "note";
      const li = document.createElement("li");
      const ttl = document.createElement("div");
      ttl.className = "ttl";
      ttl.textContent = isNote ? p.body : p.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        p.date + (isNote ? " · 便签待确认" : " · 日程待确认");
      const acts = document.createElement("div");
      acts.className = "acts";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "ok";
      ok.textContent = isNote ? "确认贴上" : "确认写入";
      ok.addEventListener("click", () => confirmProposal(p.id));
      const no = document.createElement("button");
      no.type = "button";
      no.className = "no";
      no.textContent = "忽略";
      no.addEventListener("click", () => {
        proposeDraft = proposeDraft.filter((x) => x.id !== p.id);
        paintProposeList();
      });
      acts.append(ok, no);
      li.append(ttl, meta, acts);
      list.append(li);
    }
  }

  async function confirmProposal(id) {
    const p = proposeDraft.find((x) => x.id === id);
    if (!p) return;
    setProposeMsg("写入中…");
    try {
      let res;
      if (p.kind === "note") {
        res = await fetch("/api/v1/cal/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            body: p.body,
            date: p.date,
            owner: "companion",
          }),
        });
      } else {
        res = await fetch("/api/v1/cal/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            title: p.title,
            date: p.date,
            owner: "companion",
          }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "写入失败");
      proposeDraft = proposeDraft.filter((x) => x.id !== id);
      paintProposeList();
      setProposeMsg(p.kind === "note" ? "已贴上便签" : "已写入日程", "ok");
      await refreshHub();
      deps.onCalendarChanged();
    } catch (e) {
      setProposeMsg((e && e.message) || "写入失败", "bad");
    }
  }

  async function runPropose() {
    const btn = document.getElementById("btnCalProposeRun");
    setProposeMsg("家机在想…");
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/v1/cal/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          baseDate: calSelected || localDateISO(new Date()),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = data.error || "";
        if (res.status === 404 || code === "not_found") {
          throw new Error("接口未上线 · 请重启网关后再试");
        }
        throw new Error(data.message || code || "提议失败");
      }
      const events = Array.isArray(data.proposals) ? data.proposals : [];
      const notes = Array.isArray(data.noteProposals) ? data.noteProposals : [];
      proposeDraft = events.concat(notes);
      if (!proposeDraft.length) proposeDraft = buildMockProposals();
      paintProposeList();
      const src = data.source || "";
      let msg = "想好了 · 请逐条确认";
      if (src === "llm") msg = "家机想好了 · 请逐条确认";
      else if (src === "mock") msg = data.message || "未接模型 · 已本地瞎编";
      else if (src === "mock_fallback") msg = data.message || "已用本地兜底";
      setProposeMsg(msg, "ok");
    } catch (e) {
      proposeDraft = buildMockProposals();
      paintProposeList();
      setProposeMsg((e && e.message) || "提议失败 · 已本地瞎编", "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function editCalEvent(ev) {
    if (!ev || !ev.id) return;
    const next = window.prompt("编辑安排", ev.title || "");
    if (next == null) return;
    const title = String(next).trim();
    if (!title) {
      setCalMsg("标题不能为空", "bad");
      return;
    }
    const timeRaw = window.prompt(
      "时刻（HH:MM，空=全日）",
      ev.time || ""
    );
    if (timeRaw == null) return;
    const time = String(timeRaw).trim();
    if (title === ev.title && time === String(ev.time || "")) return;
    setCalMsg("保存中…");
    try {
      const res = await fetch(
        "/api/v1/cal/events/" + encodeURIComponent(ev.id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ title, time }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "保存失败");
      setCalMsg("已更新", "ok");
      await refreshAgenda();
      await refreshHub();
      deps.onCalendarChanged();
    } catch (e) {
      setCalMsg((e && e.message) || "保存失败", "bad");
    }
  }

  async function addCalEvent() {
    const input = document.getElementById("calNewTitle");
    const timeEl = document.getElementById("calNewTime");
    const title = input ? String(input.value || "").trim() : "";
    const time = timeEl ? String(timeEl.value || "").trim() : "";
    if (!title) {
      setCalMsg("先写一点安排再添加", "bad");
      return;
    }
    setCalMsg("保存中…");
    try {
      const body = { title: title, date: calSelected };
      if (time) body.time = time;
      const res = await fetch("/api/v1/cal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = {};
      }
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("日历接口未就绪：请重启 npm start 后再试");
        }
        if (res.status === 401 || data.error === "gate_locked") {
          throw new Error(data.message || "请先解锁访问密码");
        }
        throw new Error(data.message || data.error || "添加失败");
      }
      if (input) input.value = "";
      if (timeEl) timeEl.value = "";
      setCalMsg("已添加", "ok");
      await refreshAgenda();
      await refreshHub();
      deps.onCalendarChanged();
    } catch (e) {
      setCalMsg((e && e.message) || "添加失败", "bad");
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const back = document.getElementById("btnCalBack");
    if (back) back.addEventListener("click", () => deps.showView("home"));
    const agendaBack = document.getElementById("btnCalAgendaBack");
    if (agendaBack) agendaBack.addEventListener("click", () => deps.showView("cal"));
    const annivBack = document.getElementById("btnCalAnnivBack");
    if (annivBack) annivBack.addEventListener("click", () => deps.showView("cal"));
    const doorB = document.getElementById("btnCalDoorAnniv");
    if (doorB) {
      doorB.addEventListener("click", () => {
        deps.showView("cal-anniv");
        refreshAnniv();
      });
    }
    const openDayBtn = document.getElementById("btnCalOpenDay");
    if (openDayBtn) {
      openDayBtn.addEventListener("click", () => openDay(calSelected));
    }
    const hubAi = document.getElementById("btnCalProposeHub");
    if (hubAi) {
      hubAi.addEventListener("click", () => openPropose("cal"));
    }
    const dayAi = document.getElementById("btnCalProposeDay");
    if (dayAi) {
      dayAi.addEventListener("click", () => openPropose("cal-agenda"));
    }
    const proposeBack = document.getElementById("btnCalProposeBack");
    if (proposeBack) {
      proposeBack.addEventListener("click", () => deps.showView(proposeBackView));
    }
    const proposeRun = document.getElementById("btnCalProposeRun");
    if (proposeRun) proposeRun.addEventListener("click", runPropose);
    const noteAdd = document.getElementById("btnCalNoteAdd");
    if (noteAdd) {
      noteAdd.addEventListener("click", () => beginComposeMemoLine(null));
    }
    const prev = document.getElementById("btnCalPrev");
    const next = document.getElementById("btnCalNext");
    if (prev) {
      prev.addEventListener("click", () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
        refreshHub();
      });
    }
    if (next) {
      next.addEventListener("click", () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
        refreshHub();
      });
    }
    const add = document.getElementById("btnCalAdd");
    if (add) add.addEventListener("click", addCalEvent);
    const input = document.getElementById("calNewTitle");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addCalEvent();
      });
    }
    const addAnniv = document.getElementById("btnAnnivAdd");
    if (addAnniv) {
      addAnniv.addEventListener("click", () => {
        showAnnivCompose(true, null);
        setAnnivMsg("");
      });
    }
    const unpin = document.getElementById("btnAnnivUnpin");
    if (unpin) unpin.addEventListener("click", () => setPinnedAnniv(""));
    const saveAnniv = document.getElementById("btnAnnivSave");
    if (saveAnniv) saveAnniv.addEventListener("click", () => saveAnnivCompose());
    const cancelAnniv = document.getElementById("btnAnnivCancel");
    if (cancelAnniv) {
      cancelAnniv.addEventListener("click", () => {
        showAnnivCompose(false);
        setAnnivMsg("");
      });
    }
    bindDateInputs();
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  function onShow(name) {
    if (name === "cal") refreshHub();
    else if (name === "cal-agenda") refreshAgenda();
    else if (name === "cal-anniv") refreshAnniv();
    else if (name === "cal-propose") paintProposeList();
  }

  global.CalApp = {
    mount: mount,
    refreshView: refreshCalView,
    onShow: onShow,
    openDay: openDay,
    fetchEvents: fetchCalEvents,
    fetchNotes: async function fetchNotes(params) {
      const date = params && params.date;
      if (!date) return fetchDayNotes(localDateISO(new Date()));
      return fetchDayNotes(date);
    },
    localDateISO: localDateISO,
  };
})(typeof window !== "undefined" ? window : globalThis);
