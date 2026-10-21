/**
 * Apple Music 降级音源：iTunes Search API（无需开发者账号 / MusicKit）。
 * 对齐 Cove「真搜真卡」：官方曲目页链接 + 可选 30s 试听；非整曲流。
 */
const https = require("node:https");

const PROVIDER = "apple";
const SEARCH_HOST = "itunes.apple.com";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: SEARCH_HOST,
        path: pathname,
        headers: { Accept: "application/json", "User-Agent": "Ariadne/1.0" },
        timeout: 12_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error("iTunes HTTP " + res.statusCode);
            err.code = "itunes_http";
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            const err = new Error("iTunes JSON 解析失败");
            err.code = "itunes_bad_json";
            reject(err);
          }
        });
      }
    );
    req.on("error", (e) => {
      const err = new Error(String((e && e.message) || e).slice(0, 160));
      err.code = "itunes_network";
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      const err = new Error("iTunes 超时");
      err.code = "itunes_timeout";
      reject(err);
    });
  });
}

function artworkHi(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  /* 100x100 → 600x600，封面更清楚 */
  return u.replace(/\/\d+x\d+bb\./, "/600x600bb.");
}

function normalizeTrack(raw) {
  if (!raw || raw.wrapperType === "collection") return null;
  const id = Number(raw.trackId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const name = String(raw.trackName || "").trim();
  if (!name) return null;
  const preview = String(raw.previewUrl || "").trim();
  const appleUrl = String(raw.trackViewUrl || "").trim();
  return {
    provider: PROVIDER,
    id,
    song_key: PROVIDER + ":" + id,
    name,
    artist: String(raw.artistName || "").trim(),
    album: String(raw.collectionName || "").trim(),
    cover: artworkHi(raw.artworkUrl100 || raw.artworkUrl60 || ""),
    duration_ms: Math.max(0, Math.floor(Number(raw.trackTimeMillis) || 0)),
    preview_url: preview || undefined,
    apple_url: appleUrl || undefined,
    playable: !!preview || !!appleUrl,
    preview_only: !!preview,
  };
}

function hasCjk(s) {
  return /[\u3400-\u9fff]/.test(String(s || ""));
}

async function searchSongsOnce(q, limit, country) {
  let path =
    "/search?media=music&entity=song&limit=" +
    limit +
    "&term=" +
    encodeURIComponent(q);
  const c = String(country || "").trim().toUpperCase();
  if (c) path += "&country=" + encodeURIComponent(c);
  const data = await getJson(path);
  const results = Array.isArray(data && data.results) ? data.results : [];
  const out = [];
  const seen = new Set();
  for (const r of results) {
    const t = normalizeTrack(r);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function simpTrad(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/傑/g, "杰")
    .replace(/倫/g, "伦")
    .replace(/楊/g, "杨")
    .replace(/後/g, "后")
    .replace(/樂/g, "乐")
    .replace(/風/g, "风")
    .replace(/愛/g, "爱");
}

function rankAgainstQuery(q, list) {
  const ql = simpTrad(q);
  return (list || [])
    .map((t) => {
      const nl = simpTrad(t.name);
      const al = simpTrad(t.artist);
      let s = 0;
      if (nl && ql.includes(nl)) s += 3;
      if (al && ql.includes(al)) s += 2;
      return { t, s };
    })
    .sort((a, b) => b.s - a.s);
}

/**
 * @param {string} query
 * @param {{ limit?: number, country?: string }} [opts]
 */
async function searchSongs(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Math.floor(Number(opts.limit) || DEFAULT_LIMIT))
  );
  /* ponytail: CN storefront 常空；中文优先 HK/TW，再默认区 */
  const forced = String(opts.country || "").trim().toUpperCase();
  if (forced) return searchSongsOnce(q, limit, forced);

  const countries = hasCjk(q) ? ["HK", "TW", ""] : [""];
  let fallback = [];
  for (const c of countries) {
    const hit = await searchSongsOnce(q, limit, c);
    if (!hit.length) continue;
    const ranked = rankAgainstQuery(q, hit);
    if (ranked[0] && ranked[0].s >= 3) {
      return ranked.map((x) => x.t);
    }
    if (!fallback.length) fallback = hit;
  }
  /* 歌名在前：再试首段 */
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && hasCjk(parts[0])) {
    for (const c of ["HK", "TW"]) {
      const hit = await searchSongsOnce(parts[0], limit, c);
      const ranked = rankAgainstQuery(q, hit);
      if (ranked[0] && ranked[0].s >= 3) {
        return ranked.map((x) => x.t);
      }
    }
  }
  return fallback;
}

