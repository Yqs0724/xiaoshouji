/**
 * 共看 App 前端。DOM 由壳注入 view.html / view-play.html；真源本文件。
 */
(function (global) {
  let deps = {
    showView: function () {},
  };

  let bound = false;

function setCowatchMsg(text, kind) {
  const el = document.getElementById("cowatchMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "cw-msg" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : "");
}

function formatWatchBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

let cowatchPlayTitleId = "";
let cowatchBudgetTokens = 0;
let cowatchTokensUsed = 0;
let cowatchFs = false;
let cowatchDmLane = 0;
const COWATCH_RMB_PER_M = 2.5;

function clearCowatchDanmaku() {
  const layer = document.getElementById("cowatchDanmaku");
  if (layer) layer.replaceChildren();
}

function spawnCowatchDanmaku(text, from) {
  const layer = document.getElementById("cowatchDanmaku");
  if (!layer || !cowatchFs) return;
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return;
  const el = document.createElement("div");
  el.className = "dm " + (from === "bot" ? "bot" : "you");
  el.textContent = t.length > 60 ? t.slice(0, 60) + "…" : t;
  const lane = cowatchDmLane % 7;
  cowatchDmLane += 1;
  el.style.top = 10 + lane * 11 + "%";
  el.style.animationDuration = 7.5 + (lane % 3) * 1.2 + "s";
  layer.append(el);
  el.addEventListener("animationend", () => el.remove());
}

function setCowatchFullscreen(on) {
  cowatchFs = !!on;
  const view = document.getElementById("view-cowatch-play");
  const btn = document.getElementById("btnCowatchFs");
  if (view) view.classList.toggle("fs", cowatchFs);
  if (btn) {
    btn.textContent = cowatchFs ? "退出全屏" : "全屏";
    btn.title = cowatchFs ? "退出全屏回分屏" : "全屏弹幕";
  }
  if (!cowatchFs) {
    clearCowatchDanmaku();
    return;
  }
  clearCowatchDanmaku();
  const thread = document.getElementById("cowatchSpitThread");
  if (!thread) return;
  const bubbles = thread.querySelectorAll(".cwp-bubble");
  let i = 0;
  bubbles.forEach((b) => {
    const text = b.textContent || "";
    const from = b.classList.contains("bot") ? "bot" : "you";
    window.setTimeout(() => spawnCowatchDanmaku(text, from), i * 380);
    i += 1;
  });
}

function leaveCowatchPlay() {
  setCowatchFullscreen(false);
  const v = document.getElementById("cowatchVideo");
  if (v) {
    try {
      v.pause();
    } catch (_) {}
    v.removeAttribute("src");
    v.load();
  }
  cowatchPlayTitleId = "";
  cowatchBudgetTokens = 0;
  cowatchTokensUsed = 0;
  closeCowatchPlusSheet();
  const thread = document.getElementById("cowatchSpitThread");
  if (thread) thread.replaceChildren();
}

function cowatchBudgetLabel() {
  const cap = cowatchBudgetTokens;
  const used = cowatchTokensUsed;
  if (cap <= 0) return "本场额度 · 不限";
  if (used >= cap) return "本场额度 · 已用尽（只留你侧）";
  const leftRmb = ((cap - used) / 1e6) * COWATCH_RMB_PER_M;
  return (
    "本场额度 · 还剩约 ¥" +
    (leftRmb < 0.01 ? leftRmb.toFixed(3) : leftRmb.toFixed(2))
  );
}

function paintCowatchBudget(info) {
  if (info && typeof info.budget_tokens === "number") {
    cowatchBudgetTokens = Number(info.budget_tokens) || 0;
  }
  if (info && typeof info.tokens_used === "number") {
    cowatchTokensUsed = Number(info.tokens_used) || 0;
  } else if (info && info.pass) {
    cowatchBudgetTokens = Number(info.pass.budget_tokens) || 0;
    cowatchTokensUsed = Number(info.pass.tokens_used) || 0;
  }
  const status = document.getElementById("cowatchBudgetStatus");
  if (status) status.textContent = cowatchBudgetLabel();
  const plus = document.getElementById("btnCowatchPlus");
  if (plus) {
    const exhausted = cowatchBudgetTokens > 0 && cowatchTokensUsed >= cowatchBudgetTokens;
    plus.title = exhausted ? "本场设置 · 额度已用尽" : "本场设置";
  }
}

function openCowatchPlusSheet() {
  paintCowatchBudget();
  const sheet = document.getElementById("cowatchPlusSheet");
  if (sheet) sheet.classList.add("open");
}

function closeCowatchPlusSheet() {
  const sheet = document.getElementById("cowatchPlusSheet");
  if (sheet) sheet.classList.remove("open");
}

async function setCowatchBudgetRmb(rmb) {
  const tid = cowatchPlayTitleId;
  if (!tid) return;
  try {
    const res = await fetch(
      "/api/v1/watch/titles/" + encodeURIComponent(tid) + "/budget",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rmb: Number(rmb) || 0 }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "改额度失败");
    paintCowatchBudget(data);
    closeCowatchPlusSheet();
  } catch (e) {
    setCowatchMsg((e && e.message) || "改额度失败", "bad");
  }
}

async function endCowatchPass() {
  const tid = cowatchPlayTitleId;
  if (!tid) return;
  if (!window.confirm("结束本场？吐槽会留在旧场，下次进片开新场。")) return;
  const btn = document.getElementById("btnCowatchEnd");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(
      "/api/v1/watch/titles/" + encodeURIComponent(tid) + "/end",
      { method: "POST", credentials: "same-origin" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "结束本场失败");
    leaveCowatchPlay();
    deps.showView("cowatch");
    setCowatchMsg(data.ended ? "本场已结束" : "没有进行中的场", "ok");
    await refreshCowatchList();
  } catch (e) {
    setCowatchMsg((e && e.message) || "结束本场失败", "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function paintCowatchSpit(messages) {
  const thread = document.getElementById("cowatchSpitThread");
  if (!thread) return;
  thread.replaceChildren();
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "本场还没有吐槽 · 与日常聊天分开";
    thread.append(empty);
    return;
  }
  for (const m of list) {
    const bubble = document.createElement("div");
    bubble.className = "cwp-bubble" + (m.from === "bot" ? " bot" : "");
    bubble.textContent = m.body || "";
    thread.append(bubble);
  }
  thread.scrollTop = thread.scrollHeight;
}

async function loadCowatchSpit(titleId) {
  const res = await fetch(
    "/api/v1/watch/titles/" + encodeURIComponent(titleId) + "/spit",
    { credentials: "same-origin" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "加载吐槽失败");
  paintCowatchSpit(data.messages);
  paintCowatchBudget(data);
  return data;
}

async function sendCowatchSpit() {
  const input = document.getElementById("cowatchSpitInput");
  const btn = document.getElementById("btnCowatchSpit");
  const thread = document.getElementById("cowatchSpitThread");
  const body = input ? String(input.value || "").trim() : "";
  if (!body || !cowatchPlayTitleId) return;
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;
  let botEl = null;
  const paintFrame = () =>
    new Promise((r) => requestAnimationFrame(() => r()));
  try {
    const res = await fetch(
      "/api/v1/watch/titles/" + encodeURIComponent(cowatchPlayTitleId) + "/spit",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ body }),
      }
    );
    const ctype = String(res.headers.get("content-type") || "");
    if (!res.ok && !ctype.includes("event-stream") && !ctype.includes("ndjson")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || "发送失败");
    }
    if (input) input.value = "";
    if (!res.body || !res.body.getReader) {
      throw new Error("浏览器不支持流式读取");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const handleEvent = async (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === "you" && ev.message) {
        if (thread) {
          const empty = thread.querySelector(".empty");
          if (empty) empty.remove();
          const bubble = document.createElement("div");
          bubble.className = "cwp-bubble";
          bubble.textContent = ev.message.body || "";
          thread.append(bubble);
          thread.scrollTop = thread.scrollHeight;
        }
        spawnCowatchDanmaku(ev.message.body, "you");
        await paintFrame();
      } else if (ev.type === "bot_start") {
        if (thread) {
          botEl = document.createElement("div");
          botEl.className = "cwp-bubble bot";
          botEl.textContent = "";
          thread.append(botEl);
          thread.scrollTop = thread.scrollHeight;
        }
        await paintFrame();
      } else if (ev.type === "bot_delta" && ev.text) {
        if (!botEl && thread) {
          botEl = document.createElement("div");
          botEl.className = "cwp-bubble bot";
          botEl.textContent = "";
          thread.append(botEl);
        }
        if (botEl) {
          botEl.textContent = (botEl.textContent || "") + ev.text;
          if (thread) thread.scrollTop = thread.scrollHeight;
        }
        await paintFrame();
      } else if (ev.type === "bot_done" && ev.message) {
        if (botEl) botEl.textContent = ev.message.body || botEl.textContent || "";
        spawnCowatchDanmaku(ev.message.body || (botEl && botEl.textContent), "bot");
        botEl = null;
      } else if (ev.type === "bot_error") {
        if (botEl && !(botEl.textContent || "").trim()) botEl.remove();
        botEl = null;
      } else if (ev.type === "done") {
        paintCowatchBudget(ev);
        if (Array.isArray(ev.messages)) paintCowatchSpit(ev.messages);
        if (ev.bot_error && thread) {
          const tip = document.createElement("div");
          tip.className = "empty";
          tip.textContent =
            ev.bot_error.code === "budget_exhausted"
              ? ev.bot_error.message || "本场额度已用尽 · 你侧已留下"
              : "家机未接上：" +
                (ev.bot_error.message || ev.bot_error.code || "降级");
          thread.append(tip);
          thread.scrollTop = thread.scrollHeight;
        }
      }
    };
    const consumeBlock = async (block) => {
      const lines = String(block || "").split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(":")) continue;
        if (!t.startsWith("data:")) continue;
        const raw = t.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        await handleEvent(ev);
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";
      for (const block of parts) await consumeBlock(block);
    }
    if (buf.trim()) await consumeBlock(buf);
  } catch (e) {
    window.alert((e && e.message) || "发送失败");
  } finally {
    if (btn) btn.disabled = false;
    if (input) {
      input.disabled = false;
      input.focus();
    }
  }
}

