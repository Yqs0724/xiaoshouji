/**
 * Cove 阶段 C：已导入歌单 + 共听队列（写入 music_library，与 session 同锁）。
 */
const {
  mutateMusicLibrary,
  compactSong,
  getMusicSession,
} = require("./music-session");

const MAX_QUEUE = 200;
const MAX_PLAYLIST_TRACKS = 500;

function publicPlaylist(pl, withTracks) {
  if (!pl) return null;
  const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
  const out = {
    id: pl.id,
    name: pl.name || "未命名歌单",
    source: pl.source || "netease",
    track_count: pl.track_count != null ? pl.track_count : tracks.length,
    updated_at: pl.updated_at || 0,
    cover: pl.cover || undefined,
  };
  if (withTracks) out.tracks = tracks;
  return out;
}

/** 只读：不写盘 */
function peekLibrary() {
  const path = require("node:path");
  const fs = require("node:fs");
  const STORE = path.join(__dirname, "..", "data", "music_library.json");
  try {
    if (fs.existsSync(STORE)) {
      return JSON.parse(fs.readFileSync(STORE, "utf8"));
    }
  } catch (_) {}
  return { playlists: {}, queue: [] };
}

function peekPlaylists() {
  const lib = peekLibrary();
  const list = Object.values(lib.playlists || {}).map((p) =>
    publicPlaylist(p, false)
  );
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return {
    ok: true,
    playlists: list,
    queue: Array.isArray(lib.queue) ? lib.queue.slice(0, MAX_QUEUE) : [],
  };
}

function listPlaylists() {
  return peekPlaylists();
}

function getPlaylist(id) {
  const key = String(id || "").trim();
  const lib = peekLibrary();
  const pl = lib.playlists && lib.playlists[key];
  if (!pl) {
    return { ok: false, error: "not_found", message: "本地没有这份歌单" };
  }
  return { ok: true, playlist: publicPlaylist(pl, true) };
}

function deletePlaylist(id) {
  const key = String(id || "").trim();
  return mutateMusicLibrary((lib) => {
    if (!lib.playlists || !lib.playlists[key]) {
      return { ok: false, error: "not_found", message: "本地没有这份歌单" };
    }
    delete lib.playlists[key];
    return { ok: true, deleted: key };
  });
}

function createPlaylist(name, song) {
  const title = String(name || "").trim().slice(0, 60) || "新建歌单";
  const now = Math.floor(Date.now() / 1000);
  const id = "local_" + now + "_" + Math.floor(Math.random() * 1e6);
  const track = song ? compactSong(song) : null;
  const tracks = track ? [track] : [];
  return mutateMusicLibrary((lib) => {
    if (!lib.playlists) lib.playlists = {};
    lib.playlists[id] = {
      id,
      name: title,
      source: "local",
      track_count: tracks.length,
      updated_at: now,
      cover: track && track.cover ? track.cover : undefined,
      tracks,
    };
    return {
      ok: true,
      playlist: publicPlaylist(lib.playlists[id], false),
    };
  });
}

function addTrackToPlaylist(playlistId, song) {
  const key = String(playlistId || "").trim();
  const t = compactSong(song);
  if (!t) return { ok: false, error: "bad_song", message: "无效曲目" };
  return mutateMusicLibrary((lib) => {
    if (!lib.playlists || !lib.playlists[key]) {
      return { ok: false, error: "not_found", message: "本地没有这份歌单" };
    }
    const pl = lib.playlists[key];
    if (!Array.isArray(pl.tracks)) pl.tracks = [];
    const exists = pl.tracks.some(
      (x) =>
        String(x.id) === String(t.id) &&
        (x.provider || "netease") === (t.provider || "netease")
    );
    if (!exists) {
      pl.tracks.push(t);
      if (pl.tracks.length > MAX_PLAYLIST_TRACKS) {
        pl.tracks = pl.tracks.slice(-MAX_PLAYLIST_TRACKS);
      }
    }
    pl.track_count = pl.tracks.length;
    pl.updated_at = Math.floor(Date.now() / 1000);
    if (!pl.cover && t.cover) pl.cover = t.cover;
    return {
      ok: true,
      added: !exists,
      playlist: publicPlaylist(pl, false),
    };
  });
}

/**
 * @param {object} detail getPlaylistDetail 结果
 * @param {{ actor?: string }} [opts]
 */