/**
 * @param {number|string} trackId
 * @param {{ country?: string }} [opts]
 */
async function getSongDetail(trackId, opts = {}) {
  const id = Math.floor(Number(trackId));
  if (!Number.isFinite(id) || id <= 0) return null;
  const countries = [];
  const forced = String(opts.country || "").trim().toUpperCase();
  if (forced) countries.push(forced);
  else countries.push("", "HK", "US", "TW");
  for (const country of countries) {
    let path = "/lookup?id=" + id + "&entity=song";
    if (country) path += "&country=" + encodeURIComponent(country);
    const data = await getJson(path);
    const results = Array.isArray(data && data.results) ? data.results : [];
    for (const r of results) {
      if (Number(r.trackId) === id) {
        const t = normalizeTrack(r);
        if (t) return t;
      }
    }
  }
  return null;
}

/**
 * 点歌解析：唯一可播 → ready；多候选 → needs_choice；否则 error。
 * @param {string} query
 * @param {{ limit?: number, pick_id?: number }} [opts]
 */
async function resolvePlayQuery(query, opts = {}) {
  const pickId = Math.floor(Number(opts.pick_id));
  if (Number.isFinite(pickId) && pickId > 0) {
    const song = await getSongDetail(pickId);
    if (song && song.playable) {
      return { ok: true, status: "ready", song };
    }
    return {
      ok: false,
      status: "error",
      error: {
        code: "MUSIC_NOT_FOUND",
        message: "这首在 Apple 目录里找不到或不可用",
      },
    };
  }
  const q = String(query || "").trim();
  if (!q) {
    return {
      ok: false,
      status: "error",
      error: { code: "NEED_QUERY", message: "请给歌名或歌手" },
    };
  }
  let list;
  try {
    list = await searchSongs(q, { limit: opts.limit });
  } catch (e) {
    return {
      ok: false,
      status: "error",
      error: {
        code: e.code || "MUSIC_SOURCE_UNAVAILABLE",
        message: String((e && e.message) || e).slice(0, 120),
      },
    };
  }
  const playable = list.filter((t) => t && t.playable);
  if (!playable.length) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "MUSIC_NO_MATCH",
        message: "没有找到可播的匹配，可补充歌手名再试",
      },
    };
  }
  if (playable.length === 1) {
    return { ok: true, status: "ready", song: playable[0] };
  }
  const ranked = rankAgainstQuery(q, playable);
  const top = ranked[0];
  const second = ranked[1];
  /* 歌名+歌手都命中（含繁简）：同名多版本优先非 Live */
  if (top && top.s >= 5) {
    const same = ranked.filter(
      (x) =>
        x.s >= 5 &&
        simpTrad(x.t.name) === simpTrad(top.t.name) &&
        simpTrad(x.t.artist) === simpTrad(top.t.artist)
    );
    const studio =
      same.find(
        (x) => !/live|演唱會|巡演|现场|現場/i.test(String(x.t.album || ""))
      ) || same[0] || top;
    return { ok: true, status: "ready", song: studio.t };
  }
  if (top && top.s >= 3 && (!second || top.s > second.s)) {
    return { ok: true, status: "ready", song: top.t };
  }
  return {
    ok: false,
    status: "needs_choice",
    candidates: playable.slice(0, 6).map((t) => ({
      provider: t.provider,
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: t.album,
      playable: t.playable,
      preview_only: t.preview_only,
    })),
  };
}

if (require.main === module) {
  (async () => {
    const list = await searchSongs("夜曲 周杰伦", { limit: 3 });
    console.assert(Array.isArray(list) && list.length >= 1, list);
    console.assert(list[0].provider === "apple" && list[0].id);
    console.assert(list[0].apple_url || list[0].preview_url);
    const one = await getSongDetail(list[0].id);
    console.assert(one && one.id === list[0].id);
    const amb = await resolvePlayQuery("夜");
    console.assert(
      amb.status === "needs_choice" || amb.status === "ready",
      amb
    );
    const ready = await resolvePlayQuery("夜曲 周杰伦");
    console.assert(ready.status === "ready" && ready.song, ready);
    console.log("apple-catalog ok", {
      n: list.length,
      sample: list[0].name,
      ready: ready.song && ready.song.name,
    });
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  PROVIDER,
  searchSongs,
  getSongDetail,
  resolvePlayQuery,
  normalizeTrack,
};