async function openCowatchPlay(title) {
  if (!title || !title.id) return;
  setCowatchFullscreen(false);
  cowatchPlayTitleId = title.id;
  const nameEl = document.getElementById("cowatchPlayTitle");
  if (nameEl) nameEl.textContent = title.name || "共看";
  const v = document.getElementById("cowatchVideo");
  if (v) {
    v.src = "/api/v1/watch/titles/" + encodeURIComponent(title.id) + "/media";
    try {
      v.load();
    } catch (_) {}
  }
  paintCowatchSpit([]);
  paintCowatchBudget({ budget_tokens: 0, tokens_used: 0 });
  deps.showView("cowatch-play");
  try {
    await loadCowatchSpit(title.id);
  } catch (e) {
    paintCowatchSpit([]);
    paintCowatchBudget({ budget_tokens: 0, tokens_used: 0 });
    const thread = document.getElementById("cowatchSpitThread");
    if (thread) {
      thread.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = (e && e.message) || "吐槽加载失败";
      thread.append(empty);
    }
  }
}

async function openPlayById(titleId) {
  const tid = String(titleId || "").trim();
  if (!tid) {
    deps.showView("cowatch");
    return;
  }
  try {
    const titles = await fetchWatchTitles();
    const hit = titles.find((t) => t && t.id === tid);
    if (hit) await openCowatchPlay(hit);
    else deps.showView("cowatch");
  } catch (_) {
    deps.showView("cowatch");
  }
}

