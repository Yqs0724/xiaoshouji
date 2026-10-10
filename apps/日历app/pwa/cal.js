/**
 * 日历 App 前端。DOM 由壳注入 view.html；真源本文件。
 */
(function (global) {
  let deps = {
    showView: function () {},
    onCalendarChanged: function () {},
  };

  let bound = false;
  let calCursor = new Date();
  let calSelected = localDateISO(new Date());
  let calMonthDots = new Set();

  function localDateISO(d) {
    const x = d instanceof Date ? d : new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const day = String(x.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
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
      b.addEventListener("click", () => {
        calSelected = iso;
        paintCalGrid();
        renderCalDayList();
      });
      grid.append(b);
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
    if (head) head.textContent = calSelected + "（现实日）";
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
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = ev.title;
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = "你";
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
            await refreshCalView();
            deps.onCalendarChanged();
          } catch (e) {
            setCalMsg((e && e.message) || "删除失败", "bad");
          }
        });
        li.append(t, chip, del);
        list.append(li);
      }
    } catch (e) {
      const p = document.createElement("div");
      p.className = "cal-empty";
      p.textContent = (e && e.message) || "加载失败";
      list.append(p);
    }
  }

  async function refreshCalView() {
    await loadCalMonthDots();
    await renderCalDayList();
  }

  async function addCalEvent() {
    const input = document.getElementById("calNewTitle");
    const title = input ? String(input.value || "").trim() : "";
    if (!title) {
      setCalMsg("先写一点安排再添加", "bad");
      return;
    }
    setCalMsg("保存中…");
    try {
      const res = await fetch("/api/v1/cal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ title: title, date: calSelected }),
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
      setCalMsg("已添加", "ok");
      await refreshCalView();
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
    const prev = document.getElementById("btnCalPrev");
    const next = document.getElementById("btnCalNext");
    if (prev) {
      prev.addEventListener("click", () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
        refreshCalView();
      });
    }
    if (next) {
      next.addEventListener("click", () => {
        calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
        refreshCalView();
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
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  global.CalApp = {
    mount: mount,
    refreshView: refreshCalView,
    fetchEvents: fetchCalEvents,
    localDateISO: localDateISO,
  };
})(typeof window !== "undefined" ? window : globalThis);