function saveImportedPlaylist(detail, opts = {}) {
  if (!detail || detail.id == null) {
    return { ok: false, error: "bad_playlist", message: "歌单无效" };
  }
  const actor =
    String((opts && opts.actor) || "user").trim() === "companion"
      ? "companion"
      : "user";
  const now = Math.floor(Date.now() / 1000);
  const tracks = (Array.isArray(detail.tracks) ? detail.tracks : [])
    .map(compactSong)
    .filter(Boolean)
    .slice(0, MAX_PLAYLIST_TRACKS);
  const id = String(detail.id);
  return mutateMusicLibrary((lib) => {
    if (!lib.playlists) lib.playlists = {};
    lib.playlists[id] = {
      id: detail.id,
      name: String(detail.name || "未命名歌单").trim(),
      source: detail.source || "netease",
      track_count: tracks.length,
      updated_at: now,
      cover: detail.cover || undefined,
      tracks,
    };
    if (!Array.isArray(lib.events)) lib.events = [];
    lib.events.push({
      event_type: "import_playlist",
      actor,
      song: null,
      playlist: { id: detail.id, name: lib.playlists[id].name },
      note: "导入 " + tracks.length + " 首",
      created_at: now,
    });
    if (lib.events.length > 500) lib.events = lib.events.slice(-500);
    lib.session = lib.session || {};
    lib.session.current_playlist = {
      id: detail.id,
      name: lib.playlists[id].name,
    };
    return {
      ok: true,
      playlist: publicPlaylist(lib.playlists[id], false),
    };
  });
}

function getQueue() {
  return peekPlaylists().queue;
}

/**
 * 整单追加进队列（不覆盖当前曲 / 不清空已有队列）。
 * opts.replace=true 时才整表替换（旧行为，少用）。
 */
function setQueueFromPlaylist(playlistId, opts = {}) {
  const key = String(playlistId || "").trim();
  const actor =
    String((opts && opts.actor) || "user").trim() === "companion"
      ? "companion"
      : "user";
  const replace = opts.replace === true;
  return mutateMusicLibrary((lib) => {
    const pl = lib.playlists && lib.playlists[key];
    if (!pl || !Array.isArray(pl.tracks) || !pl.tracks.length) {
      return { ok: false, error: "not_found", message: "歌单为空或不存在" };
    }
    const incoming = pl.tracks.map(compactSong).filter(Boolean);
    if (!Array.isArray(lib.queue)) lib.queue = [];
    let added = 0;
    if (replace) {
      lib.queue = incoming.slice(0, MAX_QUEUE);
      added = lib.queue.length;
    } else {
      const seen = new Set(
        lib.queue.map((x) => String(x.provider || "netease") + ":" + String(x.id))
      );
      for (const t of incoming) {
        const k = String(t.provider || "netease") + ":" + String(t.id);
        if (seen.has(k)) continue;
        lib.queue.push(t);
        seen.add(k);
        added++;
        if (lib.queue.length >= MAX_QUEUE) break;
      }
    }
    const now = Math.floor(Date.now() / 1000);
    lib.events.push({
      event_type: "queue_playlist",
      actor,
      song: lib.queue[0] || null,
      playlist: { id: pl.id, name: pl.name },
      note: replace
        ? "队列替换 " + lib.queue.length + " 首"
        : "队列追加 +" + added,
      created_at: now,
    });
    if (lib.events.length > 500) lib.events = lib.events.slice(-500);
    lib.session = lib.session || {};
    lib.session.current_playlist = { id: pl.id, name: pl.name };
    return {
      ok: true,
      queue: lib.queue.slice(),
      count: lib.queue.length,
      added,
      replaced: replace,
    };
  });
}

function enqueueSong(song) {
  const t = compactSong(song);
  if (!t) return { ok: false, error: "bad_song", message: "无效曲目" };
  return mutateMusicLibrary((lib) => {
    if (!Array.isArray(lib.queue)) lib.queue = [];
    const exists = lib.queue.some(
      (x) => String(x.id) === String(t.id) && x.provider === t.provider
    );
    if (!exists) lib.queue.push(t);
    if (lib.queue.length > MAX_QUEUE) {
      lib.queue = lib.queue.slice(-MAX_QUEUE);
    }
    return { ok: true, queue: lib.queue.slice(), count: lib.queue.length };
  });
}

/** 插到 afterId 之后（默认当前队列头后 / 队首），下一首就播到它 */
function enqueueSongNext(song, afterId) {
  const t = compactSong(song);
  if (!t) return { ok: false, error: "bad_song", message: "无效曲目" };
  return mutateMusicLibrary((lib) => {
    if (!Array.isArray(lib.queue)) lib.queue = [];
    lib.queue = lib.queue.filter(
      (x) =>
        !(String(x.id) === String(t.id) && (x.provider || "netease") === t.provider)
    );
    let insertAt = 0;
    if (afterId != null && afterId !== "") {
      const i = lib.queue.findIndex((x) => String(x.id) === String(afterId));
      insertAt = i >= 0 ? i + 1 : lib.queue.length ? 1 : 0;
    } else if (lib.queue.length) {
      insertAt = 1;
    }
    lib.queue.splice(insertAt, 0, t);
    if (lib.queue.length > MAX_QUEUE) {
      lib.queue = lib.queue.slice(0, MAX_QUEUE);
    }
    return {
      ok: true,
      queue: lib.queue.slice(),
      count: lib.queue.length,
      index: insertAt,
    };
  });
}