async function fetchWatchTitles() {
  const res = await fetch("/api/v1/watch/titles", { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "加载片库失败");
  return Array.isArray(data.titles) ? data.titles : [];
}

async function refreshCowatchList() {
  const box = document.getElementById("cowatchList");
  if (!box) return;
  box.replaceChildren();
  try {
    const titles = await fetchWatchTitles();
    if (!titles.length) {
      const empty = document.createElement("div");
      empty.className = "cw-empty";
      const img = document.createElement("img");
      img.src = "/assets/cafe/decor-case.png";
      img.alt = "";
      const p = document.createElement("p");
      p.textContent = "片库还空着";
      const hint = document.createElement("p");
      hint.style.margin = "6px 0 0";
      hint.style.fontSize = "12px";
      hint.textContent = "「加入」选文件，或把片放进 media/watch 后点「扫库」";
      empty.append(img, p, hint);
      box.append(empty);
      return;
    }
    for (const t of titles) {
      const row = document.createElement("div");
      row.className = "cw-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const ico = document.createElement("img");
      ico.className = "ico";
      ico.src = "/assets/cafe/decor-case.png";
      ico.alt = "";
      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.name || "未命名";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = formatWatchBytes(t.bytes) + " · 点开播放";
      meta.append(name, sub);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "移除";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!window.confirm("从片库移除「" + (t.name || "") + "」？原片文件也会删掉。")) return;
        try {
          const res = await fetch("/api/v1/watch/titles/" + encodeURIComponent(t.id), {
            method: "DELETE",
            credentials: "same-origin",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || "移除失败");
          setCowatchMsg("已移除", "ok");
          await refreshCowatchList();
        } catch (err) {
          setCowatchMsg((err && err.message) || "移除失败", "bad");
        }
      });
      row.addEventListener("click", () => openCowatchPlay(t));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCowatchPlay(t);
        }
      });
      row.append(ico, meta, del);
      box.append(row);
    }
  } catch (e) {
    const empty = document.createElement("div");
    empty.className = "cw-empty";
    empty.textContent = (e && e.message) || "加载失败";
    box.append(empty);
  }
}

