/**
 * Cove 阶段 D：跨页单播内核。
 * 壳内聊天卡 / 共听共用同一 <audio>；多标签用 BroadcastChannel + localStorage takeover。
 */
(function (global) {
  const CHANNEL_KEY = "music_together_channel_v1";
  const TAKEOVER_KEY = "music_together_takeover_v1";
  const HANDOFF_KEY = "music_together_playing_handoff_v1";
  const TAB_ID =
    "t" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  let audio = null;
  let track = null;
  let owner = "";
  let suppressPlaybackEvent = false;
  const handlers = Object.create(null);

  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(CHANNEL_KEY)
      : null;

  function emit(type, payload) {
    const list = handlers[type];
    if (!list || !list.length) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (_) {}
    }
  }

  function on(type, fn) {
    if (!fn) return () => {};
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const list = handlers[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function getAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      audio.addEventListener("play", () => emit("state", snapshot()));
      audio.addEventListener("pause", () => emit("state", snapshot()));
      audio.addEventListener("ended", () => emit("ended", snapshot()));
      audio.addEventListener("timeupdate", () => emit("timeupdate", snapshot()));
      audio.addEventListener("loadedmetadata", () => emit("meta", snapshot()));
      audio.addEventListener("error", () => emit("error", snapshot()));
    }
    return audio;
  }

  function applyVolume(vol) {
    const a = getAudio();
    const v =
      typeof vol === "number"
        ? vol
        : typeof global.__ariadneMusicVol === "number"
          ? global.__ariadneMusicVol
          : 0.8;
    try {
      a.volume = Math.max(0, Math.min(1, v));
    } catch (_) {}
  }

  function snapshot() {
    const a = audio;
    return {
      tabId: TAB_ID,
      owner: owner,
      track: track,
      src: a ? a.getAttribute("src") || "" : "",
      currentTime: a && Number.isFinite(a.currentTime) ? a.currentTime : 0,
      duration: a && Number.isFinite(a.duration) ? a.duration : 0,
      playing: !!(a && !a.paused && !a.ended),
      sentAt: Date.now(),
    };
  }

  function announceTakeover(extra) {
    const msg = {
      type: "takeover",
      snapshot: Object.assign(snapshot(), extra || {}),
      sentAt: Date.now(),
      tabId: TAB_ID,
    };
    try {
      if (channel) channel.postMessage(msg);
    } catch (_) {}
    try {
      localStorage.setItem(TAKEOVER_KEY, JSON.stringify(msg));
    } catch (_) {}
    return msg;
  }

  function writeHandoff() {
    const a = audio;
    if (!a || a.paused || !a.getAttribute("src")) return;
    try {
      localStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify({
          snapshot: snapshot(),
          saved_at: Date.now(),
        })
      );
    } catch (_) {}
  }

  function handleRemoteTakeover(msg) {
    if (!msg || msg.tabId === TAB_ID) return;
    const a = audio;
    if (a && !a.paused) {
      suppressPlaybackEvent = true;
      try {
        a.pause();
      } catch (_) {}
      setTimeout(() => {
        suppressPlaybackEvent = false;
      }, 0);
    }
    if (msg.snapshot && msg.snapshot.track) {
      track = msg.snapshot.track;
      owner = msg.snapshot.owner || owner;
    }
    emit("remote-takeover", msg.snapshot || null);
    emit("state", snapshot());
  }

  if (channel) {
    channel.addEventListener("message", (ev) => {
      const msg = ev && ev.data;
      if (msg && msg.type === "takeover") handleRemoteTakeover(msg);
    });
  }

  try {
    global.addEventListener("storage", (ev) => {
      if (!ev || ev.key !== TAKEOVER_KEY || !ev.newValue) return;
      try {
        handleRemoteTakeover(JSON.parse(ev.newValue));
      } catch (_) {}
    });
  } catch (_) {}

  try {
    global.addEventListener("pagehide", writeHandoff);
    global.addEventListener("beforeunload", writeHandoff);
  } catch (_) {}

  /**
   * @param {string} src
   * @param {{ track?: object, owner?: string, volume?: number }} [opts]
   */
  async function play(src, opts) {
    const path = String(src || "").trim();
    if (!path) throw new Error("无播放地址");
    const a = getAudio();
    applyVolume(opts && opts.volume);
    track = (opts && opts.track) || track;
    owner = String((opts && opts.owner) || owner || "").slice(0, 24);
    suppressPlaybackEvent = false;
    const abs = new URL(path, global.location.origin).href;
    const same =
      a.src === abs ||
      a.getAttribute("src") === path ||
      a.getAttribute("src") === abs;
    const allowToggle = !(opts && opts.toggle === false);
    const forceRestart = !!(opts && opts.forceRestart);
    if (allowToggle && same && !a.paused && !forceRestart) {
      a.pause();
      announceTakeover({ playing: false });
      emit("state", snapshot());
      return { toggled: true, audio: a };
    }
    if (!same || forceRestart) {
      a.pause();
      a.src = path;
      try {
        a.currentTime = 0;
      } catch (_) {}
    }
    announceTakeover({ playing: true });
    emit("local-play", snapshot());
    await a.play();
    emit("state", snapshot());
    return { toggled: false, audio: a };
  }

  function pause(opts) {
    const a = audio;
    if (!a) return;
    const passive = !!(opts && opts.passive);
    if (passive) suppressPlaybackEvent = true;
    try {
      a.pause();
    } catch (_) {}
    if (passive) {
      setTimeout(() => {
        suppressPlaybackEvent = false;
      }, 0);
    } else {
      announceTakeover({ playing: false });
    }
    emit("state", snapshot());
  }

  function setTrack(next, nextOwner) {
    track = next || null;
    if (nextOwner != null) owner = String(nextOwner).slice(0, 24);
  }

  function isSuppressing() {
    return suppressPlaybackEvent;
  }

  /* ponytail: 单例自检 */
  (function () {
    const a = getAudio();
    const b = getAudio();
    if (a !== b) throw new Error("CovePlayer audio singleton");
  })();

  global.CovePlayer = {
    CHANNEL_KEY: CHANNEL_KEY,
    TAB_ID: TAB_ID,
    getAudio: getAudio,
    play: play,
    pause: pause,
    applyVolume: applyVolume,
    setTrack: setTrack,
    getTrack: function () {
      return track;
    },
    getOwner: function () {
      return owner;
    },
    snapshot: snapshot,
    announceTakeover: announceTakeover,
    isSuppressing: isSuppressing,
    on: on,
    off: off,
  };
})(typeof window !== "undefined" ? window : globalThis);