function clearQueue() {
  return mutateMusicLibrary((lib) => {
    lib.queue = [];
    return { ok: true, queue: [] };
  });
}

function queueSongAt(index) {
  const i = Math.floor(Number(index));
  return mutateMusicLibrary((lib) => {
    const q = Array.isArray(lib.queue) ? lib.queue : [];
    if (!Number.isFinite(i) || i < 0 || i >= q.length) {
      return { ok: false, error: "bad_index", message: "队列下标无效" };
    }
    return { ok: true, song: q[i], index: i, queue: q.slice() };
  });
}

function removeQueueAt(index) {
  const i = Math.floor(Number(index));
  return mutateMusicLibrary((lib) => {
    if (!Array.isArray(lib.queue)) lib.queue = [];
    if (!Number.isFinite(i) || i < 0 || i >= lib.queue.length) {
      return { ok: false, error: "bad_index", message: "队列下标无效" };
    }
    const removed = lib.queue.splice(i, 1)[0];
    return {
      ok: true,
      removed,
      queue: lib.queue.slice(),
      count: lib.queue.length,
    };
  });
}

function moveQueueItem(from, to) {
  const a = Math.floor(Number(from));
  const b = Math.floor(Number(to));
  return mutateMusicLibrary((lib) => {
    if (!Array.isArray(lib.queue)) lib.queue = [];
    const n = lib.queue.length;
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      b < 0 ||
      a >= n ||
      b >= n
    ) {
      return { ok: false, error: "bad_index", message: "队列下标无效" };
    }
    if (a !== b) {
      const [row] = lib.queue.splice(a, 1);
      lib.queue.splice(b, 0, row);
    }
    return { ok: true, queue: lib.queue.slice(), count: lib.queue.length };
  });
}

async function importPlaylistFromUrl(urlOrId, opts = {}) {
  const catalog = require("./netease-catalog");
  const detail = await catalog.getPlaylistDetail(urlOrId, {
    limit: opts.limit,
  });
  return saveImportedPlaylist(detail, { actor: opts.actor });
}

if (require.main === module) {
  const fake = {
    id: 999001,
    name: "自检歌单",
    source: "netease",
    tracks: [
      { provider: "netease", id: 1, name: "A", artist: "X" },
      { provider: "netease", id: 2, name: "B", artist: "Y" },
    ],
  };
  clearQueue();
  const s = saveImportedPlaylist(fake);
  console.assert(s.ok && s.playlist.track_count === 2, "import");
  const q = setQueueFromPlaylist(999001);
  console.assert(q.ok && q.count === 2 && q.added === 2, "queue append empty");
  const q2 = setQueueFromPlaylist(999001);
  console.assert(q2.ok && q2.added === 0 && q2.count === 2, "queue append dedupe");
  const mv = moveQueueItem(0, 1);
  console.assert(mv.ok && String(mv.queue[0].id) === "2", "queue move");
  const rm = removeQueueAt(0);
  console.assert(rm.ok && rm.count === 1, "queue remove");
  const created = createPlaylist("自检新建", {
    provider: "netease",
    id: 3,
    name: "C",
    artist: "Z",
  });
  console.assert(created.ok && created.playlist.track_count === 1, "create pl");
  const added = addTrackToPlaylist(created.playlist.id, {
    provider: "netease",
    id: 4,
    name: "D",
    artist: "Z",
  });
  console.assert(added.ok && added.playlist.track_count === 2, "add to pl");
  deletePlaylist(created.playlist.id);
  const listed = peekPlaylists();
  console.assert(listed.playlists.some((p) => String(p.id) === "999001"), "list");
  deletePlaylist(999001);
  clearQueue();
  console.log("music-playlists stage C ok");
  void getMusicSession;
  void listPlaylists;
  void enqueueSong;
  void queueSongAt;
}

module.exports = {
  peekPlaylists,
  listPlaylists,
  getPlaylist,
  deletePlaylist,
  createPlaylist,
  addTrackToPlaylist,
  saveImportedPlaylist,
  importPlaylistFromUrl,
  getQueue,
  setQueueFromPlaylist,
  enqueueSong,
  enqueueSongNext,
  clearQueue,
  queueSongAt,
  removeQueueAt,
  moveQueueItem,
  MAX_QUEUE,
};