async function uploadCowatchFile(file) {
  if (!file) return;
  const btn = document.getElementById("btnCowatchAdd");
  if (btn) btn.disabled = true;
  setCowatchMsg("正在加入「" + file.name + "」…", "");
  try {
    const res = await fetch(
      "/api/v1/watch/titles?name=" + encodeURIComponent(file.name),
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
        },
        body: file,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "加入失败");
    setCowatchMsg("已加入「" + ((data.title && data.title.name) || file.name) + "」", "ok");
    await refreshCowatchList();
  } catch (e) {
    setCowatchMsg((e && e.message) || "加入失败", "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function scanCowatchLibrary() {
  const btn = document.getElementById("btnCowatchScan");
  const add = document.getElementById("btnCowatchAdd");
  if (btn) btn.disabled = true;
  if (add) add.disabled = true;
  setCowatchMsg("正在扫库…", "");
  try {
    const res = await fetch("/api/v1/watch/titles/scan", {
      method: "POST",
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "扫库失败");
    const n = Array.isArray(data.added) ? data.added.length : 0;
    setCowatchMsg(
      n
        ? "扫到 " + n + " 部新片"
        : data.scanned
          ? "没有新片（已在库 " + (data.skipped || 0) + "）"
          : "片库目录还没有视频",
      "ok"
    );
    await refreshCowatchList();
  } catch (e) {
    setCowatchMsg((e && e.message) || "扫库失败", "bad");
  } finally {
    if (btn) btn.disabled = false;
    if (add) add.disabled = false;
  }
}

function bind() {
  const back = document.getElementById("btnCowatchBack");
  if (back) back.addEventListener("click", () => deps.showView("home"));
  const playBack = document.getElementById("btnCowatchPlayBack");
  if (playBack) {
    playBack.addEventListener("click", () => {
      leaveCowatchPlay();
      deps.showView("cowatch");
    });
  }
  const endBtn = document.getElementById("btnCowatchEnd");
  if (endBtn) endBtn.addEventListener("click", () => endCowatchPass());
  const fsBtn = document.getElementById("btnCowatchFs");
  if (fsBtn) {
    fsBtn.addEventListener("click", () => setCowatchFullscreen(!cowatchFs));
  }
  const plusBtn = document.getElementById("btnCowatchPlus");
  if (plusBtn) plusBtn.addEventListener("click", () => openCowatchPlusSheet());
  const plusCancel = document.getElementById("cowatchPlusCancel");
  if (plusCancel) plusCancel.addEventListener("click", () => closeCowatchPlusSheet());
  const plusSheet = document.getElementById("cowatchPlusSheet");
  if (plusSheet) {
    plusSheet.addEventListener("click", (e) => {
      if (e.target.id === "cowatchPlusSheet") closeCowatchPlusSheet();
    });
    plusSheet.querySelectorAll("[data-cwp-budget]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setCowatchBudgetRmb(btn.getAttribute("data-cwp-budget"));
      });
    });
  }
  const form = document.getElementById("cowatchSpitForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendCowatchSpit();
    });
  }
  const add = document.getElementById("btnCowatchAdd");
  const input = document.getElementById("cowatchFile");
  if (add && input) {
    add.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.value = "";
      if (f) uploadCowatchFile(f);
    });
  }
  const scan = document.getElementById("btnCowatchScan");
  if (scan) scan.addEventListener("click", () => scanCowatchLibrary());
}

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  global.CowatchApp = {
    mount: mount,
    refreshList: refreshCowatchList,
    leavePlay: leaveCowatchPlay,
    openPlayById: openPlayById,
  };
})(typeof window !== "undefined" ? window : globalThis);
