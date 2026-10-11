/**
 * 共听骨架前端（连接搁置）。DOM 在共读 pwa；真源本文件。
 */
(function (global) {
  let deps = {
    showView: function () {},
    checkHealth: async function () {},
    loadSettings: async function () {},
    openSettingsSub: null,
    closeSettingsSub: null,
    collapseConn: function () {},
    collapsePersona: function () {},
    collapseMeetDate: function () {},
    collapseAccessGate: function () {},
    collapseAppRegistry: function () {},
    collapseBackup: function () {},
    collapsePhoneLore: function () {},
  };

  let bound = false;
  let session = null;
  let liked = false;
  let shuffleOn = false;
  let repeatOn = false;
  let progressPct = 18;
  let progressTimer = null;

  const PLAY_PATH = "M8 5v14l11-7L8 5z";
  const PAUSE_PATH = "M7 5h3v14H7V5zm7 0h3v14h-3V5z";
  const ASSET = "/assets/colisten/";

  function applyHealth(flag) {
    const val = document.getElementById("appleMusicVal");
    if (val) {
      val.textContent =
        flag === "shelved" || !flag ? "搁置" : flag === "authorized" ? "已授权" : "待接";
    }
  }

  function collapse() {
    if (typeof deps.closeSettingsSub === "function") {
      const panel = document.getElementById("appleMusicPanel");
      if (panel && panel.classList.contains("open")) {
        deps.closeSettingsSub();
        return;
      }
    }
    const panel = document.getElementById("appleMusicPanel");
    const row = document.getElementById("rowAppleMusic");
    if (panel) panel.classList.remove("open");
    if (row) row.classList.remove("open");
  }

  function expand() {
    const msg = document.getElementById("appleMusicMsg");
    if (msg) {
      msg.textContent = "";
      msg.className = "save-msg";
    }
    applyHealth("shelved");
    if (typeof deps.openSettingsSub === "function") {
      deps.openSettingsSub("apple", "Apple Music", "appleMusicPanel");
      return;
    }
    deps.collapseConn();
    deps.collapsePersona();
    deps.collapseMeetDate();
    deps.collapseAccessGate();
    deps.collapseAppRegistry();
    deps.collapseBackup();
    deps.collapsePhoneLore();
    document.getElementById("appleMusicPanel").classList.add("open");
    document.getElementById("rowAppleMusic").classList.add("open");
  }

  function toggle() {
    if (document.getElementById("appleMusicPanel").classList.contains("open")) {
      collapse();
    } else expand();
  }

  async function loadAuth() {
    try {
      const res = await fetch("/api/v1/listen/auth", { cache: "no-store" });
      if (!res.ok) throw new Error("http");
      const data = await res.json();
      applyHealth(data.apple_music || "shelved");
      return data;
    } catch (_) {
      applyHealth("shelved");
      return null;
    }
  }

  function setProgress(pct) {
    progressPct = Math.max(0, Math.min(100, pct));
    const fill = document.getElementById("colistenProgressFill");
    const thumb = document.getElementById("colistenProgressThumb");
    const bar = document.getElementById("colistenProgress");
    if (fill) fill.style.width = progressPct + "%";
    if (thumb) thumb.style.left = progressPct + "%";
    if (bar) bar.setAttribute("aria-valuenow", String(Math.round(progressPct)));
  }

  function stopProgressTick() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function startProgressTick() {
    stopProgressTick();
    progressTimer = setInterval(function () {
      if (!session || !session.playing) return;
      let next = progressPct + 0.35;
      if (next >= 100) next = repeatOn ? 0 : 92;
      setProgress(next);
    }, 400);
  }

  function setPlayIcon(playing) {
    const icon = document.getElementById("colistenPlayIcon");
    const btn = document.getElementById("btnColistenPlayToggle");
    if (icon) {
      const path = icon.querySelector("path");
      if (path) path.setAttribute("d", playing ? PAUSE_PATH : PLAY_PATH);
    }
    if (btn) btn.setAttribute("aria-label", playing ? "暂停" : "播放");
  }

  function paintCover(track) {
    const wrap = document.getElementById("colistenArtWrap");
    const img = document.getElementById("colistenCoverImg");
    if (!wrap || !img) return;
    const cover = track && track.cover ? String(track.cover) : "";
    if (cover) {
      img.src = ASSET + cover;
      wrap.classList.add("has-art");
    } else {
      img.removeAttribute("src");
      wrap.classList.remove("has-art");
    }
  }

  function paintLike(on) {
    liked = !!on;
    const btn = document.getElementById("btnColistenLike");
    if (btn) {
      btn.classList.toggle("on", liked);
      btn.setAttribute("aria-pressed", liked ? "true" : "false");
      btn.textContent = liked ? "♥" : "♡";
    }
  }

  function paintSession(data) {
    const prevId = session && session.track && session.track.id;
    const prevLiked = liked;
    session = data || session;
    if (!session) return;
    const track = session.track || {};
    const title = document.getElementById("colistenTitle");
    const artist = document.getElementById("colistenArtist");
    const hint = document.getElementById("colistenPlayerHint");
    if (title) title.textContent = track.title || "未在播放";
    if (artist) artist.textContent = track.artist || "—";
    paintCover(track);
    paintLike(typeof session.liked === "boolean" ? session.liked : prevLiked);
    setPlayIcon(!!session.playing);
    if (track.id && track.id !== prevId) setProgress(12 + (track.index || 0) * 7);
    if (session.playing) startProgressTick();
    else stopProgressTick();
    if (hint) {
      hint.textContent = session.playing
        ? "mock 播放中 · 连接搁置"
        : "连接搁置 · mock 播控（非 Apple Music）";
    }
    const box = document.getElementById("colistenPropose");
    const ptxt = document.getElementById("colistenProposeText");
    if (box) {
      if (session.proposal && session.proposal.track) {
        box.hidden = false;
        if (ptxt) {
          ptxt.textContent =
            "家机提议：切到「" +
            (session.proposal.track.title || "下一首") +
            "」？";
        }
      } else {
        box.hidden = true;
      }
    }
    paintThread(session.messages || []);
  }

  function fmtHistoryWhen(ts) {
    const d = new Date(Number(ts) || 0);
    if (!d.getTime()) return "";
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return m + "-" + day + " " + hh + ":" + mm;
  }

  function paintHistory(items) {
    const list = document.getElementById("colistenHistoryList");
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "还没有结束过的场次";
      list.append(empty);
      return;
    }
    for (const h of rows) {
      const li = document.createElement("li");
      const title = (h && h.track_title) || "共听";
      const n = Number(h && h.spit_count) || 0;
      li.textContent =
        fmtHistoryWhen(h && h.ended_at) +
        " · " +
        title +
        " · 吐槽 " +
        n;
      list.append(li);
    }
  }

  async function openHistory() {
    const panel = document.getElementById("colistenHistory");
    closePlaylist();
    try {
      const res = await fetch("/api/v1/listen/history", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      paintHistory(data.history);
      if (panel) panel.hidden = false;
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "历史读取失败";
    }
  }

  function closeHistory() {
    const panel = document.getElementById("colistenHistory");
    if (panel) panel.hidden = true;
  }

  function paintPlaylist(tracks, currentId) {
    const list = document.getElementById("colistenPlaylistList");
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(tracks) ? tracks : [];
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "歌单为空";
      list.append(empty);
      return;
    }
    for (const t of rows) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.trackId = t.id || "";
      if (t.id && t.id === currentId) btn.classList.add("on");
      const name = document.createElement("span");
      name.textContent = t.title || t.id || "未命名";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = t.artist || "—";
      btn.append(name, sub);
      btn.addEventListener("click", () => selectTrack(t.id));
      li.append(btn);
      list.append(li);
    }
  }

  function openPlaylist() {
    closeHistory();
    const panel = document.getElementById("colistenPlaylist");
    const tracks =
      (session && session.tracks) ||
      [];
    const cur =
      session && session.track && session.track.id ? session.track.id : "";
    paintPlaylist(tracks, cur);
    if (panel) panel.hidden = false;
  }

  function closePlaylist() {
    const panel = document.getElementById("colistenPlaylist");
    if (panel) panel.hidden = true;
  }

  async function selectTrack(trackId) {
    try {
      paintSession(
        await postJson("/api/v1/listen/control", {
          action: "select",
          trackId: trackId,
        })
      );
      openPlaylist();
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "选曲失败";
    }
  }

  function paintThread(messages) {
    const thread = document.getElementById("colistenSpitThread");
    if (!thread) return;
    thread.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "本场还没有吐槽";
      thread.append(empty);
      return;
    }
    for (const m of messages) {
      const b = document.createElement("div");
      b.className = "bubble" + (m.from === "you" ? " you" : "");
      b.textContent = m.body || "";
      thread.append(b);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  async function refreshSession() {
    const res = await fetch("/api/v1/listen/session", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "http");
    paintSession(data);
    return data;
  }

  async function enterPlayer() {
    try {
      await refreshSession();
      await postJson("/api/v1/listen/engage", {});
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "加载失败";
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "http");
    return data;
  }

  async function control(action) {
    try {
      paintSession(await postJson("/api/v1/listen/control", { action: action }));
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "播控失败";
    }
  }

  async function endPass() {
    try {
      paintSession(await postJson("/api/v1/listen/end", {}));
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = "已结束上一场 · 新场已开";
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "结束失败";
    }
  }

  async function demoPropose() {
    try {
      paintSession(await postJson("/api/v1/listen/proposal", { demo: true }));
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "提议失败";
    }
  }

  async function respondPropose(decision) {
    try {
      paintSession(
        await postJson("/api/v1/listen/proposal", { decision: decision })
      );
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "处理失败";
    }
  }

  async function sendSpit(ev) {
    if (ev) ev.preventDefault();
    const input = document.getElementById("colistenSpitInput");
    const btn = document.getElementById("btnColistenSpit");
    const thread = document.getElementById("colistenSpitThread");
    const body = input ? String(input.value || "").trim() : "";
    if (!body) return;
    if (btn) btn.disabled = true;
    if (input) input.disabled = true;
    let botEl = null;
    const paintFrame = () =>
      new Promise((r) => requestAnimationFrame(() => r()));
    try {
      const res = await fetch("/api/v1/listen/spit", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ body: body }),
      });
      const ctype = String(res.headers.get("content-type") || "");
      if (!res.ok && !ctype.includes("event-stream")) {
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
            bubble.className = "bubble you";
            bubble.textContent = ev.message.body || "";
            thread.append(bubble);
            thread.scrollTop = thread.scrollHeight;
          }
          await paintFrame();
        } else if (ev.type === "bot_start") {
          if (thread) {
            botEl = document.createElement("div");
            botEl.className = "bubble";
            botEl.textContent = "";
            thread.append(botEl);
            thread.scrollTop = thread.scrollHeight;
          }
          await paintFrame();
        } else if (ev.type === "bot_delta" && ev.text) {
          if (!botEl && thread) {
            botEl = document.createElement("div");
            botEl.className = "bubble";
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
          botEl = null;
        } else if (ev.type === "bot_error") {
          if (botEl && !(botEl.textContent || "").trim()) botEl.remove();
          botEl = null;
        } else if (ev.type === "done") {
          if (Array.isArray(ev.messages)) {
            paintSession(ev);
          } else {
            try {
              await refreshSession();
            } catch (_) {}
          }
          if (ev.bot_error && ev.bot_error.fallback !== "mock_stream") {
            const hint = document.getElementById("colistenPlayerHint");
            if (hint) {
              hint.textContent =
                ev.bot_error.code === "budget_exhausted"
                  ? ev.bot_error.message || "本场额度已用尽 · 你侧已留下"
                  : "家机未接上：" +
                    (ev.bot_error.message || ev.bot_error.code || "");
            }
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
          let evObj;
          try {
            evObj = JSON.parse(raw);
          } catch {
            continue;
          }
          await handleEvent(evObj);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() || "";
        for (const part of parts) await consumeBlock(part);
      }
      if (buf.trim()) await consumeBlock(buf);
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "发送失败";
    } finally {
      if (btn) btn.disabled = false;
      if (input) {
        input.disabled = false;
        input.focus();
      }
    }
  }

  async function toggleLike() {
    const trackId =
      session && session.track && session.track.id ? session.track.id : "";
    try {
      paintSession(
        await postJson("/api/v1/listen/favorite", { trackId: trackId })
      );
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "收藏失败";
    }
  }

  function toggleFlag(kind) {
    if (kind === "shuffle") {
      shuffleOn = !shuffleOn;
      const btn = document.getElementById("btnColistenShuffle");
      if (btn) {
        btn.classList.toggle("on", shuffleOn);
        btn.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
      }
    } else {
      repeatOn = !repeatOn;
      const btn = document.getElementById("btnColistenRepeat");
      if (btn) {
        btn.classList.toggle("on", repeatOn);
        btn.setAttribute("aria-pressed", repeatOn ? "true" : "false");
      }
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const back = document.getElementById("btnColistenBack");
    if (back) back.addEventListener("click", () => deps.showView("home"));
    const playToggle = document.getElementById("btnColistenPlayToggle");
    if (playToggle) {
      playToggle.addEventListener("click", () =>
        control(session && session.playing ? "pause" : "play")
      );
    }
    const prev = document.getElementById("btnColistenPrev");
    const next = document.getElementById("btnColistenNext");
    if (prev) prev.addEventListener("click", () => control("prev"));
    if (next) next.addEventListener("click", () => control("next"));
    const like = document.getElementById("btnColistenLike");
    if (like) like.addEventListener("click", toggleLike);
    const shuffle = document.getElementById("btnColistenShuffle");
    if (shuffle) shuffle.addEventListener("click", () => toggleFlag("shuffle"));
    const repeat = document.getElementById("btnColistenRepeat");
    if (repeat) repeat.addEventListener("click", () => toggleFlag("repeat"));
    const plusMenu = document.getElementById("colistenPlusMenu");
    const plusBtn = document.getElementById("btnColistenPlus");
    function closePlusMenu() {
      if (plusMenu) plusMenu.hidden = true;
      if (plusBtn) plusBtn.setAttribute("aria-expanded", "false");
    }
    function togglePlusMenu() {
      if (!plusMenu) return;
      const open = plusMenu.hidden;
      plusMenu.hidden = !open;
      if (plusBtn) plusBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (plusBtn) plusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlusMenu();
    });
    const end = document.getElementById("btnColistenEnd");
    if (end) {
      end.addEventListener("click", () => {
        closePlusMenu();
        endPass();
      });
    }
    const histBtn = document.getElementById("btnColistenHistory");
    if (histBtn) {
      histBtn.addEventListener("click", () => {
        closePlusMenu();
        openHistory();
      });
    }
    const histClose = document.getElementById("btnColistenHistoryClose");
    if (histClose) histClose.addEventListener("click", closeHistory);
    const playBtn = document.getElementById("btnColistenPlaylist");
    if (playBtn) {
      playBtn.addEventListener("click", () => {
        closePlusMenu();
        openPlaylist();
      });
    }
    const playClose = document.getElementById("btnColistenPlaylistClose");
    if (playClose) playClose.addEventListener("click", closePlaylist);
    const demo = document.getElementById("btnColistenDemoPropose");
    if (demo) {
      demo.addEventListener("click", () => {
        closePlusMenu();
        demoPropose();
      });
    }
    const ok = document.getElementById("btnColistenProposeOk");
    const no = document.getElementById("btnColistenProposeNo");
    if (ok) ok.addEventListener("click", () => respondPropose("confirm"));
    if (no) no.addEventListener("click", () => respondPropose("ignore"));
    const form = document.getElementById("colistenSpitForm");
    if (form) form.addEventListener("submit", sendSpit);
    document.addEventListener("click", (e) => {
      if (!plusMenu || plusMenu.hidden) return;
      const t = e.target;
      if (plusMenu.contains(t) || (plusBtn && plusBtn.contains(t))) return;
      closePlusMenu();
    });
    const row = document.getElementById("rowAppleMusic");
    if (row) row.addEventListener("click", toggle);
    const close = document.getElementById("btnCloseAppleMusic");
    if (close) close.addEventListener("click", collapse);
    const panel = document.getElementById("appleMusicPanel");
    if (panel) panel.addEventListener("click", (e) => e.stopPropagation());
    setProgress(progressPct);
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
    loadAuth();
  }

  global.ColistenApp = {
    mount: mount,
    applyHealth: applyHealth,
    enterPlayer: enterPlayer,
    collapse: collapse,
    expand: expand,
    loadAuth: loadAuth,
  };
})(typeof window !== "undefined" ? window : globalThis);
