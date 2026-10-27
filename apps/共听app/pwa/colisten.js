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
  /** seq 顺序 | loop 单曲循环 | shuffle 随机 */
  let playMode = "seq";
  let progressPct = 18;
  let progressTimer = null;
  let durationSec = 0;
  /** 网易云真播（共听页点歌）；有值时播控走 audio，不走 mock */
  let liveAudio = null;
  let liveTrack = null;
  let liveCandidates = null;
  let musicVolume = 0.8;
  let queueCursor = -1;
  /** home=找层 | session=播放+吐槽下级 */
  let uiLayer = "home";
  /** library=歌单列表 | playlist=某歌单曲目 | liked=喜欢的歌 */
  let homeLevel = "library";
  /** home | playlists | discover — 底栏三页 */
  let homeTab = "home";
  let dailyCard = null;
  let dailyLoading = false;
  let queueSheetEdit = false;
  let likedCountCache = null;
  let addToSong = null;
  /** 歌单库列表缓存（搜索过滤） */
  let playlistLibCache = [];
  let playlistSearchQ = "";
  let queuePendingCount = 0;
  /** @type {{ id?: number, lines: { t: number, text: string, trans?: string }[], active: number, showTrans: boolean, hasTrans: boolean }} */
  let lyricState = { id: 0, lines: [], active: -1, showTrans: false, hasTrans: false };
  let hotCommentsLoadedFor = "";

  const MODE_LABEL = {
    seq: "顺序播放",
    loop: "单曲循环",
    shuffle: "随机播放",
  };
  const MODE_ICON = {
    /* 顺序：两个并排右箭头 */
    seq: '<path d="M5 5l7 7-7 7"/><path d="M12 5l7 7-7 7"/>',
    loop: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15" text-anchor="middle" fill="currentColor" stroke="none" font-size="8" font-weight="700">1</text>',
    shuffle:
      '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
  };

  const PLAY_PATH = "M8 5v14l11-7L8 5z";
  const PAUSE_PATH = "M7 5h3v14H7V5zm7 0h3v14h-3V5z";
  const ASSET = "/assets/colisten/";

  function toast(msg) {
    try {
      if (typeof global.shellToast === "function") global.shellToast(msg);
    } catch (_) {}
  }

  /** 慢请求：持续提醒等待，勿一上来就「失败」 */
  async function waitAwareFetch(url, fetchOpts, onTick, tips) {
    const lines = Array.isArray(tips) && tips.length
      ? tips
      : [
          "正在连接…",
          "还在加载，请稍候…",
          "家机还在忙，请再等等…",
          "可能要一两分钟，别离开本页…",
          "仍在等待 · 网络慢时会更久…",
        ];
    let i = 0;
    if (typeof onTick === "function") onTick(lines[0], 0);
    /* 2.5s 换一句，让「连接过程」肉眼可见，避免秒失败时像没走过等待 */
    const timer = setInterval(() => {
      i += 1;
      if (typeof onTick === "function") {
        onTick(lines[Math.min(i, lines.length - 1)], i);
      }
    }, 2500);
    try {
      return await fetch(url, fetchOpts);
    } finally {
      clearInterval(timer);
    }
  }

  function paintWaitCell(listEl, main, sub, opts) {
    if (!listEl) return;
    const err = !!(opts && opts.error);
    listEl.replaceChildren();
    const li = document.createElement("li");
    li.className = "empty cl-wait" + (err ? " is-err" : "");
    if (!err) {
      const pulse = document.createElement("span");
      pulse.className = "cl-wait-pulse";
      pulse.setAttribute("aria-hidden", "true");
      li.append(pulse);
    }
    const a = document.createElement("span");
    a.textContent = main || (err ? "失败" : "请稍候…");
    li.append(a);
    if (sub) {
      const b = document.createElement("span");
      b.className = "cl-wait-sub";
      b.textContent = sub;
      li.append(b);
    }
    listEl.append(li);
  }

  const SVG_PLAY_NEXT =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 4.2v15.6l11.2-7.8L5 4.2z"/><rect fill="currentColor" x="17.6" y="4.2" width="2.4" height="15.6" rx="0.7"/></svg>';

  /** 找层曲目行：封面 + 文案 + 下一首 +「＋加入歌单」；点行加入歌单，长按立即播 */
  function makeSongRow(song, opts) {
    const o = opts || {};
    const row = document.createElement("div");
    row.className = "cl-song-row" + (o.on ? " on" : "");
    const cover = document.createElement("div");
    cover.className = "cl-song-cover";
    const src = String((song && (song.cover || song.picUrl)) || "").trim();
    if (src && /^https?:\/\//i.test(src)) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      cover.append(img);
    } else {
      cover.textContent = "♪";
    }
    const meta = document.createElement("button");
    meta.type = "button";
    meta.className = "cl-song-meta";
    const title = document.createElement("span");
    title.textContent = o.title || (song && (song.name || song.title)) || "未命名";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = o.sub || (song && song.artist) || "—";
    meta.append(title, sub);
    let holdTimer = null;
    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const doAdd =
      typeof o.onAdd === "function"
        ? () => o.onAdd(song)
        : () => openAddToPlaylist(song);
    meta.addEventListener("click", doAdd);
    meta.addEventListener("pointerdown", () => {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (typeof o.onPlay === "function") o.onPlay(song);
      }, 550);
    });
    meta.addEventListener("pointerup", clearHold);
    meta.addEventListener("pointerleave", clearHold);
    meta.addEventListener("pointercancel", clearHold);
    const acts = document.createElement("div");
    acts.className = "cl-song-acts";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "cl-song-next";
    next.title = "下一首播放";
    next.setAttribute("aria-label", "下一首播放");
    next.innerHTML = SVG_PLAY_NEXT;
    next.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof o.onNext === "function") o.onNext(song);
      else enqueuePlayNext(song);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "cl-song-add";
    add.title = "加入歌单";
    add.setAttribute("aria-label", "加入歌单");
    add.textContent = "＋";
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      doAdd();
    });
    acts.append(next, add);
    row.append(cover, meta, acts);
    if (o.extra) {
      const wrap = document.createElement("div");
      wrap.append(row, o.extra);
      return wrap;
    }
    return row;
  }

  /** Cove A：后端 error → 可见句 */
  function explainMusicError(code, fallback) {
    const c = String(code || "").trim();
    const map = {
      MUSIC_NO_AUDIO: "没有可播音源（会员/版权/需扫码登录）",
      MUSIC_TRIAL_ONLY: "只有试听片段，整曲需会员或重新扫码",
      MUSIC_NOT_FOUND: "歌曲不存在或已下架",
      MUSIC_NO_MATCH: "没有找到匹配歌曲",
      netease_unreachable: "连不上网易云 API，请先启动本机 :3000",
      netease_timeout: "网易云 API 超时",
      proxy_failed: "音源代理失败，请检查网络",
      upstream_audio: "上游音源不可用，可换一首",
    };
    if (map[c]) return map[c];
    const msg = String(fallback || "").trim();
    return msg ? msg.slice(0, 120) : "播放失败";
  }

  async function probeStreamMessage(path) {
    try {
      const res = await fetch(path, {
        method: "GET",
        credentials: "same-origin",
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
      });
      if (res.ok || res.status === 206) return null;
      const ct = String(res.headers.get("content-type") || "");
      if (ct.includes("json")) {
        const data = await res.json().catch(() => ({}));
        return explainMusicError(data.error, data.message);
      }
      return "音源不可用（HTTP " + res.status + "）";
    } catch (_) {
      return "网络失败，连不上音源";
    }
  }

  function fmtTime(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(n / 60);
    const s = n % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function setTimeLabels(cur, dur) {
    const curEl = document.getElementById("colistenTimeCur");
    const durEl = document.getElementById("colistenTimeDur");
    if (curEl) curEl.textContent = fmtTime(cur);
    if (durEl) {
      if (dur && Number.isFinite(dur) && dur > 0) {
        durationSec = dur;
        durEl.textContent = fmtTime(dur);
      } else if (!durationSec) {
        durEl.textContent = "—:—";
      }
    }
  }

  function setCoverArt(cover) {
    const wrap = document.getElementById("colistenArtWrap");
    const img = document.getElementById("colistenCoverImg");
    if (!wrap || !img) return;
    const src = String(cover || "").trim();
    if (src && /^https?:\/\//i.test(src)) {
      img.src = src;
      wrap.classList.add("has-art");
      return;
    }
    if (src && !src.includes("://") && !src.startsWith("/")) {
      img.src = ASSET + src;
      wrap.classList.add("has-art");
      return;
    }
    if (src.startsWith("/")) {
      img.src = src;
      wrap.classList.add("has-art");
      return;
    }
    img.removeAttribute("src");
    wrap.classList.remove("has-art");
  }

  async function enrichNeteaseTrack(track) {
    if (!track || !track.id) return track;
    if (track.cover && track.duration_ms) return track;
    try {
      const res = await fetch(
        "/api/v1/music/song/netease/" + encodeURIComponent(track.id),
        { cache: "no-store", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.song) return track;
      return {
        ...track,
        cover: track.cover || data.song.cover,
        duration_ms: track.duration_ms || data.song.duration_ms,
        album: track.album || data.song.album,
        name: track.name || data.song.name,
        artist: track.artist || data.song.artist,
      };
    } catch (_) {
      return track;
    }
  }

  function applyMusicVolume(audio) {
    const a = audio || liveAudio;
    if (global.CovePlayer) {
      global.CovePlayer.applyVolume(musicVolume);
      try {
        global.__ariadneMusicVol = musicVolume;
      } catch (_) {}
      return;
    }
    if (!a) return;
    try {
      a.volume = Math.max(0, Math.min(1, musicVolume));
    } catch (_) {}
  }

  let liveAudioBound = false;

  function ensureLiveAudio() {
    if (global.CovePlayer) {
      liveAudio = global.CovePlayer.getAudio();
      applyMusicVolume(liveAudio);
      if (!liveAudioBound) {
        liveAudioBound = true;
        global.CovePlayer.on("timeupdate", syncLiveProgress);
        global.CovePlayer.on("meta", () => {
          if (liveAudio && liveAudio.duration && Number.isFinite(liveAudio.duration)) {
            setTimeLabels(liveAudio.currentTime || 0, liveAudio.duration);
          }
        });
        global.CovePlayer.on("ended", onLiveEnded);
        global.CovePlayer.on("state", () => {
          setPlayIcon(!!(liveAudio && !liveAudio.paused));
          paintMini();
        });
        global.CovePlayer.on("error", async () => {
          const path = liveAudio && liveAudio.getAttribute("src");
          const msg = path
            ? (await probeStreamMessage(path)) || "播放失败"
            : "播放失败";
          const hint = document.getElementById("colistenPlayerHint");
          if (hint) hint.textContent = msg;
          toast(msg);
          setPlayIcon(false);
        });
        global.CovePlayer.on("local-play", (snap) => {
          if (!snap || !snap.track || snap.owner === "colisten") return;
          adoptExternalTrack(snap.track);
        });
        global.CovePlayer.on("remote-takeover", (snap) => {
          if (snap && snap.track) adoptExternalTrack(snap.track);
          setPlayIcon(false);
        });
      }
      return liveAudio;
    }
    if (!liveAudio) {
      liveAudio = new Audio();
      liveAudio.preload = "auto";
      applyMusicVolume(liveAudio);
      liveAudio.addEventListener("timeupdate", syncLiveProgress);
      liveAudio.addEventListener("loadedmetadata", () => {
        if (liveAudio && liveAudio.duration && Number.isFinite(liveAudio.duration)) {
          setTimeLabels(liveAudio.currentTime || 0, liveAudio.duration);
        }
      });
      liveAudio.addEventListener("ended", onLiveEnded);
      liveAudio.addEventListener("play", () => setPlayIcon(true));
      liveAudio.addEventListener("pause", () => setPlayIcon(false));
      liveAudio.addEventListener("error", async () => {
        const path = liveAudio && liveAudio.getAttribute("src");
        const msg = path
          ? (await probeStreamMessage(path)) || "播放失败"
          : "播放失败";
        const hint = document.getElementById("colistenPlayerHint");
        if (hint) hint.textContent = msg;
        toast(msg);
        setPlayIcon(false);
      });
    }
    return liveAudio;
  }

  function adoptExternalTrack(raw) {
    if (!raw) return;
    liveTrack = {
      provider: raw.provider || "netease",
      id: raw.id,
      name: raw.name || raw.title,
      artist: raw.artist,
      cover: raw.cover || raw.picUrl,
      duration_ms: raw.duration_ms,
      stream_path:
        raw.stream_path ||
        (raw.provider === "netease" && raw.id
          ? "/api/v1/music/stream/netease/" + raw.id
          : ""),
      apple_url: raw.apple_url,
      preview_url: raw.preview_url,
    };
    paintLiveTrack(liveTrack);
  }

  function paintLyricPreview(idx) {
    const a = document.getElementById("colistenLyLine0");
    const b = document.getElementById("colistenLyLine1");
    const lines = lyricState.lines;
    if (!a || !b) return;
    if (!lines.length) {
      a.textContent = "暂无歌词";
      a.classList.add("on");
      b.textContent = " ";
      b.classList.remove("on");
      return;
    }
    const i = Math.max(0, Math.min(idx, lines.length - 1));
    a.textContent = lines[i].text || " ";
    a.classList.add("on");
    if (i + 1 < lines.length) {
      b.textContent = lines[i + 1].text || " ";
      b.classList.remove("on");
    } else {
      b.textContent = " ";
      b.classList.remove("on");
    }
  }

  function isLyricMode() {
    const sess = document.getElementById("colistenSession");
    return !!(sess && sess.classList.contains("cl-lyric-mode"));
  }

  function highlightLyricAt(sec) {
    const lines = lyricState.lines;
    if (!lines.length) return;
    const t = Number(sec) || 0;
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const lt = Number(lines[i].t);
      if (Number.isFinite(lt) && lt <= t) idx = i;
      else if (Number.isFinite(lt) && lt > t) break;
    }
    if (idx === lyricState.active) return;
    lyricState.active = idx;
    paintLyricPreview(idx);
    const list = document.getElementById("colistenLyricsList");
    if (!list) return;
    const nodes = list.querySelectorAll("li:not(.cl-lyrics-empty)");
    nodes.forEach((el, i) => {
      el.classList.toggle("on", i === idx);
    });
    if (!isLyricMode() || list.hidden) return;
    const on = nodes[idx];
    if (on && typeof on.scrollIntoView === "function") {
      try {
        on.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {
        on.scrollIntoView(false);
      }
    }
  }

  async function sendLyricToChat(lineText) {
    const text = String(lineText || "").trim();
    if (!text) return;
    const track = liveTrack || {};
    const id = track.id != null ? Math.floor(Number(track.id)) : 0;
    const name = String(track.name || track.title || "").trim() || "共听";
    try {
      const res = await fetch("/api/v1/chat/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "music",
          name: text.slice(0, 80),
          artist: name,
          provider: track.provider || "netease",
          id: id || undefined,
          stream_path:
            track.stream_path ||
            (id ? "/api/v1/music/stream/netease/" + id : undefined),
          cover: track.cover,
          lyric_share: true,
          noreply: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "发送失败");
      toast("已发到聊天 · 点卡片可回共听");
    } catch (e) {
      toast((e && e.message) || "发到聊天失败");
    }
  }

  function paintLyricTransBtn() {
    const btn = document.getElementById("btnColistenLyricTrans");
    if (!btn) return;
    const has = !!lyricState.hasTrans;
    btn.hidden = !has;
    btn.setAttribute("aria-pressed", lyricState.showTrans ? "true" : "false");
    btn.classList.toggle("on", !!lyricState.showTrans);
    btn.title = lyricState.showTrans ? "隐藏翻译" : "显示翻译";
    btn.textContent = "译";
  }

  function paintLyrics(lines, tipText) {
    const wrap = document.getElementById("colistenLyrics");
    const list = document.getElementById("colistenLyricsList");
    const tip = document.getElementById("colistenLyricsTip");
    if (!wrap || !list) return;
    wrap.hidden = false;
    list.replaceChildren();
    lyricState.lines = Array.isArray(lines) ? lines : [];
    lyricState.active = -1;
    const hadTrans = !!lyricState.hasTrans;
    lyricState.hasTrans = lyricState.lines.some(
      (x) => x && String(x.trans || "").trim()
    );
    if (!lyricState.hasTrans) lyricState.showTrans = false;
    else if (!hadTrans) lyricState.showTrans = true; /* 有效果图：默认双语 */
    paintLyricTransBtn();
    if (tip) {
      tip.textContent = tipText ||
        (lyricState.lines.length ? "长按一句发到聊天" : "暂无歌词");
    }
    if (!lyricState.lines.length) {
      const empty = document.createElement("li");
      empty.className = "cl-lyrics-empty";
      empty.textContent = tipText || "这首暂时没有歌词";
      list.append(empty);
      paintLyricPreview(-1);
      const a = document.getElementById("colistenLyLine0");
      if (a) a.textContent = tipText || "暂无歌词";
      return;
    }
    const showTrans = !!lyricState.showTrans;
    for (const row of lyricState.lines) {
      const li = document.createElement("li");
      const main = document.createElement("span");
      main.className = "cl-ly-main";
      main.textContent = row.text;
      li.append(main);
      if (showTrans && row.trans) {
        const tr = document.createElement("span");
        tr.className = "cl-ly-trans";
        tr.textContent = row.trans;
        li.append(tr);
      }
      let holdTimer = null;
      li.addEventListener("pointerdown", () => {
        holdTimer = setTimeout(() => {
          holdTimer = null;
          const share =
            showTrans && row.trans
              ? row.text + "\n" + row.trans
              : row.text;
          sendLyricToChat(share);
        }, 520);
      });
      const clearHold = () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      };
      li.addEventListener("pointerup", clearHold);
      li.addEventListener("pointerleave", clearHold);
      li.addEventListener("pointercancel", clearHold);
      list.append(li);
    }
    lyricState.active = -1;
    const a = liveAudio;
    highlightLyricAt(a && Number.isFinite(a.currentTime) ? a.currentTime : 0);
    if (lyricState.active < 0) {
      paintLyricPreview(0);
      lyricState.active = 0;
      const first = list.querySelector("li:not(.cl-lyrics-empty)");
      if (first) first.classList.add("on");
    }
  }

  function toggleLyricTrans() {
    if (!lyricState.hasTrans) {
      toast("这首没有翻译");
      return;
    }
    const keep = lyricState.active;
    lyricState.showTrans = !lyricState.showTrans;
    const tip = document.getElementById("colistenLyricsTip");
    paintLyrics(
      lyricState.lines,
      tip ? tip.textContent : "长按一句发到聊天"
    );
    if (keep >= 0) {
      lyricState.active = -1;
      const a = liveAudio;
      highlightLyricAt(a && Number.isFinite(a.currentTime) ? a.currentTime : 0);
      if (lyricState.active < 0 && lyricState.lines.length) {
        lyricState.active = Math.min(keep, lyricState.lines.length - 1);
        paintLyricPreview(lyricState.active);
        const list = document.getElementById("colistenLyricsList");
        const nodes = list && list.querySelectorAll("li");
        if (nodes) {
          nodes.forEach((el, i) =>
            el.classList.toggle("on", i === lyricState.active)
          );
        }
      }
    }
  }

  async function loadLyricsForTrack(track) {
    if (!track || !(track.name || track.title || track.id)) {
      paintLyrics([], "还没有在播的歌");
      return;
    }
    if (!track.id || String(track.provider || "netease") !== "netease") {
      paintLyrics([], "当前曲没有歌词源");
      return;
    }
    const sid = Math.floor(Number(track.id));
    if (!Number.isFinite(sid) || sid <= 0) {
      paintLyrics([], "当前曲没有歌词源");
      return;
    }
    if (lyricState.id === sid && lyricState.lines.length) {
      paintLyrics(lyricState.lines, "长按一句发到聊天");
      return;
    }
    paintLyrics([], "加载歌词…");
    try {
      const res = await fetch(
        "/api/v1/music/lyric/netease/" + sid,
        { cache: "no-store", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      lyricState.id = sid;
      lyricState.hasTrans = false; /* 换歌后 paint 会按有译默认开双语 */
      if (!res.ok) {
        paintLyrics([], (data && data.message) || "歌词读取失败");
        return;
      }
      const lines = Array.isArray(data.lines) ? data.lines : [];
      if (!lines.length) {
        paintLyrics([], "暂无歌词");
        return;
      }
      /* 服务端没挂 trans 时，本地再对一下 tlyric */
      if (!lines.some((x) => x && x.trans) && data.tlyric) {
        const tre =
          /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]([^\n\r]*)/g;
        const tmap = new Map();
        let m;
        while ((m = tre.exec(String(data.tlyric)))) {
          const t =
            (Number(m[1]) || 0) * 60 +
            (Number(m[2]) || 0) +
            (m[3]
              ? Number(String(m[3]).padEnd(3, "0").slice(0, 3)) / 1000
              : 0);
          const text = String(m[4] || "").trim();
          if (text) tmap.set(Math.round(t * 10), text);
        }
        for (const row of lines) {
          const key = Math.round(Number(row.t) * 10);
          row.trans =
            tmap.get(key) || tmap.get(key - 1) || tmap.get(key + 1) || "";
        }
      }
      paintLyrics(lines, "长按一句发到聊天");
    } catch (_) {
      lyricState.id = sid;
      paintLyrics([], "歌词读取失败");
    }
  }

  function paintHotComments(comments) {
    const entry = document.getElementById("btnColistenOpenComments");
    const countEl = document.getElementById("colistenCommentsCount");
    const list = document.getElementById("colistenHotList");
    const title = document.getElementById("colistenCommentSheetTitle");
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(comments) ? comments : [];
    if (entry) entry.hidden = !rows.length;
    if (countEl) countEl.textContent = rows.length ? String(rows.length) : "";
    if (title) {
      const song = liveTrack && (liveTrack.name || liveTrack.title);
      title.textContent = song
        ? String(song).slice(0, 28) + " · 评论区"
        : "评论区";
    }
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "cl-comments-empty";
      empty.textContent = "这首还没有评论";
      list.append(empty);
      return;
    }
    for (const c of rows) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = c.nickname || "网友";
      const likes = Math.max(0, Math.floor(Number(c.liked_count) || 0));
      if (likes > 0) {
        const hot = document.createElement("span");
        hot.className = "hot";
        hot.textContent = "热评";
        who.append(" ", hot);
      }
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = c.content || "";
      li.append(who, txt);
      if (likes > 0) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = "♥ " + likes;
        li.append(meta);
      }
      list.append(li);
    }
  }

  async function loadHotCommentsForTrack(track) {
    if (!track || !track.id || String(track.provider || "netease") !== "netease") {
      paintHotComments([]);
      return;
    }
    const sid = String(track.id);
    if (hotCommentsLoadedFor === sid) return;
    try {
      const res = await fetch(
        "/api/v1/music/comments/netease/" + encodeURIComponent(sid) + "?limit=20",
        { cache: "no-store", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "热评失败");
      hotCommentsLoadedFor = sid;
      paintHotComments(Array.isArray(data.comments) ? data.comments : []);
    } catch (_) {
      hotCommentsLoadedFor = sid;
      paintHotComments([]);
    }
  }

  function syncLiveProgress() {
    if (seekDragging) return;
    if (global.CovePlayer) {
      try {
        const a0 = global.CovePlayer.getAudio();
        if (a0) liveAudio = a0;
      } catch (_) {}
    }
    const a = liveAudio;
    if (!a) return;
    const cur = Number(a.currentTime) || 0;
    if (a.duration && Number.isFinite(a.duration) && a.duration > 0) {
      setProgress((cur / a.duration) * 100);
      setTimeLabels(cur, a.duration);
    }
    highlightLyricAt(cur);
  }

  function requestTrackShare(song) {
    const s = song || liveTrack;
    if (!s || !(s.name || s.title || s.id)) return Promise.resolve();
    return fetch("/api/v1/listen/track-share", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song: {
          provider: s.provider || "netease",
          id: s.id,
          name: s.name || s.title,
          title: s.name || s.title,
          artist: s.artist,
          cover: s.cover,
          stream_path: s.stream_path,
        },
      }),
    })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (data && data.message && Array.isArray(data.messages)) {
          paintSession(data);
        } else if (data && data.message) {
          const thread = document.getElementById("colistenSpitThread");
          if (!thread) return;
          const empty = thread.querySelector(".empty");
          if (empty) empty.remove();
          const b = document.createElement("div");
          b.className = "bubble";
          b.textContent = data.message.body || "";
          thread.append(b);
          thread.scrollTop = thread.scrollHeight;
        }
      })
      .catch(() => {});
  }

  function postCoveEvent(event_type, song, note) {
    const s = song || liveTrack;
    const body = {
      event_type: event_type,
      actor: "user",
      note: note || "",
    };
    if (s) {
      body.song = {
        provider: s.provider || "netease",
        id: s.id,
        name: s.name || s.title,
        artist: s.artist,
        cover: s.cover,
        duration_ms: s.duration_ms,
        stream_path: s.stream_path,
      };
    }
    return fetch("/api/v1/music/session/event", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (
          res.ok &&
          (event_type === "play" || event_type === "resume")
        ) {
          return fetch("/api/v1/listen/engage", {
            method: "POST",
            credentials: "same-origin",
          }).then(() => {
            if (event_type === "play") requestTrackShare(s);
          });
        }
      })
      .catch(() => {});
  }

  async function onLiveEnded() {
    if (playMode === "loop" && liveTrack) {
      try {
        liveAudio.currentTime = 0;
        await liveAudio.play();
        setPlayIcon(true);
        postCoveEvent("play", liveTrack, "单曲循环");
      } catch (_) {
        setPlayIcon(false);
      }
      return;
    }
    if (playMode === "shuffle" && liveCandidates && liveCandidates.length > 1) {
      const others = liveCandidates.filter(
        (s) => String(s.id) !== String(liveTrack && liveTrack.id)
      );
      const pick =
        others[Math.floor(Math.random() * others.length)] || liveCandidates[0];
      try {
        await playNeteaseTrack(pick);
      } catch (e) {
        toast((e && e.message) || "切歌失败");
      }
      return;
    }
    if (playMode === "seq") {
      const next = await playNextInQueue();
      if (next) return;
    }
    setPlayIcon(false);
    postCoveEvent("finish", liveTrack, "自然播完");
    const hint = document.getElementById("colistenPlayerHint");
    if (hint) hint.textContent = "播完了 · 可再点歌或说「点歌 歌名」";
  }

  async function playNextInQueue() {
    try {
      const res = await fetch("/api/v1/music/queue", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      const q = Array.isArray(data.queue) ? data.queue : [];
      if (!q.length) return false;
      let idx = queueCursor + 1;
      if (idx < 0) {
        idx = q.findIndex(
          (s) => String(s.id) === String(liveTrack && liveTrack.id)
        );
        idx = idx < 0 ? 0 : idx + 1;
      }
      /* 顺序播：末首播完回到队首继续 */
      if (idx >= q.length) idx = 0;
      queueCursor = idx;
      await playNeteaseTrack(q[idx], { fromQueue: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function enqueueTrack(track, opts) {
    if (!track || track.id == null) return null;
    try {
      const res = await fetch("/api/v1/music/queue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enqueue", song: track }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return null;
      const q = Array.isArray(data.queue) ? data.queue : [];
      if (opts && opts.asCurrent) {
        const idx = q.findIndex(
          (s) =>
            String(s.id) === String(track.id) &&
            String(s.provider || "netease") ===
              String(track.provider || "netease")
        );
        if (idx >= 0) queueCursor = idx;
      }
      let pending = q.length;
      if (liveTrack && liveTrack.id) {
        const cur = q.findIndex((s) => String(s.id) === String(liveTrack.id));
        if (cur >= 0) pending = Math.max(0, q.length - cur - 1);
      }
      paintQueueChip(pending);
      return data;
    } catch (_) {
      return null;
    }
  }

  /** 正在播 / 已恢复的曲必须在队列里（聊天点播、刷新恢复常漏入队） */
  async function ensureTrackInQueue(track) {
    const t = track || liveTrack || peekCoveLiveTrack();
    if (!t || t.id == null) return null;
    return enqueueTrack(
      {
        provider: t.provider || "netease",
        id: t.id,
        name: t.name || t.title,
        artist: t.artist,
        cover: t.cover,
        duration_ms: t.duration_ms,
        stream_path: t.stream_path,
      },
      { asCurrent: true }
    );
  }

  function peekCoveLiveTrack() {
    try {
      if (!global.CovePlayer) return null;
      const snap = global.CovePlayer.snapshot();
      const t = snap && snap.track;
      if (!t || !(t.name || t.title || t.id)) return null;
      return {
        provider: t.provider || "netease",
        id: t.id,
        name: t.name || t.title,
        artist: t.artist,
        cover: t.cover,
        duration_ms: t.duration_ms,
        stream_path: t.stream_path,
      };
    } catch (_) {
      return null;
    }
  }

  function setColistenLayerClass() {
    const root = document.getElementById("view-colisten");
    if (!root) return;
    root.classList.toggle("cl-on-session", uiLayer === "session");
  }

  function paintMusicTitle() {
    const title = document.getElementById("colistenTopTitle");
    if (title) title.textContent = "music";
  }

  function reloadCurrentHomeTab() {
    if (homeTab === "discover") {
      loadDailyDiscovery(false);
      return;
    }
    if (homeTab === "home") {
      loadHomePage();
      return;
    }
    refreshHomeLibrary();
  }

  function showHome() {
    uiLayer = "home";
    const home = document.getElementById("colistenHome");
    const sess = document.getElementById("colistenSession");
    if (home) home.hidden = false;
    if (sess) sess.hidden = true;
    paintMusicTitle();
    closeQueueSheet();
    closePlayerSubSheets();
    closeHistory();
    setColistenLayerClass();
    paintMini();
  }

  function showSession() {
    uiLayer = "session";
    const home = document.getElementById("colistenHome");
    const sess = document.getElementById("colistenSession");
    if (home) home.hidden = true;
    if (sess) sess.hidden = false;
    paintMusicTitle();
    closeQueueSheet();
    closePlayerSubSheets();
    setColistenLayerClass();
    if (liveTrack) {
      loadLyricsForTrack(liveTrack);
      loadHotCommentsForTrack(liveTrack);
    } else {
      paintLyrics([], "还没有在播的歌 · 回库找歌或点迷你条");
      paintHotComments([]);
    }
  }

  function paintMini() {
    const title = document.getElementById("colistenMiniTitle");
    const artist = document.getElementById("colistenMiniArtist");
    const art = document.getElementById("colistenMiniArt");
    const img = document.getElementById("colistenMiniCoverImg");
    const playBtn = document.getElementById("btnColistenMiniPlay");
    if (!liveTrack) {
      const cove = peekCoveLiveTrack();
      if (cove) liveTrack = cove;
    }
    const track = liveTrack || (session && session.track) || null;
    const name =
      (track && (track.name || track.title)) || "未在播放";
    const who = (track && track.artist) || "点这里进播放页";
    if (title) title.textContent = name;
    if (artist) artist.textContent = who;
    const cover = track && (track.cover || track.picUrl);
    if (art) art.classList.toggle("has-art", !!cover);
    if (img) {
      if (cover) img.src = cover;
      else img.removeAttribute("src");
    }
    const playing = !!(liveAudio && !liveAudio.paused);
    setPlayIcon(playing);
    paintLike(liked);
    paintPlayMode();
  }

  function paintPlayMode() {
    const btn = document.getElementById("btnColistenPlayMode");
    const icon = document.getElementById("colistenPlayModeIcon");
    const label = MODE_LABEL[playMode] || MODE_LABEL.seq;
    if (btn) {
      btn.dataset.mode = playMode;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.classList.toggle("on", playMode !== "seq");
    }
    if (icon) icon.innerHTML = MODE_ICON[playMode] || MODE_ICON.seq;
    const mini = document.getElementById("btnColistenMiniMode");
    if (mini) {
      mini.title = label;
      mini.setAttribute("aria-label", label);
      mini.classList.toggle("on", playMode !== "seq");
      const svg = mini.querySelector("svg");
      if (svg) svg.innerHTML = MODE_ICON[playMode] || MODE_ICON.seq;
    }
  }

  function cyclePlayMode() {
    playMode =
      playMode === "seq" ? "loop" : playMode === "loop" ? "shuffle" : "seq";
    paintPlayMode();
    toast(MODE_LABEL[playMode]);
  }

  let seekDragging = false;

  function seekFromClientX(clientX) {
    const bar = document.getElementById("colistenProgress");
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setProgress(pct * 100);
    if (
      liveTrack &&
      liveAudio &&
      liveAudio.duration &&
      Number.isFinite(liveAudio.duration)
    ) {
      try {
        liveAudio.currentTime = pct * liveAudio.duration;
        setTimeLabels(liveAudio.currentTime, liveAudio.duration);
      } catch (_) {}
    } else if (durationSec > 0) {
      setTimeLabels(pct * durationSec, durationSec);
    }
  }

  function bindProgressSeek() {
    const bar = document.getElementById("colistenProgress");
    if (!bar || bar.dataset.seekBound === "1") return;
    bar.dataset.seekBound = "1";
    bar.style.cursor = "pointer";
    bar.setAttribute("role", "slider");
    bar.setAttribute("tabindex", "0");
    const onMove = (e) => {
      if (!seekDragging) return;
      seekFromClientX(e.clientX);
    };
    const onUp = () => {
      if (!seekDragging) return;
      seekDragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      seekDragging = true;
      seekFromClientX(e.clientX);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    bar.addEventListener("keydown", (e) => {
      if (!liveTrack || !liveAudio || !liveAudio.duration) return;
      const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      try {
        liveAudio.currentTime = Math.max(
          0,
          Math.min(liveAudio.duration, liveAudio.currentTime + step)
        );
        syncLiveProgress();
      } catch (_) {}
    });
  }

  function paintLiveTrack(track) {
    if (!track) return;
    const title = document.getElementById("colistenTitle");
    const artist = document.getElementById("colistenArtist");
    const hint = document.getElementById("colistenPlayerHint");
    if (title) title.textContent = track.name || track.title || "未在播放";
    if (artist) artist.textContent = track.artist || "—";
    if (hint) {
      hint.textContent =
        liveAudio && !liveAudio.paused
          ? "网易云播放中 · 可拖进度条"
          : "已备好 · 点播放 / 拖进度";
    }
    setCoverArt(track.cover || track.picUrl || "");
    const metaDur =
      track.duration_ms > 0
        ? track.duration_ms / 1000
        : liveAudio && liveAudio.duration && Number.isFinite(liveAudio.duration)
          ? liveAudio.duration
          : 0;
    setTimeLabels(
      liveAudio && !liveAudio.paused ? liveAudio.currentTime || 0 : 0,
      metaDur
    );
    paintMini();
    loadLyricsForTrack(track);
    loadHotCommentsForTrack(track);
  }

  async function playNeteaseTrack(track, opts) {
    if (!track || !track.id) throw new Error("无效曲目");
    const fromQueue = !!(opts && opts.fromQueue);
    track = await enrichNeteaseTrack(track);
    if (!fromQueue) await enqueueTrack(track, { asCurrent: true });
    ensureLiveAudio();
    const path =
      String(track.stream_path || "").trim() ||
      "/api/v1/music/stream/netease/" + String(track.id);
    const probeFail = await probeStreamMessage(path);
    if (probeFail) throw new Error(probeFail);
    liveTrack = track;
    stopProgressTick();
    setProgress(0);
    durationSec = track.duration_ms > 0 ? track.duration_ms / 1000 : 0;
    paintLiveTrack(track);
    applyMusicVolume();
    try {
      if (global.CovePlayer) {
        global.CovePlayer.setTrack(track, "colisten");
        await global.CovePlayer.play(path, {
          track: track,
          owner: "colisten",
          volume: musicVolume,
          toggle: false,
        });
      } else {
        const a = ensureLiveAudio();
        a.pause();
        a.src = path;
        await a.play();
      }
      setPlayIcon(true);
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = "网易云播放中 · 可拖进度条";
      toast("正在播放 · " + (track.name || ""));
      if (!(global.CovePlayer && global.CovePlayer.isSuppressing())) {
        postCoveEvent("play", track);
      }
      /* 找层入队不跳播页；点 ▶ / 点歌才进播层 */
      const openPlayer = !opts || opts.openPlayer !== false;
      if (openPlayer && uiLayer !== "session" && uiLayer !== "queue") {
        showSession();
      }
    } catch (e) {
      setPlayIcon(false);
      const again = await probeStreamMessage(path);
      throw new Error(
        again || "播放被浏览器拦截，点一下页面后再试"
      );
    }
  }

  async function searchNeteaseSongs(query) {
    const q = String(query || "").trim();
    if (!q) throw new Error("请输入歌名");
    const res = await fetch(
      "/api/v1/music/search?provider=netease&limit=8&q=" + encodeURIComponent(q),
      { cache: "no-store", credentials: "same-origin" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "搜歌失败");
    const songs = Array.isArray(data.songs) ? data.songs : [];
    if (!songs.length) throw new Error("没有搜到歌");
    return songs;
  }

  async function requestSongByQuery(query) {
    const hint = document.getElementById("colistenPlayerHint");
    if (hint) hint.textContent = "搜歌中…";
    try {
      const songs = await searchNeteaseSongs(query);
      closeSongModal();
      if (songs.length === 1) {
        liveCandidates = null;
        await playNeteaseTrack(songs[0]);
        return;
      }
      liveCandidates = songs;
      closeHistory();
      showHome();
      homeTab = "discover";
      paintTabbar();
      paintHomeList(
        songs.map((s) => ({
          id: s.id,
          title: s.name,
          artist: s.artist,
          cover: s.cover,
          provider: "netease",
          stream_path: s.stream_path,
          duration_ms: s.duration_ms,
          _libSong: s,
          _netease: s,
        })),
        ""
      );
      setHomeNote("多首匹配 · 点＋入队 · 长按立即播");
      if (hint) hint.textContent = "多首匹配 · 已放到 Discover";
      toast("请选一首");
    } catch (e) {
      if (hint) hint.textContent = (e && e.message) || "点歌失败";
      toast((e && e.message) || "点歌失败");
    }
  }

  function closeSongModal() {
    const m = document.getElementById("colistenSongModal");
    if (m) m.hidden = true;
  }

  function closeImportModal() {
    const m = document.getElementById("colistenImportModal");
    if (m) m.hidden = true;
  }

  function beginRequestSong() {
    closeImportModal();
    closePlusMenuSafe();
    const m = document.getElementById("colistenSongModal");
    const input = document.getElementById("colistenSongQuery");
    if (m) m.hidden = false;
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
  }

  function beginImportPlaylist() {
    closeSongModal();
    closePlusMenuSafe();
    const m = document.getElementById("colistenImportModal");
    const input = document.getElementById("colistenImportQuery");
    if (m) m.hidden = false;
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
  }

  function closePlusMenuSafe() {
    const plusMenu = document.getElementById("colistenPlusMenu");
    const plusBtn = document.getElementById("btnColistenPlus");
    if (plusMenu) plusMenu.hidden = true;
    if (plusBtn) plusBtn.setAttribute("aria-expanded", "false");
  }

  async function importPlaylistByQuery(query) {
    const hint = document.getElementById("colistenPlayerHint");
    const modalHint = document.querySelector(
      "#colistenImportModal .cl-modal-hint"
    );
    const btn = document.querySelector("#colistenImportForm button[type='submit']");
    const setModalHint = (t) => {
      if (modalHint) modalHint.textContent = t;
    };
    if (hint) hint.textContent = "导入歌单中…";
    setModalHint("导入中，请稍候…");
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/v1/music/playlists/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: query, limit: 200 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "导入失败");
      }
      const pl = data.playlist || {};
      closeImportModal();
      setModalHint("导入后出现在歌单库，可整单入队");
      toast(
        "已导入《" +
          (pl.name || "歌单") +
          "》· " +
          (pl.track_count || 0) +
          " 首"
      );
      if (hint) {
        hint.textContent = "已导入 · 在歌单库打开，或整单入队";
      }
      showHome();
      await refreshHomeLibrary();
    } catch (e) {
      const msg = (e && e.message) || "导入失败";
      if (hint) hint.textContent = msg;
      setModalHint(msg);
      toast(msg);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function applyHealth(flag) {
    const val = document.getElementById("appleMusicVal");
    if (val) {
      /* 点歌音源状态由 fillMusicSettings 刷新；此处保留兼容 */
      if (!val.dataset.musicSrc) {
      val.textContent =
          flag === "shelved" || !flag ? "网易云" : flag === "authorized" ? "已授权" : "待接";
      }
    }
  }

  function fillMusicSettings(s) {
    const prov = document.getElementById("inMusicProvider");
    const api = document.getElementById("inNeteaseApi");
    const qual = document.getElementById("inNeteaseQuality");
    const vol = document.getElementById("inMusicVolume");
    const cookie = document.getElementById("inNeteaseCookie");
    const hint = document.getElementById("neteaseCookieHint");
    const val = document.getElementById("appleMusicVal");
    if (prov) prov.value = s.music_provider || "netease";
    if (api) api.value = s.netease_api_base_url || "http://127.0.0.1:3000";
    if (qual) qual.value = s.netease_music_quality || "exhigh";
    const mv = Number(s.music_volume);
    musicVolume = Number.isFinite(mv) ? Math.max(0, Math.min(1, mv)) : 0.8;
    if (vol) vol.value = String(Math.round(musicVolume * 100));
    applyMusicVolume();
    try {
      global.__ariadneMusicVol = musicVolume;
    } catch (_) {}
    if (cookie) cookie.value = "";
    if (hint) {
      hint.textContent = s.netease_cookie_set
        ? "Cookie：已保存（不回显）。会员曲听不了请重新扫码"
        : "Cookie：未设置 · 会员曲需扫码登录";
    }
    if (val) {
      val.dataset.musicSrc = "1";
      const p = s.music_provider || "netease";
      val.textContent =
        p === "apple" ? "Apple" : p === "auto" ? "自动" : "网易云";
    }
  }

  async function loadMusicSettings() {
    try {
      const res = await fetch("/api/v1/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      fillMusicSettings(data.settings || data || {});
    } catch (_) {}
  }

  async function saveMusicSettings() {
    const msg = document.getElementById("appleMusicMsg");
    const volEl = document.getElementById("inMusicVolume");
    const patch = {
      music_provider: (document.getElementById("inMusicProvider") || {}).value || "netease",
      netease_api_base_url: (document.getElementById("inNeteaseApi") || {}).value || "",
      netease_music_quality:
        (document.getElementById("inNeteaseQuality") || {}).value || "exhigh",
      music_volume: volEl ? Number(volEl.value) / 100 : musicVolume,
    };
    const cookie = String(
      (document.getElementById("inNeteaseCookie") || {}).value || ""
    ).trim();
    if (cookie) patch.netease_cookie = cookie;
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      fillMusicSettings(data.settings || data || patch);
      if (msg) {
        msg.textContent = "已保存";
        msg.className = "save-msg ok";
      }
    } catch (e) {
      if (msg) {
        msg.textContent = (e && e.message) || "保存失败";
        msg.className = "save-msg err";
      }
    }
  }

  async function pingNetease() {
    const msg = document.getElementById("appleMusicMsg");
    if (msg) {
      msg.textContent = "探测中…";
      msg.className = "save-msg";
    }
    try {
      const res = await fetch("/api/v1/music/netease/ping", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (msg) {
        if (data.ok) {
          msg.textContent = "API 可达 · " + (data.base || "");
          msg.className = "save-msg ok";
        } else {
          msg.textContent = data.message || "连不上兼容 API";
          msg.className = "save-msg err";
        }
      }
    } catch (e) {
      if (msg) {
        msg.textContent = (e && e.message) || "探测失败";
        msg.className = "save-msg err";
      }
    }
  }

  let qrPollTimer = null;
  let qrKey = "";

  function stopQrPoll() {
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
    qrKey = "";
  }

  async function startNeteaseQr() {
    const msg = document.getElementById("appleMusicMsg");
    const box = document.getElementById("neteaseQrBox");
    const img = document.getElementById("neteaseQrImg");
    const st = document.getElementById("neteaseQrStatus");
    stopQrPoll();
    if (msg) {
      msg.textContent = "生成二维码…";
      msg.className = "save-msg";
    }
    try {
      const res = await fetch("/api/v1/music/netease/qr/start", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.message || "生成失败");
      qrKey = data.key || "";
      if (box) box.style.display = "block";
      if (img) {
        const rawImg = String(data.qrimg || "").trim();
        if (rawImg) img.src = rawImg;
        else img.removeAttribute("src");
        img.alt = String(data.qrurl || "网易云登录二维码");
      }
      if (st) {
        st.textContent = data.qrimg
          ? "请用网易云 App 扫码"
          : data.qrurl
            ? "API 未出图；可换新版 NeteaseCloudMusicApi 或手动 Cookie"
            : "请用网易云 App 扫码";
      }
      if (msg) {
        msg.textContent = "请扫码";
        msg.className = "save-msg";
      }
      qrPollTimer = setInterval(async () => {
        if (!qrKey) return;
        try {
          const cr = await fetch(
            "/api/v1/music/netease/qr/check?key=" + encodeURIComponent(qrKey),
            { cache: "no-store" }
          );
          const cd = await cr.json().catch(() => ({}));
          if (st) st.textContent = cd.message || cd.status || "…";
          if (cd.status === "authorized" && cd.ok) {
            stopQrPoll();
            if (msg) {
              msg.textContent = "已登录并保存";
              msg.className = "save-msg ok";
            }
            if (box) box.style.display = "none";
            loadMusicSettings();
          } else if (
            cd.status === "expired" ||
            (!cd.ok && (cd.status === "error" || cd.status === "unknown"))
          ) {
            stopQrPoll();
            if (msg) {
              msg.textContent = cd.message || "已过期";
              msg.className = "save-msg bad";
            }
          }
        } catch (_) {}
      }, 2000);
    } catch (e) {
      if (msg) {
        msg.textContent = (e && e.message) || "扫码失败";
        msg.className = "save-msg bad";
      }
    }
  }

  function collapse() {
    stopQrPoll();
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
    loadMusicSettings();
    if (typeof deps.openSettingsSub === "function") {
      deps.openSettingsSub("apple", "共听音源", "appleMusicPanel");
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

  async function probeMusicReady() {
    try {
      const res = await fetch("/api/v1/music/netease/ping", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) return { ok: true, message: "" };
      return {
        ok: false,
        message:
          (data && data.message) ||
          "网易云兼容 API 连不上 · 去设置填地址并确认服务已起",
      };
    } catch (e) {
      return {
        ok: false,
        message: (e && e.message) || "探测失败 · 去设置检查音源",
      };
    }
  }

  function showAuthGate(message) {
    const gate = document.getElementById("colistenAuthGate");
    const msg = document.getElementById("colistenAuthGateMsg");
    if (msg) {
      msg.textContent =
        message || "网易云兼容 API 未就绪 · 去设置里填地址并扫码";
    }
    if (gate) gate.hidden = false;
    const view = document.getElementById("view-colisten");
    if (view) view.classList.add("cl-auth-blocked");
  }

  function hideAuthGate() {
    const gate = document.getElementById("colistenAuthGate");
    if (gate) gate.hidden = true;
    const view = document.getElementById("view-colisten");
    if (view) view.classList.remove("cl-auth-blocked");
  }

  function goAuthSettings() {
    if (typeof deps.showView === "function") deps.showView("phone-settings");
    expand();
  }

  async function retryAuthGate() {
    const msg = document.getElementById("colistenAuthGateMsg");
    if (msg) msg.textContent = "探测中…";
    const ready = await probeMusicReady();
    if (!ready.ok) {
      showAuthGate(ready.message);
      return false;
    }
    hideAuthGate();
    try {
      await refreshSession();
      await postJson("/api/v1/listen/engage", {});
      await restoreCoveSession();
      paintMini();
      await switchHomeTab(homeTab || "home");
    } catch (e) {
      toast((e && e.message) || "进入失败");
    }
    return true;
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
      if (next >= 100) next = playMode === "loop" ? 0 : 92;
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
    const miniIcon = document.getElementById("colistenMiniPlayIcon");
    const miniBtn = document.getElementById("btnColistenMiniPlay");
    if (miniIcon) {
      const path = miniIcon.querySelector("path");
      if (path) path.setAttribute("d", playing ? PAUSE_PATH : PLAY_PATH);
    }
    if (miniBtn) miniBtn.setAttribute("aria-label", playing ? "暂停" : "播放");
  }

  function paintCover(track) {
    setCoverArt(track && track.cover ? track.cover : "");
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
    if (liveTrack) {
      paintLiveTrack(liveTrack);
      if (liveAudio) setPlayIcon(!liveAudio.paused);
      paintLike(typeof session.liked === "boolean" ? session.liked : prevLiked);
    } else {
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
          ? "示意进度（无声音）· 点「＋」→ 点歌 听真曲"
          : "点「＋」→ 点歌，或输入「点歌 晴天」";
      }
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
    closeQueuePanel();
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

  function paintRowList(listEl, tracks, currentId, onPick) {
    if (!listEl) return;
    listEl.replaceChildren();
    const rows = Array.isArray(tracks) ? tracks : [];
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "暂无";
      listEl.append(empty);
      return;
    }
    for (const t of rows) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.trackId = t.id || "";
      if (t.id && String(t.id) === String(currentId)) btn.classList.add("on");
      const name = document.createElement("span");
      name.textContent = t.title || t.name || t.id || "未命名";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = t.artist || "—";
      btn.append(name, sub);
      btn.addEventListener("click", () => onPick(t));
      li.append(btn);
      listEl.append(li);
    }
  }

  function isSomethingPlaying() {
    return !!(liveAudio && !liveAudio.paused);
  }

  /** 找层：只入队，不打断当前播；闲着才可选开播 */
  async function enqueueStay(track, opts) {
    if (!track || track.id == null) {
      toast("无效曲目");
      return null;
    }
    const data = await enqueueTrack(track, { asCurrent: false });
    if (!data) {
      toast("入队失败");
      return null;
    }
    const name = track.name || track.title || "曲目";
    toast("已加入队列 · " + name);
    if (opts && opts.playIfIdle && !isSomethingPlaying()) {
      await playNeteaseTrack(track, { fromQueue: true, openPlayer: !!opts.openPlayer });
    }
    return data;
  }

  function closeAddToPlaylist() {
    const modal = document.getElementById("colistenAddToModal");
    if (modal) modal.hidden = true;
    addToSong = null;
  }

  async function openAddToPlaylist(song) {
    if (!song || song.id == null) {
      toast("无效曲目");
      return;
    }
    addToSong = song;
    const modal = document.getElementById("colistenAddToModal");
    const title = document.getElementById("colistenAddToSong");
    const liked = document.getElementById("colistenAddToLiked");
    const list = document.getElementById("colistenAddToList");
    const nameInput = document.getElementById("colistenAddToNewName");
    if (title) {
      title.textContent =
        (song.name || song.title || "曲目") +
        " · " +
        (song.artist || "—");
    }
    if (liked) liked.checked = false;
    if (nameInput) nameInput.value = "";
    if (list) {
      list.replaceChildren();
      const tip = document.createElement("li");
      tip.className = "empty";
      tip.textContent = "加载歌单…";
      list.append(tip);
    }
    if (modal) modal.hidden = false;
    try {
      const res = await fetch("/api/v1/music/library/playlists", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      const pls = Array.isArray(data.playlists) ? data.playlists : [];
      if (!list) return;
      list.replaceChildren();
      if (!pls.length) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "还没有本地歌单 · 可勾 Liked 或下方新建";
        list.append(empty);
      } else {
        for (const p of pls) {
          const li = document.createElement("li");
          const lab = document.createElement("label");
          lab.className = "cl-addto-check";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = String(p.id);
          cb.dataset.plId = String(p.id);
          const span = document.createElement("span");
          span.textContent =
            (p.name || "歌单") +
            " · " +
            (p.track_count || 0) +
            " 首";
          lab.append(cb, span);
          li.append(lab);
          list.append(li);
        }
      }
    } catch (e) {
      if (list) {
        list.replaceChildren();
        const err = document.createElement("li");
        err.className = "empty";
        err.textContent = (e && e.message) || "读歌单失败";
        list.append(err);
      }
    }
  }

  async function submitAddToPlaylist() {
    if (!addToSong || addToSong.id == null) {
      toast("没有选中曲目");
      return;
    }
    const likedEl = document.getElementById("colistenAddToLiked");
    const nameInput = document.getElementById("colistenAddToNewName");
    const list = document.getElementById("colistenAddToList");
    const playlist_ids = [];
    if (list) {
      list.querySelectorAll("input[type=checkbox][data-pl-id]").forEach((cb) => {
        if (cb.checked) playlist_ids.push(cb.getAttribute("data-pl-id"));
      });
    }
    const create_name = nameInput ? String(nameInput.value || "").trim() : "";
    const wantLiked = !!(likedEl && likedEl.checked);
    if (!wantLiked && !playlist_ids.length && !create_name) {
      toast("请至少选 Liked / 歌单 / 新建名称");
      return;
    }
    try {
      const res = await fetch("/api/v1/music/library/add-to", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song: addToSong,
          liked: wantLiked,
          playlist_ids,
          create_name: create_name || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || "加入失败");
      }
      if (wantLiked) paintLike(true);
      const parts = [];
      if (wantLiked) parts.push("Liked");
      if (playlist_ids.length) parts.push(playlist_ids.length + " 个歌单");
      if (create_name) parts.push("新建「" + create_name + "」");
      toast("已加入 · " + parts.join(" · "));
      closeAddToPlaylist();
      if (homeTab === "playlists" && homeLevel === "library") {
        refreshHomeLibrary();
      }
    } catch (e) {
      toast((e && e.message) || "加入失败");
    }
  }

  /** 插到当前曲之后：下一首就播这首，不打断正在听的 */
  async function enqueuePlayNext(track) {
    if (!track || track.id == null) {
      toast("无效曲目");
      return null;
    }
    try {
      const res = await fetch("/api/v1/music/queue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enqueue_next",
          song: track,
          after_id: liveTrack && liveTrack.id != null ? liveTrack.id : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "插队失败");
      const name = track.name || track.title || "曲目";
      toast("下一首播放 · " + name);
      if (!isSomethingPlaying()) {
        await playNeteaseTrack(track, { fromQueue: true, openPlayer: false });
      }
      return data;
    } catch (e) {
      toast((e && e.message) || "插队失败");
      return null;
    }
  }

  function onPickQueueTrack(t) {
    if (t._queueAll) {
      appendPlaylistToQueue(t._queueAll);
      return;
    }
    const song =
      t._netease ||
      t._libSong ||
      (liveCandidates &&
        liveCandidates.find((s) => String(s.id) === String(t.id)));
    if (song) {
      playNeteaseTrack(song, { fromQueue: true, openPlayer: true })
        .then(() => {
          liveCandidates = null;
          closeQueueSheet();
          showSession();
        })
        .catch((e) => toast((e && e.message) || "播放失败"));
      return;
    }
    selectTrack(t.id);
  }

  function paintHomeList(tracks, currentId) {
    const listEl = activeListEl();
    if (!listEl) return;
    const rows = Array.isArray(tracks) ? tracks : [];
    /* 歌单曲目 / 排行：封面行 + 单钮＋；长按立即播 */
    if (
      rows.some(
        (t) =>
          t &&
          (t._libSong || t._queueAll || t._enqueueSong || t._playNow || t.cover)
      ) &&
      !rows.every((t) => t && t._playlistId)
    ) {
      listEl.replaceChildren();
      for (const t of rows) {
        const li = document.createElement("li");
        if (t._queueAll) {
          const btn = document.createElement("button");
          btn.type = "button";
          const name = document.createElement("span");
          name.textContent = t.title || "＋ 整单加入队列";
          const sub = document.createElement("span");
          sub.className = "sub";
          sub.textContent = t.artist || "追加进队列 · 不打断当前曲";
          btn.append(name, sub);
          btn.addEventListener("click", () => appendPlaylistToQueue(t._queueAll));
          li.append(btn);
          listEl.append(li);
          continue;
        }
        const song =
          t._libSong ||
          t._enqueueSong ||
          t._netease ||
          (t._playNow || t.id
            ? {
                id: t.id,
                name: t.title || t.name,
                artist: t.artist,
                cover: t.cover,
                provider: t.provider || "netease",
                stream_path: t.stream_path,
                duration_ms: t.duration_ms,
              }
            : null);
        if (!song || song.id == null) continue;
        li.append(
          makeSongRow(song, {
            on: t.id && String(t.id) === String(currentId),
            title: t.title || song.name,
            sub: t.artist || song.artist,
            onAdd: (s) => openAddToPlaylist(s),
            onNext: (s) => enqueuePlayNext(s),
            onPlay: (s) => {
              toast("立即播放");
              playNeteaseTrack(s, { openPlayer: true }).catch((e) =>
                toast((e && e.message) || "播放失败")
              );
            },
          })
        );
        listEl.append(li);
      }
      if (!listEl.children.length) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "暂无";
        listEl.append(empty);
      }
      return;
    }
    paintRowList(listEl, tracks, currentId, (t) => {
      if (t._playlistId) {
        openImportedPlaylist(t._playlistId);
        return;
      }
      const song = t._netease || t._libSong;
      if (song) enqueueStay(song);
    });
  }

  function activeListEl() {
    if (homeTab === "playlists") return document.getElementById("colistenPlList");
    if (homeTab === "discover") return document.getElementById("colistenDiscoverList");
    return document.getElementById("colistenHomeList");
  }

  function activeNoteEl() {
    if (homeTab === "playlists") return document.getElementById("colistenPlNote");
    if (homeTab === "discover") return document.getElementById("colistenDiscoverNote");
    return document.getElementById("colistenHomeNote");
  }

  function setHomeChrome(level, titleText) {
    homeLevel = level;
    const head = document.getElementById("colistenHomeTitle");
    const up = document.getElementById("btnColistenHomeUp");
    const plus = document.getElementById("btnColistenHomeImport");
    const tools = document.getElementById("colistenPlTools");
    const drilled =
      homeTab === "playlists" &&
      (level === "playlist" || level === "liked");
    if (head) head.textContent = titleText || "Playlists";
    if (up) up.hidden = !drilled;
    if (plus) plus.hidden = drilled;
    if (tools) tools.hidden = drilled;
  }

  function paintQueueChip(count) {
    queuePendingCount = Math.max(0, Math.floor(Number(count) || 0));
    const chip = document.getElementById("btnColistenPlQueue");
    if (!chip) return;
    if (!queuePendingCount) {
      chip.textContent = "队列空 · 点歌入队";
      chip.classList.add("is-empty");
      chip.title = "队列为空 · 打开队列看引导";
      return;
    }
    chip.textContent = "待播 " + queuePendingCount + " 首";
    chip.classList.remove("is-empty");
    chip.title = "打开队列 · " + queuePendingCount + " 首待播";
  }

  function paintPlaylistLibraryRows() {
    const list = document.getElementById("colistenPlList");
    if (!list) return;
    const q = String(playlistSearchQ || "")
      .trim()
      .toLowerCase();
    list.replaceChildren();
    const likedLi = document.createElement("li");
    likedLi.append(
      paintPlaylistFolderRow({
        liked: true,
        title: "Liked",
        sub:
          likedCountCache != null
            ? likedCountCache + " 首 · 点开"
            : "喜欢的歌曲 · 点开",
        onClick: () => openLikedSongs(),
      })
    );
    list.append(likedLi);
    const histLi = document.createElement("li");
    histLi.append(
      paintPlaylistFolderRow({
        title: "最近场次",
        sub: "历史共听 · 点开",
        onClick: () => openHistory(),
      })
    );
    list.append(histLi);
    const pls = Array.isArray(playlistLibCache) ? playlistLibCache : [];
    const filtered = q
      ? pls.filter((p) => String(p.name || "").toLowerCase().includes(q))
      : pls;
    for (const p of filtered) {
      const li = document.createElement("li");
      li.append(
        paintPlaylistFolderRow({
          title: p.name,
          sub: (p.track_count || 0) + " 首 · 点开",
          cover: p.cover,
          onClick: () => openImportedPlaylist(String(p.id)),
        })
      );
      list.append(li);
    }
    if (!pls.length) {
      setHomeNote("还没有导入歌单 · 点右上＋导入，或 Discover 搜歌入队");
    } else if (q && !filtered.length) {
      setHomeNote("没有匹配「" + playlistSearchQ.trim() + "」的歌单");
    } else if (!queuePendingCount) {
      setHomeNote("队列空 · 点开歌单整单入队，或 Discover 搜歌");
    } else {
      setHomeNote("");
    }
  }

  function setHomeNote(text) {
    const el = activeNoteEl();
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function paintTabbar() {
    const bar = document.getElementById("colistenTabbar");
    if (!bar) return;
    bar.querySelectorAll("button[data-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-tab") === homeTab;
      btn.classList.toggle("on", on);
    });
    const pages = {
      home: document.getElementById("clPageHome"),
      playlists: document.getElementById("clPagePlaylists"),
      discover: document.getElementById("clPageDiscover"),
    };
    Object.keys(pages).forEach((k) => {
      if (pages[k]) pages[k].hidden = k !== homeTab;
    });
    paintMusicTitle();
  }

  function switchHomeTab(tab) {
    homeTab =
      tab === "playlists" ? "playlists" : tab === "discover" ? "discover" : "home";
    paintTabbar();
    if (homeTab === "discover") {
      loadDailyDiscovery(false);
      return;
    }
    if (homeTab === "home") {
      loadHomePage();
      return;
    }
    setHomeNote("");
    refreshHomeLibrary();
  }

  function paintOneHomeAvatar(side, url, nickname, fallbackLab) {
    const wrap = document.getElementById(
      side === "bot" ? "colistenHomeAvatarBot" : "colistenHomeAvatarYou"
    );
    const img = document.getElementById(
      side === "bot" ? "colistenHomeAvatarBotImg" : "colistenHomeAvatarYouImg"
    );
    const lab = document.getElementById(
      side === "bot" ? "colistenHomeAvatarBotLab" : "colistenHomeAvatarYouLab"
    );
    const nameEl = document.getElementById(
      side === "bot" ? "colistenHomeNameBot" : "colistenHomeNameYou"
    );
    const nick = String(nickname || "").trim() || (side === "bot" ? "家机" : "你");
    const src = String(url || "").trim();
    const has = !!src && (/^https?:\/\//i.test(src) || src.startsWith("/"));
    if (wrap) wrap.classList.toggle("has-art", has);
    if (img) {
      if (has) {
        img.hidden = false;
        img.src = src;
        img.alt = nick;
      } else {
        img.hidden = true;
        img.removeAttribute("src");
        img.alt = "";
      }
    }
    if (lab) lab.textContent = nick.slice(0, 1) || fallbackLab || "·";
    if (nameEl) nameEl.textContent = nick;
  }

  function paintHomePair(settings) {
    const s = settings || {};
    paintOneHomeAvatar(
      "you",
      s.avatar_user || "/assets/cafe/avatar-you.png",
      s.name_user || "你",
      "你"
    );
    paintOneHomeAvatar(
      "bot",
      s.avatar_bot || "/assets/cafe/avatar-bot.png",
      s.name_bot || "家机",
      "机"
    );
  }

  function paintRecentRail(rows) {
    const rail = document.getElementById("colistenRecentRail");
    if (!rail) return;
    rail.replaceChildren();
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "cl-recent-empty";
      empty.textContent = "还没有最近在听 · 去 Discover 搜歌，或 Playlists 整单入队";
      rail.append(empty);
      return;
    }
    list.forEach((t) => {
      const song = {
        id: t.id,
        name: t.name || t.title,
        artist: t.artist || "—",
        cover: t.cover,
        provider: t.provider || "netease",
        stream_path: t.stream_path,
        duration_ms: t.duration_ms,
      };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cl-recent-card";
      btn.title = (song.name || "曲目") + " · 入队并播放";
      const cover = document.createElement("div");
      cover.className = "cl-recent-cover";
      const src = String(song.cover || "").trim();
      if (src && /^https?:\/\//i.test(src)) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = src;
        cover.append(img);
      } else {
        cover.textContent = "♪";
      }
      const ttl = document.createElement("span");
      ttl.className = "cl-recent-ttl";
      ttl.textContent = song.name || "未命名";
      const sub = document.createElement("span");
      sub.className = "cl-recent-sub";
      sub.textContent =
        (song.artist || "—") +
        (t.play_count ? " · " + t.play_count + " 次" : "");
      btn.append(cover, ttl, sub);
      btn.addEventListener("click", () => {
        playNeteaseTrack(song, { openPlayer: true }).catch((e) =>
          toast((e && e.message) || "播放失败")
        );
      });
      rail.append(btn);
    });
  }

  async function loadHomePage() {
    homeTab = "home";
    paintTabbar();
    setHomeNote("");
    const rail = document.getElementById("colistenRecentRail");
    if (rail) {
      rail.replaceChildren();
      const tip = document.createElement("div");
      tip.className = "cl-recent-empty";
      tip.textContent = "加载最近在听…";
      rail.append(tip);
    }
    paintHomePair({});
    try {
      const [setRes, profRes, qRes] = await Promise.all([
        fetch("/api/v1/settings", {
          cache: "no-store",
          credentials: "same-origin",
        }).catch(() => null),
        fetch("/api/v1/music/netease/profile?type=1", {
          cache: "no-store",
          credentials: "same-origin",
        }).catch(() => null),
        fetch("/api/v1/music/queue", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      ]);
      if (setRes && setRes.ok) {
        const setData = await setRes.json().catch(() => ({}));
        paintHomePair(setData.settings || setData || {});
      }
      let prof = null;
      if (profRes && profRes.ok) {
        prof = await profRes.json().catch(() => ({}));
      }
      const qData = await qRes.json().catch(() => ({}));
      let rows = Array.isArray(qData.queue) ? qData.queue : [];
      if (!rows.length && liveTrack && liveTrack.id) {
        rows = [liveTrack];
      }
      if (!rows.length && prof && Array.isArray(prof.records)) {
        rows = prof.records.slice(0, 12);
      }
      paintRecentRail(rows.slice(0, 20));
    } catch (e) {
      if (rail) {
        rail.replaceChildren();
        const err = document.createElement("div");
        err.className = "cl-recent-empty";
        err.textContent = (e && e.message) || "加载失败 · 可切换底栏再回来";
        rail.append(err);
      }
    }
  }

  function paintPlaylistFolderRow(opts) {
    const o = opts || {};
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cl-pl-row" + (o.liked ? " is-liked" : "");
    const cover = document.createElement("div");
    cover.className = "cl-pl-cover";
    if (o.cover && /^https?:\/\//i.test(o.cover)) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = o.cover;
      cover.append(img);
    } else {
      cover.textContent = o.liked ? "♥" : "♪";
    }
    const meta = document.createElement("div");
    meta.className = "cl-pl-meta";
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = o.title || "歌单";
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = o.sub || "";
    meta.append(ttl, sub);
    btn.append(cover, meta);
    if (typeof o.onClick === "function") {
      btn.addEventListener("click", o.onClick);
    }
    return btn;
  }

  async function refreshHomeLibrary() {
    liveCandidates = null;
    homeTab = "playlists";
    paintTabbar();
    setHomeChrome("library", "Playlists");
    setHomeNote("");
    const list = document.getElementById("colistenPlList");
    if (!list) return;
    paintWaitCell(list, "加载歌单…", "");
    paintQueueChip(queuePendingCount);
    try {
      const [plRes, likedRes, qRes] = await Promise.all([
        fetch("/api/v1/music/library/playlists", {
          cache: "no-store",
          credentials: "same-origin",
        }),
        fetch("/api/v1/music/netease/liked?limit=1", {
          cache: "no-store",
          credentials: "same-origin",
        }).catch(() => null),
        fetch("/api/v1/music/queue", {
          cache: "no-store",
          credentials: "same-origin",
        }).catch(() => null),
      ]);
      if (qRes && qRes.ok) {
        const qData = await qRes.json().catch(() => ({}));
        const q = Array.isArray(qData.queue) ? qData.queue : [];
        let pending = q.length;
        if (liveTrack && liveTrack.id) {
          const cur = q.findIndex((t) => String(t.id) === String(liveTrack.id));
          if (cur >= 0) pending = Math.max(0, q.length - cur - 1);
        }
        paintQueueChip(pending);
      } else {
        paintQueueChip(0);
      }
      const data = await plRes.json().catch(() => ({}));
      playlistLibCache = Array.isArray(data.playlists) ? data.playlists : [];
      if (likedRes && likedRes.ok) {
        const liked = await likedRes.json().catch(() => ({}));
        if (liked && liked.ok) {
          likedCountCache = Number(liked.count) || 0;
        }
      } else if (likedRes && likedRes.status === 401) {
        likedCountCache = null;
      }
      paintPlaylistLibraryRows();
    } catch (e) {
      toast((e && e.message) || "读歌单失败");
      paintWaitCell(list, (e && e.message) || "读歌单失败", "可点右上＋导入");
    }
  }

  async function openLikedSongs() {
    homeTab = "playlists";
    paintTabbar();
    showHome();
    setHomeChrome("liked", "Liked");
    setHomeNote("");
    const list = document.getElementById("colistenPlList");
    paintWaitCell(list, "加载喜欢的歌…", "红心歌单");
    try {
      const res = await fetch("/api/v1/music/netease/liked?limit=120", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || "读取失败");
      }
      const songs = Array.isArray(data.songs) ? data.songs : [];
      likedCountCache = songs.length;
      if (!songs.length) {
        paintWaitCell(list, "还没有喜欢的歌", "播放页点 ♡ 红心后会出现在这里");
        return;
      }
      setHomeNote(songs.length + " 首 · 点＋入队 · 长按立即播");
      paintHomeList(
        songs.map((s) => ({
          id: String(s.id),
          title: s.name,
          artist: s.artist,
          cover: s.cover,
          provider: s.provider || "netease",
          stream_path: s.stream_path,
          duration_ms: s.duration_ms,
          _libSong: s,
          _netease: s,
        })),
        liveTrack ? String(liveTrack.id) : ""
      );
    } catch (e) {
      paintWaitCell(
        list,
        (e && e.message) || "读取失败",
        "需在设定扫码登录网易云"
      );
    }
  }

  function syncDailyEnqueueBtn(n) {
    const btn = document.getElementById("btnColistenDailyEnqueue");
    if (!btn) return;
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (!count) {
      btn.hidden = true;
      btn.textContent = "全部加入";
      return;
    }
    btn.hidden = false;
    btn.textContent = "全部加入·" + count + "首";
  }

  function paintDailyCard(card) {
    const list = document.getElementById("colistenDiscoverList");
    if (!list) return;
    list.replaceChildren();
    const songs = (card && Array.isArray(card.songs) ? card.songs : []) || [];
    syncDailyEnqueueBtn(songs.length);
    if (!songs.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "今天还没有日推 · 点「换一批」生成";
      list.append(empty);
      return;
    }

    songs.forEach((s) => {
      const li = document.createElement("li");
      li.append(
        makeSongRow(s, {
          on: liveTrack && String(liveTrack.id) === String(s.id),
          title: s.name || "未命名",
          sub: s.artist || "—",
          onAdd: (song) => openAddToPlaylist(song),
          onNext: (song) => enqueuePlayNext(song),
          onPlay: (song) => {
            toast("立即播放");
            playNeteaseTrack(song, { openPlayer: true }).catch((e) =>
              toast((e && e.message) || "播放失败")
            );
          },
        })
      );
      list.append(li);
    });
  }

  async function loadDailyDiscovery(refresh) {
    if (dailyLoading) {
      toast("日推还在生成，请稍候…");
      return;
    }
    homeTab = "discover";
    paintTabbar();
    const list = document.getElementById("colistenDiscoverList");
    if (
      !refresh &&
      dailyCard &&
      Array.isArray(dailyCard.songs) &&
      dailyCard.songs.length
    ) {
      paintDailyCard(dailyCard);
      return;
    }
    dailyLoading = true;
    syncDailyEnqueueBtn(0);
    const stages = refresh
      ? [
          "正在连接音源…",
          "正在换一批 · 搜可播新歌…",
          "家机正在策展，可能要一两分钟…",
          "仍在挑歌 · 请留在本页…",
          "还在连接中 · 别点太快…",
        ]
      : [
          "正在连接音源…",
          "正在搜可播新歌…",
          "正在生成今日日推…",
          "家机策展中，常要 1～2 分钟…",
          "仍在连接 · 请留在本页…",
        ];
    setHomeNote("");
    paintWaitCell(list, stages[0], "连接过程中，请不要以为失败了");
    try {
      const q =
        "/api/v1/music/daily-discovery?limit=16" +
        (refresh ? "&refresh=true" : "");
      const res = await waitAwareFetch(
        q,
        { cache: "no-store", credentials: "same-origin" },
        (tip) => {
          paintWaitCell(list, tip, "搜候选 → 验可播 → 家机策展，请耐心等");
        },
        stages
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const detail =
          data.message ||
          data.error ||
          (res.status === 401
            ? "小屋未解锁，请先输入访问密码"
            : "日推失败（HTTP " + res.status + "）");
        throw new Error(detail);
      }
      dailyCard = data;
      const noteParts = [];
      if (data.note) noteParts.push(data.note);
      if (data.subtitle) noteParts.push(data.subtitle);
      if (data.strategy && data.strategy.llm_ranked) {
        noteParts.push("家机策展");
      } else if (data.strategy && data.strategy.llm_error) {
        noteParts.push("程序兜底");
      }
      if (data.warning) noteParts.push(data.warning);
      setHomeNote(noteParts.join(" · ") || "");
      paintDailyCard(data);
    } catch (e) {
      const msg = (e && e.message) || "日推失败";
      setHomeNote("");
      toast(msg);
      paintWaitCell(list, msg, "点右上「换一批」再试", { error: true });
    } finally {
      dailyLoading = false;
    }
  }

  async function enqueueDailyAll(songs) {
    const rows = Array.isArray(songs) ? songs : [];
    if (!rows.length) return;
    try {
      let n = 0;
      for (const s of rows) {
        const data = await enqueueTrack(s, { asCurrent: false });
        if (data) n++;
      }
      toast("已加入队列 +" + n + " 首 · 听完当前再播");
      if (!isSomethingPlaying() && rows[0]) {
        await playNeteaseTrack(rows[0], { fromQueue: true, openPlayer: false });
      }
    } catch (e) {
      toast((e && e.message) || "入队失败");
    }
  }

  async function sendDailyFeedback(song, action) {
    try {
      const res = await fetch("/api/v1/music/daily-discovery/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song_id: song.id,
          action,
          artist: song.artist,
          name: song.name,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "反馈失败");
      const tip =
        action === "more_like_this"
          ? "记下了 · 多推这种"
          : action === "less_like_this"
            ? "记下了 · 少推这种"
            : action === "heard"
              ? "记下听过了"
              : "已喜欢";
      toast(tip);
    } catch (e) {
      toast((e && e.message) || "反馈失败");
    }
  }

  async function openImportedPlaylist(id) {
    try {
      const res = await fetch(
        "/api/v1/music/library/playlists/" + encodeURIComponent(id),
        { cache: "no-store", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "打开失败");
      const pl = data.playlist || {};
      const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
      homeTab = "playlists";
      paintTabbar();
      showHome();
      setHomeChrome("playlist", pl.name || "歌单");
      paintHomeList(
        [
          {
            id: "__queue_all__",
            title: "＋ 整单加入队列",
            artist: tracks.length + " 首 · 追加 · 不打断当前曲",
            _queueAll: String(pl.id),
          },
        ].concat(
          tracks.map((s) => ({
            id: String(s.id),
            title: s.name,
            artist: s.artist,
            _libSong: s,
            _netease: s,
          }))
        ),
        liveTrack ? String(liveTrack.id) : ""
      );
    } catch (e) {
      toast((e && e.message) || "打开失败");
    }
  }

  /** 整单追加进队列：保留正在听的，听完再播新加的 */
  async function appendPlaylistToQueue(playlistId) {
    try {
      const res = await fetch("/api/v1/music/queue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "append_playlist",
          playlist_id: playlistId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "入队失败");
      const added = Number(data.added) || 0;
      toast(
        added > 0
          ? "已追加 " + added + " 首 · 听完当前再播"
          : "这些歌已在队列里"
      );
      closeQueuePanel();
      if (!isSomethingPlaying() && data.queue && data.queue.length) {
        const curId = liveTrack && liveTrack.id;
        const next =
          data.queue.find((s) => String(s.id) !== String(curId)) ||
          data.queue[0];
        if (next) {
          await playNeteaseTrack(next, { fromQueue: true, openPlayer: false });
        }
      }
    } catch (e) {
      toast((e && e.message) || "入队失败");
    }
  }

  async function fetchQueueRaw() {
    if (!liveTrack) {
      const cove = peekCoveLiveTrack();
      if (cove) liveTrack = cove;
    }
    await ensureTrackInQueue(liveTrack);
    const res = await fetch("/api/v1/music/queue", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    let q = Array.isArray(data.queue) ? data.queue : [];
    if (!q.length && liveTrack && liveTrack.id != null) {
      q = [
        {
          provider: liveTrack.provider || "netease",
          id: liveTrack.id,
          name: liveTrack.name || liveTrack.title,
          artist: liveTrack.artist,
          cover: liveTrack.cover,
          stream_path: liveTrack.stream_path,
          duration_ms: liveTrack.duration_ms,
        },
      ];
    }
    return q;
  }

  async function fetchQueueRows() {
    const q = await fetchQueueRaw();
    return q.map((s, i) => ({
      id: String(s.id),
      title: s.name || "曲目",
      artist: (s.artist || "—") + " · #" + (i + 1),
      _libSong: s,
      _netease: s,
      _queueIndex: i,
    }));
  }

  function paintQueueSheetList(rows, currentId) {
    const list = document.getElementById("colistenQueueSheetList");
    if (!list) return;
    list.replaceChildren();
    const arr = Array.isArray(rows) ? rows : [];
    if (!arr.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent =
        "队列空 · 回 Playlists 整单入队，或 Discover / 点歌搜曲";
      list.append(empty);
      return;
    }
    arr.forEach((t, i) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className =
        "cl-q-row" +
        (t.id && String(t.id) === String(currentId) ? " on" : "");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "cl-q-main";
      const ttl = document.createElement("span");
      ttl.className = "ttl";
      ttl.textContent = t.title || "曲目";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = t.artist || "—";
      main.append(ttl, sub);
      main.addEventListener("click", () => onPickQueueTrack(t));
      const acts = document.createElement("div");
      acts.className = "cl-q-acts";
      const mk = (lab, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = lab;
        b.title = title;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          fn();
        });
        return b;
      };
      acts.append(
        mk("↑", "上移", () => moveQueueSong(i, i - 1)),
        mk("↓", "下移", () => moveQueueSong(i, i + 1)),
        mk("×", "移除", () => removeQueueSong(i))
      );
      row.append(main, acts);
      li.append(row);
      list.append(li);
    });
  }

  async function refreshQueueSheet() {
    const head = document.getElementById("colistenQueueSheetTitle");
    const note = document.getElementById("colistenQueueSheetNote");
    try {
      const rows = await fetchQueueRows();
      if (head) head.textContent = "正在播放 · " + rows.length;
      if (note) {
        note.hidden = true;
        note.textContent = "";
      }
      paintQueueSheetList(rows, liveTrack ? String(liveTrack.id) : "");
    } catch (e) {
      toast((e && e.message) || "读队列失败");
    }
  }

  /** 迷你条 / 播放页：上拉队列弹窗 */
  async function openQueueView() {
    closeHistory();
    liveCandidates = null;
    const sheet = document.getElementById("colistenQueueSheet");
    if (sheet) {
      sheet.hidden = false;
      sheet.classList.toggle("is-edit", queueSheetEdit);
    }
    const editBtn = document.getElementById("btnColistenQueueEdit");
    if (editBtn) {
      editBtn.setAttribute("aria-pressed", queueSheetEdit ? "true" : "false");
      editBtn.textContent = queueSheetEdit ? "完成" : "编辑";
    }
    await refreshQueueSheet();
  }

  function closeQueueSheet() {
    const sheet = document.getElementById("colistenQueueSheet");
    if (sheet) sheet.hidden = true;
  }

  function closeQueuePanel() {
    closeQueueSheet();
  }

  function openLyricSheet() {
    const sess = document.getElementById("colistenSession");
    const toolbar = document.getElementById("colistenLyricToolbar");
    const list = document.getElementById("colistenLyricsList");
    const tip = document.getElementById("colistenLyricsTip");
    closeCommentSheet();
    if (sess) sess.classList.add("cl-lyric-mode");
    if (toolbar) toolbar.hidden = false;
    if (list) list.hidden = false;
    if (tip) tip.hidden = false;
    const a = liveAudio;
    lyricState.active = -1;
    highlightLyricAt(a && Number.isFinite(a.currentTime) ? a.currentTime : 0);
  }

  function closeLyricSheet() {
    const sess = document.getElementById("colistenSession");
    const toolbar = document.getElementById("colistenLyricToolbar");
    const list = document.getElementById("colistenLyricsList");
    const tip = document.getElementById("colistenLyricsTip");
    if (sess) sess.classList.remove("cl-lyric-mode");
    if (toolbar) toolbar.hidden = true;
    if (list) list.hidden = true;
    if (tip) tip.hidden = true;
  }

  function openCommentSheet() {
    const sheet = document.getElementById("colistenCommentSheet");
    if (!sheet) return;
    closeLyricSheet();
    sheet.hidden = false;
  }

  function closeCommentSheet() {
    const sheet = document.getElementById("colistenCommentSheet");
    if (sheet) sheet.hidden = true;
  }

  function closePlayerSubSheets() {
    closeLyricSheet();
    closeCommentSheet();
  }

  async function removeQueueSong(index) {
    try {
      const res = await fetch("/api/v1/music/queue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "移除失败");
      await refreshQueueSheet();
    } catch (e) {
      toast((e && e.message) || "移除失败");
    }
  }

  async function moveQueueSong(from, to) {
    if (to < 0) return;
    try {
      const res = await fetch("/api/v1/music/queue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", from, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "调整失败");
      await refreshQueueSheet();
    } catch (e) {
      toast((e && e.message) || "调整失败");
    }
  }

  async function selectTrack(trackId) {
    try {
      paintSession(
        await postJson("/api/v1/listen/control", {
          action: "select",
          trackId: trackId,
        })
      );
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

  async function restoreCoveSession() {
    try {
      const res = await fetch("/api/v1/music/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.session) return;
      const sess = data.session;
      const song = sess.current_song;
      const hint = document.getElementById("colistenPlayerHint");
      if (!song || !song.name) {
        if (hint && !liveTrack) {
          hint.textContent = "点「＋」→ 点歌，或输入「点歌 晴天」";
        }
        return;
      }
      if (liveTrack && liveAudio && !liveAudio.paused) {
        ensureTrackInQueue(liveTrack);
        return;
      }
      liveTrack = {
        provider: song.provider || "netease",
        id: song.id,
        name: song.name,
        artist: song.artist,
        cover: song.cover,
        duration_ms: song.duration_ms,
        stream_path:
          song.stream_path ||
          (song.provider === "netease" && song.id
            ? "/api/v1/music/stream/netease/" + song.id
            : ""),
      };
      paintLiveTrack(liveTrack);
      ensureTrackInQueue(liveTrack);
      if (sess.active) {
        if (hint) hint.textContent = "上次共听仍活跃 · 点播放继续（" + (sess.label || "正在共听") + "）";
      } else if (sess.paused) {
        if (hint) hint.textContent = "已暂停 · 点播放继续";
      } else if (sess.terminated) {
        if (hint) hint.textContent = "上次共听已结束 · 可再点歌";
        setPlayIcon(false);
      } else if (sess.stale) {
        if (hint) hint.textContent = "共听租约已过期 · 历史曲仍可再点播放";
        setPlayIcon(false);
      } else if (sess.state === "ready") {
        if (hint) hint.textContent = "已备好 · 点播放";
      }
    } catch (_) {}
  }

  async function enterPlayer() {
    showHome();
    const ready = await probeMusicReady();
    if (!ready.ok) {
      showAuthGate(ready.message);
      return;
    }
    hideAuthGate();
    try {
      await refreshSession();
      await postJson("/api/v1/listen/engage", {});
      await restoreCoveSession();
      paintMini();
      await switchHomeTab("home");
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
      if (liveTrack) {
        const a = ensureLiveAudio();
        if (action === "play") {
          const path =
            String(liveTrack.stream_path || "").trim() ||
            (liveTrack.id
              ? "/api/v1/music/stream/netease/" + String(liveTrack.id)
              : "");
          if (path && (!a.src || a.getAttribute("src") !== path)) {
            const fail = await probeStreamMessage(path);
            if (fail) throw new Error(fail);
            a.src = path;
          }
          const wasPaused = a.paused && a.currentTime > 0.2;
          if (global.CovePlayer) {
            global.CovePlayer.setTrack(liveTrack, "colisten");
            await global.CovePlayer.play(path || a.getAttribute("src"), {
              track: liveTrack,
              owner: "colisten",
              volume: musicVolume,
              toggle: false,
            });
          } else {
            await a.play();
          }
          setPlayIcon(true);
          postCoveEvent(wasPaused ? "resume" : "play", liveTrack);
          return;
        }
        if (action === "pause") {
          if (global.CovePlayer) global.CovePlayer.pause();
          else a.pause();
          setPlayIcon(false);
          postCoveEvent("pause", liveTrack);
          return;
        }
        if (action === "next") {
          const ok = await playNextInQueue();
          if (!ok) toast("队列没有下一首 · 回歌单库整单入队");
          return;
        }
        if (action === "prev") {
          toast("上一首暂未接队列回溯 · 点队列里选歌");
          return;
        }
      }
      if (action === "play" || action === "pause") {
        toast("还没点真歌 · 点「＋」→ 点歌");
      }
      paintSession(await postJson("/api/v1/listen/control", { action: action }));
    } catch (e) {
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = (e && e.message) || "播控失败";
    }
  }

  async function endPass() {
    try {
      if (liveAudio) {
        try {
          liveAudio.pause();
        } catch (_) {}
      }
      await postCoveEvent("close", liveTrack, "结束本场");
      setPlayIcon(false);
      paintSession(await postJson("/api/v1/listen/end", {}));
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = "已结束共听 · 新场已开";
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
          if (ev.code === "budget_exhausted") {
            toast(ev.message || "本场额度已用尽 · 你侧已留下");
          }
        } else if (ev.type === "done") {
          if (Array.isArray(ev.messages)) {
            paintSession(ev);
          } else {
            try {
              await refreshSession();
            } catch (_) {}
          }
          const threadNow = document.getElementById("colistenSpitThread");
          const hasBot =
            threadNow &&
            Array.from(threadNow.querySelectorAll(".bubble:not(.you)")).some(
              (el) => String(el.textContent || "").trim()
            );
          if (ev.bot_error && ev.bot_error.fallback !== "mock_stream") {
            const hint = document.getElementById("colistenPlayerHint");
            if (hint) {
              hint.textContent =
                ev.bot_error.code === "budget_exhausted"
                  ? ev.bot_error.message || "本场额度已用尽 · 你侧已留下"
                  : "家机未接上：" +
                    (ev.bot_error.message || ev.bot_error.code || "");
            }
          } else if (!hasBot && !ev.bot_message) {
            toast("家机这句没接上，再发一条试试");
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
    const track = liveTrack || (session && session.track) || {};
    const trackId = track.id != null ? track.id : "";
    if (!trackId) {
      toast("还没有可收藏的曲");
      return;
    }
    try {
      const data = await postJson("/api/v1/listen/favorite", {
        trackId: trackId,
        title: track.name || track.title,
        name: track.name || track.title,
        artist: track.artist,
        cover: track.cover,
        provider: track.provider || "netease",
      });
      paintSession(data);
      paintLike(!!data.liked);
      if (data.netease_sync === false && data.netease_error) {
        toast(String(data.netease_error).slice(0, 80));
      } else if (data.netease_sync) {
        toast(data.liked ? "已红心 · 已同步网易云" : "已取消红心");
      }
    } catch (e) {
      const msg = (e && e.message) || "收藏失败";
      toast(msg);
      const hint = document.getElementById("colistenPlayerHint");
      if (hint) hint.textContent = msg;
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const back = document.getElementById("btnColistenBack");
    if (back) {
      back.addEventListener("click", () => {
        const sessLy = document.getElementById("colistenSession");
        if (sessLy && sessLy.classList.contains("cl-lyric-mode")) {
          closeLyricSheet();
          return;
        }
        const commentSheet = document.getElementById("colistenCommentSheet");
        if (commentSheet && !commentSheet.hidden) {
          closeCommentSheet();
          return;
        }
        const sheet = document.getElementById("colistenQueueSheet");
        if (sheet && !sheet.hidden) {
          closeQueueSheet();
          return;
        }
        if (uiLayer === "session") {
          showHome();
          reloadCurrentHomeTab();
          return;
        }
        if (homeLevel === "playlist" || homeLevel === "liked") {
          refreshHomeLibrary();
          return;
        }
        deps.showView("home");
      });
    }
    const homeUp = document.getElementById("btnColistenHomeUp");
    if (homeUp) {
      homeUp.addEventListener("click", () => refreshHomeLibrary());
    }
    const homeImport = document.getElementById("btnColistenHomeImport");
    if (homeImport) homeImport.addEventListener("click", beginImportPlaylist);
    const sheetBg = document.getElementById("colistenQueueSheetBg");
    if (sheetBg) sheetBg.addEventListener("click", closeQueueSheet);
    const sheetClose = document.getElementById("btnColistenQueueSheetClose");
    if (sheetClose) sheetClose.addEventListener("click", closeQueueSheet);
    const sheetEdit = document.getElementById("btnColistenQueueEdit");
    if (sheetEdit) {
      sheetEdit.addEventListener("click", () => {
        queueSheetEdit = !queueSheetEdit;
        const sheet = document.getElementById("colistenQueueSheet");
        if (sheet) sheet.classList.toggle("is-edit", queueSheetEdit);
        sheetEdit.setAttribute(
          "aria-pressed",
          queueSheetEdit ? "true" : "false"
        );
        sheetEdit.textContent = queueSheetEdit ? "完成" : "编辑";
      });
    }
    const tabbar = document.getElementById("colistenTabbar");
    if (tabbar) {
      tabbar.querySelectorAll("button[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () =>
          switchHomeTab(btn.getAttribute("data-tab"))
        );
      });
    }
    const dailyRefresh = document.getElementById("btnColistenDailyRefresh");
    if (dailyRefresh) {
      dailyRefresh.addEventListener("click", () => loadDailyDiscovery(true));
    }
    const dailyEnqueue = document.getElementById("btnColistenDailyEnqueue");
    if (dailyEnqueue) {
      dailyEnqueue.addEventListener("click", () => {
        const songs =
          dailyCard && Array.isArray(dailyCard.songs) ? dailyCard.songs : [];
        if (!songs.length) {
          toast("还没有日推可加入");
          return;
        }
        enqueueDailyAll(songs);
      });
    }
    const discForm = document.getElementById("colistenDiscoverForm");
    if (discForm) {
      discForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("colistenDiscoverQuery");
        const q = input ? String(input.value || "").trim() : "";
        if (!q) {
          toast("输入歌名或歌手");
          return;
        }
        homeTab = "discover";
        paintTabbar();
        const list = document.getElementById("colistenDiscoverList");
        paintWaitCell(list, "搜歌中…", q);
        try {
          const songs = await searchNeteaseSongs(q);
          paintHomeList(
            songs.map((s) => ({
              id: s.id,
              title: s.name,
              artist: s.artist,
              cover: s.cover,
              provider: "netease",
              stream_path: s.stream_path,
              duration_ms: s.duration_ms,
              _libSong: s,
              _netease: s,
            })),
            liveTrack && liveTrack.id
          );
          setHomeNote("搜到 " + songs.length + " 首 · 点＋入队 · 长按立即播");
        } catch (err) {
          paintWaitCell(list, (err && err.message) || "搜歌失败", "换个关键词再试");
        }
      });
    }
    const lyricsBtn = document.getElementById("colistenLyrics");
    if (lyricsBtn) lyricsBtn.addEventListener("click", openLyricSheet);
    const lyricClose = document.getElementById("btnColistenLyricSheetClose");
    if (lyricClose) lyricClose.addEventListener("click", closeLyricSheet);
    const lyricTrans = document.getElementById("btnColistenLyricTrans");
    if (lyricTrans) lyricTrans.addEventListener("click", toggleLyricTrans);
    const lyricOpenC = document.getElementById("btnColistenLyricOpenComments");
    if (lyricOpenC) lyricOpenC.addEventListener("click", openCommentSheet);
    const lyricOpenQ = document.getElementById("btnColistenLyricOpenQueue");
    if (lyricOpenQ) lyricOpenQ.addEventListener("click", openQueueView);
    const commentsBtn = document.getElementById("btnColistenOpenComments");
    if (commentsBtn) commentsBtn.addEventListener("click", openCommentSheet);
    const commentClose = document.getElementById("btnColistenCommentSheetClose");
    if (commentClose) commentClose.addEventListener("click", closeCommentSheet);
    const miniBar = document.getElementById("colistenMiniBar");
    if (miniBar) {
      miniBar.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        showSession();
      });
    }
    const miniPlay = document.getElementById("btnColistenMiniPlay");
    if (miniPlay) {
      miniPlay.addEventListener("click", (e) => {
        e.stopPropagation();
        if (liveTrack && liveAudio) {
          control(liveAudio.paused ? "play" : "pause");
          return;
        }
        showSession();
      });
    }
    const miniMode = document.getElementById("btnColistenMiniMode");
    if (miniMode) {
      miniMode.addEventListener("click", (e) => {
        e.stopPropagation();
        cyclePlayMode();
      });
    }
    const miniPrev = document.getElementById("btnColistenMiniPrev");
    if (miniPrev) {
      miniPrev.addEventListener("click", (e) => {
        e.stopPropagation();
        control("prev");
      });
    }
    const miniNext = document.getElementById("btnColistenMiniNext");
    if (miniNext) {
      miniNext.addEventListener("click", (e) => {
        e.stopPropagation();
        control("next");
      });
    }
    const miniQueue = document.getElementById("btnColistenMiniQueue");
    if (miniQueue) {
      miniQueue.addEventListener("click", (e) => {
        e.stopPropagation();
        openQueueView();
      });
    }
    const addToClose = document.getElementById("btnColistenAddToClose");
    if (addToClose) addToClose.addEventListener("click", closeAddToPlaylist);
    const addToModal = document.getElementById("colistenAddToModal");
    if (addToModal) {
      addToModal.addEventListener("click", (e) => {
        if (e.target === addToModal) closeAddToPlaylist();
      });
    }
    const addToSubmit = document.getElementById("btnColistenAddToSubmit");
    if (addToSubmit) addToSubmit.addEventListener("click", submitAddToPlaylist);
    const playToggle = document.getElementById("btnColistenPlayToggle");
    if (playToggle) {
      playToggle.addEventListener("click", () => {
        if (liveTrack && liveAudio) {
          control(liveAudio.paused ? "play" : "pause");
          return;
        }
        control(session && session.playing ? "pause" : "play");
      });
    }
    bindProgressSeek();
    const prev = document.getElementById("btnColistenPrev");
    const next = document.getElementById("btnColistenNext");
    if (prev) prev.addEventListener("click", () => control("prev"));
    if (next) next.addEventListener("click", () => control("next"));
    const like = document.getElementById("btnColistenLike");
    if (like) like.addEventListener("click", toggleLike);
    const modeBtn = document.getElementById("btnColistenPlayMode");
    if (modeBtn) modeBtn.addEventListener("click", cyclePlayMode);
    const openQ = document.getElementById("btnColistenOpenQueue");
    if (openQ) openQ.addEventListener("click", openQueueView);
    paintPlayMode();
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
    const reqSong = document.getElementById("btnColistenRequestSong");
    if (reqSong) {
      reqSong.addEventListener("click", () => {
        closePlusMenu();
        beginRequestSong();
      });
    }
    const impPl = document.getElementById("btnColistenImportPlaylist");
    if (impPl) {
      impPl.addEventListener("click", () => {
        closePlusMenu();
        beginImportPlaylist();
      });
    }
    const goHome = document.getElementById("btnColistenGoHome");
    if (goHome) {
      goHome.addEventListener("click", () => {
        closePlusMenu();
        showHome();
        switchHomeTab("playlists");
      });
    }
    const songModalClose = document.getElementById("btnColistenSongModalClose");
    if (songModalClose) songModalClose.addEventListener("click", closeSongModal);
    const importModalClose = document.getElementById("btnColistenImportModalClose");
    if (importModalClose) {
      importModalClose.addEventListener("click", closeImportModal);
    }
    const songForm = document.getElementById("colistenSongForm");
    if (songForm) {
      songForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const q = String(
          (document.getElementById("colistenSongQuery") || {}).value || ""
        ).trim();
        if (!q) return;
        await requestSongByQuery(q);
      });
    }
    const importForm = document.getElementById("colistenImportForm");
    if (importForm) {
      importForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const q = String(
          (document.getElementById("colistenImportQuery") || {}).value || ""
        ).trim();
        if (!q) return;
        await importPlaylistByQuery(q);
      });
    }
    const songModal = document.getElementById("colistenSongModal");
    if (songModal) {
      songModal.addEventListener("click", (e) => {
        if (e.target === songModal) closeSongModal();
      });
    }
    const importModal = document.getElementById("colistenImportModal");
    if (importModal) {
      importModal.addEventListener("click", (e) => {
        if (e.target === importModal) closeImportModal();
      });
    }
    const volRange = document.getElementById("inMusicVolume");
    if (volRange) {
      volRange.addEventListener("input", () => {
        musicVolume = Math.max(0, Math.min(1, Number(volRange.value) / 100));
        applyMusicVolume();
        try {
          global.__ariadneMusicVol = musicVolume;
        } catch (_) {}
      });
    }
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
    const saveBtn = document.getElementById("btnSaveNeteaseMusic");
    if (saveBtn) saveBtn.addEventListener("click", saveMusicSettings);
    const pingBtn = document.getElementById("btnNeteasePing");
    if (pingBtn) pingBtn.addEventListener("click", pingNetease);
    const qrBtn = document.getElementById("btnNeteaseQr");
    if (qrBtn) qrBtn.addEventListener("click", startNeteaseQr);
    const panel = document.getElementById("appleMusicPanel");
    if (panel) panel.addEventListener("click", (e) => e.stopPropagation());
    const authGo = document.getElementById("btnColistenAuthSettings");
    if (authGo) authGo.addEventListener("click", goAuthSettings);
    const authRetry = document.getElementById("btnColistenAuthRetry");
    if (authRetry) authRetry.addEventListener("click", () => retryAuthGate());
    const plQueue = document.getElementById("btnColistenPlQueue");
    if (plQueue) plQueue.addEventListener("click", openQueueView);
    const plSearch = document.getElementById("colistenPlSearch");
    if (plSearch) {
      plSearch.addEventListener("input", () => {
        playlistSearchQ = plSearch.value || "";
        if (homeLevel === "library" && homeTab === "playlists") {
          paintPlaylistLibraryRows();
        }
      });
    }
    setProgress(progressPct);
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
    loadAuth();
    try {
      ensureLiveAudio();
    } catch (_) {}
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
