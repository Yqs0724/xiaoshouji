/**
 * 网易云音源适配（Cove 阶段 A）：经本机兼容 API（如 NeteaseCloudMusicApi）搜歌/取流。
 * Cookie 只读服务端设定，不进前端、不进 LLM。
 */
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const PROVIDER = "netease";

function readMusicConfig() {
  let base = String(process.env.NETEASE_API_BASE_URL || "").trim();
  let cookie = String(process.env.NETEASE_COOKIE || "").trim();
  let quality = String(process.env.NETEASE_MUSIC_QUALITY || "").trim();
  try {
    const s = require("../../共读app/gateway/settings").readSettings();
    if (!base) base = String(s.netease_api_base_url || "").trim();
    if (!cookie) cookie = String(s.netease_cookie || "").trim();
    if (!quality) quality = String(s.netease_music_quality || "").trim();
  } catch (_) {}
  if (!base) base = "http://127.0.0.1:3000";
  base = base.replace(/\/+$/, "");
  quality = quality || "exhigh";
  return { base, cookie, quality };
}

function isConfigured() {
  const { base } = readMusicConfig();
  return !!base;
}

function httpGetJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      const err = new Error("音源 API 地址无效");
      err.code = "bad_api_base";
      reject(err);
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Ariadne/1.0",
          ...headers,
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error("网易云 API HTTP " + res.statusCode);
            err.code = "netease_http";
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch {
            const err = new Error("网易云 API 返回非 JSON");
            err.code = "netease_bad_json";
            reject(err);
          }
        });
      }
    );
    req.on("error", (e) => {
      const err = new Error(
        "连不上网易云兼容 API（" +
          String((e && e.message) || e).slice(0, 80) +
          "）。请先本机启动 NeteaseCloudMusicApi。"
      );
      err.code = "netease_unreachable";
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      const err = new Error("网易云 API 超时");
      err.code = "netease_timeout";
      reject(err);
    });
    req.end();
  });
}

function apiGet(pathnameAndQuery) {
  const { base, cookie } = readMusicConfig();
  let path = pathnameAndQuery.startsWith("/")
    ? pathnameAndQuery
    : "/" + pathnameAndQuery;
  /* NeteaseCloudMusicApi 习惯：cookie 既可 Header 也可 query（教程 §6.1 完整 Cookie） */
  if (cookie && !/[?&]cookie=/.test(path)) {
    path +=
      (path.includes("?") ? "&" : "?") +
      "cookie=" +
      encodeURIComponent(cookie);
  }
  const url = base + path;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  return httpGetJson(url, headers);
}

function normalizeTrack(raw, extra = {}) {
  if (!raw) return null;
  const id = Math.floor(Number(raw.id));
  if (!Number.isFinite(id) || id <= 0) return null;
  const name = String(raw.name || "").trim();
  if (!name) return null;
  const artists = Array.isArray(raw.artists)
    ? raw.artists
    : Array.isArray(raw.ar)
      ? raw.ar
      : [];
  const artist = artists
    .map((a) => String((a && a.name) || "").trim())
    .filter(Boolean)
    .join(" / ");
  const albumObj = raw.album || raw.al || {};
  const album = String(albumObj.name || "").trim();
  let cover = String(
    albumObj.picUrl ||
      (raw.al && raw.al.picUrl) ||
      raw.picUrl ||
      raw.cover ||
      ""
  ).trim();
  /* 搜歌结果常只有小图；播放卡要更清晰 */
  if (cover && /^https?:\/\//i.test(cover)) {
    if (/\?param=\d+y\d+/i.test(cover)) {
      cover = cover.replace(/\?param=\d+y\d+/i, "?param=300y300");
    } else if (!/[?&]param=/i.test(cover)) {
      cover += (cover.includes("?") ? "&" : "?") + "param=300y300";
    }
  }
  const out = {
    provider: PROVIDER,
    id,
    song_key: PROVIDER + ":" + id,
    name,
    artist,
    album,
    cover: cover || undefined,
    duration_ms: Math.max(0, Math.floor(Number(raw.duration || raw.dt) || 0)),
    playable: extra.playable !== false,
    stream_path: "/api/v1/music/stream/netease/" + id,
  };
  if (extra.audio_url) out._audio_url = String(extra.audio_url);
  return out;
}

async function searchSongs(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(20, Math.floor(Number(opts.limit) || 8)));
  /* cloudsearch 对登录态更友好，会员曲更容易出现；失败再回落 /search */
  let songs = [];
  try {
    const cloud = await apiGet(
      "/cloudsearch?keywords=" +
        encodeURIComponent(q) +
        "&type=1&limit=" +
        limit
    );
    songs =
      (cloud && cloud.result && cloud.result.songs) ||
      (cloud && cloud.data && cloud.data.songs) ||
      [];
  } catch (_) {
    songs = [];
  }
  if (!songs.length) {
    const data = await apiGet(
      "/search?keywords=" +
        encodeURIComponent(q) +
        "&type=1&limit=" +
        limit
    );
    songs =
      (data && data.result && data.result.songs) ||
      (data && data.data && data.data.songs) ||
      [];
  }
  const out = [];
  const seen = new Set();
  for (const s of songs) {
    const t = normalizeTrack(s);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

async function getSongDetail(songId) {
  const id = Math.floor(Number(songId));
  if (!Number.isFinite(id) || id <= 0) return null;
  const data = await apiGet("/song/detail?ids=" + id);
  const songs = (data && data.songs) || (data && data.data && data.data.songs) || [];
  const raw = songs.find((s) => Number(s.id) === id) || songs[0];
  return normalizeTrack(raw);
}

/** Cove 阶段 A：无音源时的可见错误（不笼统写 VIP）。 */
function audioUnavailableError() {
  const { cookie } = readMusicConfig();
  const err = new Error(
    cookie
      ? "这首暂时没有可播音源（可能会员专享、版权或已下架）"
      : "没有可播音源 · 请先在设定「共听音源」扫码登录网易云"
  );
  err.code = "MUSIC_NO_AUDIO";
  return err;
}

/** 把后端 error code 收成用户可读句（前端/代理共用）。 */
function explainMusicError(code, fallback) {
  const c = String(code || "").trim();
  const map = {
    MUSIC_NO_AUDIO: "没有可播音源（会员/版权/登录态）",
    MUSIC_TRIAL_ONLY: "只有试听片段，整曲需会员或重新扫码登录",
    MUSIC_NOT_FOUND: "歌曲不存在或已下架",
    MUSIC_NO_MATCH: "没有找到匹配歌曲",
    NEED_QUERY: "请给歌名或歌手",
    netease_unreachable: "连不上网易云兼容 API，请先启动本机 :3000",
    netease_timeout: "网易云 API 超时",
    netease_http: "网易云兼容 API 返回错误",
    bad_api_base: "音源 API 地址无效",
    bad_audio_url: "音源地址无效",
    bad_audio_proto: "音源协议不允许",
    ssrf_blocked: "拒绝代理不安全地址",
    proxy_failed: "音源代理失败，请检查网络后重试",
    upstream_audio: "上游音源不可用，可换一首再试",
    url_failed: "取流失败",
  };
  if (map[c]) return map[c];
  const msg = String(fallback || "").trim();
  return msg ? msg.slice(0, 160) : "播放失败";
}

/**
 * 取可播 URL；失败返回 null（VIP/下架/未登录等）。
 */
async function getAudioUrl(songId, quality) {
  const id = Math.floor(Number(songId));
  if (!Number.isFinite(id) || id <= 0) return null;
  const { quality: qDefault } = readMusicConfig();
  const levels = [];
  const want = String(quality || qDefault || "exhigh").trim();
  const ladder = [
    "jymaster",
    "sky",
    "jyeffect",
    "hires",
    "lossless",
    "exhigh",
    "higher",
    "standard",
  ];
  if (want) levels.push(want);
  for (const lv of ladder) {
    if (!levels.includes(lv)) levels.push(lv);
  }
  function pickPlayableUrl(hit) {
    if (!hit || !hit.url) return null;
    /* 免费试听片段（常约几十秒）≠ 整曲；教程 §4.2 / §21 会员与登录态 */
    const trial = hit.freeTrialInfo;
    if (trial && typeof trial === "object") {
      const start = Number(trial.start);
      const end = Number(trial.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const err = new Error(
          "当前只有试听片段（约 " +
            Math.max(1, Math.round(end - start)) +
            " 秒），整曲需会员或重新扫码登录"
        );
        err.code = "MUSIC_TRIAL_ONLY";
        throw err;
      }
    }
    return String(hit.url);
  }

  let lastErr = null;
  for (const level of levels) {
    try {
      let data = await apiGet(
        "/song/url/v1?id=" + id + "&level=" + encodeURIComponent(level)
      );
      let list = (data && data.data) || [];
      if (!Array.isArray(list)) list = list ? [list] : [];
      let hit = list.find((x) => x && x.url);
      const u1 = pickPlayableUrl(hit);
      if (u1) return u1;
      data = await apiGet("/song/url?id=" + id);
      list = (data && data.data) || [];
      if (!Array.isArray(list)) list = list ? [list] : [];
      hit =
        list.find((x) => x && Number(x.id) === id && x.url) ||
        list.find((x) => x && x.url);
      const u2 = pickPlayableUrl(hit);
      if (u2) return u2;
    } catch (e) {
      lastErr = e;
      if (
        e &&
        (e.code === "netease_unreachable" ||
          e.code === "netease_timeout" ||
          e.code === "MUSIC_TRIAL_ONLY")
      ) {
        throw e;
      }
      /* try next level */
    }
  }
  if (lastErr && lastErr.code === "bad_api_base") throw lastErr;
  if (lastErr && lastErr.code === "MUSIC_TRIAL_ONLY") throw lastErr;
  return null;
}

function scoreTrack(q, t) {
  const ql = String(q || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  const nl = String(t.name || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  const al = String(t.artist || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  let s = 0;
  if (nl && ql.includes(nl)) s += 3;
  if (al && ql.includes(al)) s += 2;
  return s;
}

/**
 * @param {string} query
 * @param {{ limit?: number, pick_id?: number, skip_url_check?: boolean }} [opts]
 */
async function resolvePlayQuery(query, opts = {}) {
  const pickId = Math.floor(Number(opts.pick_id));
  if (Number.isFinite(pickId) && pickId > 0) {
    const detail = await getSongDetail(pickId);
    if (!detail) {
      return {
        ok: false,
        status: "error",
        error: { code: "MUSIC_NOT_FOUND", message: "歌曲不存在或已下架" },
      };
    }
    if (!opts.skip_url_check) {
      let url = null;
      try {
        url = await getAudioUrl(pickId);
      } catch (e) {
        return {
          ok: false,
          status: "error",
          error: {
            code: e.code || "url_failed",
            message: explainMusicError(e.code, e.message),
          },
        };
      }
      if (!url) {
        const e = audioUnavailableError();
        return {
          ok: false,
          status: "error",
          error: { code: e.code, message: e.message },
        };
      }
      detail.playable = true;
    }
    return { ok: true, status: "ready", song: detail };
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
        message: explainMusicError(e.code, e.message),
      },
    };
  }
  if (!list.length) {
    return {
      ok: false,
      status: "error",
      error: { code: "MUSIC_NO_MATCH", message: "没有找到匹配歌曲" },
    };
  }

  const ranked = list
    .map((t) => ({ t, s: scoreTrack(q, t) }))
    .sort((a, b) => b.s - a.s);

  /* 先对前几名验可播，避免 needs_choice 一堆灰曲 */
  const verified = [];
  for (const row of ranked.slice(0, 6)) {
    if (opts.skip_url_check) {
      verified.push(row.t);
      continue;
    }
    try {
      const url = await getAudioUrl(row.t.id);
      if (url) {
        row.t.playable = true;
        verified.push(row.t);
      }
    } catch (_) {}
  }
  if (!verified.length) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "MUSIC_NO_AUDIO",
        message: "搜到了但都拿不到音源；可填网易云 Cookie 或换一首",
      },
    };
  }
  if (verified.length === 1) {
    return { ok: true, status: "ready", song: verified[0] };
  }
  const top = ranked.find((r) => verified.some((v) => v.id === r.t.id));
  const second = ranked.filter((r) => verified.some((v) => v.id === r.t.id))[1];
  if (top && top.s >= 5) {
    return { ok: true, status: "ready", song: top.t };
  }
  if (top && top.s >= 3 && (!second || top.s > second.s)) {
    return { ok: true, status: "ready", song: top.t };
  }
  return {
    ok: false,
    status: "needs_choice",
    candidates: verified.slice(0, 6).map((t) => ({
      provider: t.provider,
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: t.album,
      playable: true,
    })),
  };
}

async function pingApi() {
  try {
    await apiGet("/search?keywords=test&limit=1");
    return { ok: true, base: readMusicConfig().base };
  } catch (e) {
    return {
      ok: false,
      base: readMusicConfig().base,
      error: e.code || "ping_failed",
      message: String((e && e.message) || e).slice(0, 160),
    };
  }
}

/** 扫码登录：生成二维码（需兼容 API 支持 /login/qr/*） */
async function startQrLogin() {
  const keyData = await apiGet(
    "/login/qr/key?timestamp=" + Date.now()
  );
  const unikey =
    (keyData && keyData.data && keyData.data.unikey) ||
    (keyData && keyData.unikey) ||
    "";
  if (!unikey) {
    return {
      ok: false,
      error: "qr_key_failed",
      message: "拿不到二维码 key，请确认兼容 API 已起",
    };
  }
  const qrData = await apiGet(
    "/login/qr/create?key=" +
      encodeURIComponent(unikey) +
      "&qrimg=true&timestamp=" +
      Date.now()
  );
  const qrimg =
    (qrData && qrData.data && qrData.data.qrimg) ||
    (qrData && qrData.qrimg) ||
    "";
  const qrurl =
    (qrData && qrData.data && qrData.data.qrurl) ||
    (qrData && qrData.qrurl) ||
    "";
  if (!qrimg && !qrurl) {
    return {
      ok: false,
      error: "qr_create_failed",
      message: "生成二维码失败",
    };
  }
  return {
    ok: true,
    key: unikey,
    qrimg: qrimg || "",
    qrurl: qrurl || "",
  };
}

/**
 * 轮询扫码结果；成功则写入 settings.netease_cookie。
 * @param {string} key
 */
async function checkQrLogin(key) {
  const k = String(key || "").trim();
  if (!k) {
    return { ok: false, error: "need_key", message: "缺少二维码 key" };
  }
  const data = await apiGet(
    "/login/qr/check?key=" +
      encodeURIComponent(k) +
      "&timestamp=" +
      Date.now()
  );
  const code = Number(data && data.code);
  /* 800 过期 · 801 待扫 · 802 待确认 · 803 成功 */
  if (code === 800) {
    return { ok: false, status: "expired", message: "二维码已过期，请重新生成" };
  }
  if (code === 801) {
    return { ok: true, status: "waiting", message: "等待扫码" };
  }
  if (code === 802) {
    return { ok: true, status: "confirm", message: "已扫码，请在手机上确认" };
  }
  if (code === 803) {
    let cookie = String((data && data.cookie) || "").trim();
    if (!cookie && data && data.data && data.data.cookie) {
      cookie = String(data.data.cookie).trim();
    }
    /* 有的实现返回 Set-Cookie 风格数组 */
    if (!cookie && Array.isArray(data.cookie)) {
      cookie = data.cookie.join("; ");
    }
    if (!cookie) {
      return {
        ok: false,
        status: "error",
        message: "登录成功但未返回 Cookie，请改用手动粘贴",
      };
    }
    try {
      const { patchSettings, sanitizeNeteaseCookie } = require(
        "../../共读app/gateway/settings"
      );
      const cleaned = sanitizeNeteaseCookie(cookie);
      patchSettings({
        netease_cookie: cleaned || cookie,
      });
    } catch (e) {
      return {
        ok: false,
        status: "error",
        message: "Cookie 写入失败：" + String((e && e.message) || e).slice(0, 80),
      };
    }
    return {
      ok: true,
      status: "authorized",
      message: "已登录并保存 Cookie",
      cookie_set: true,
    };
  }
  return {
    ok: false,
    status: "unknown",
    message: "未知状态 code=" + code,
    code,
  };
}

if (require.main === module) {
  (async () => {
    /* ponytail: 阶段 A 错误文案自检，不依赖 API */
    console.assert(
      explainMusicError("MUSIC_NO_AUDIO").includes("音源"),
      "explain no_audio"
    );
    console.assert(
      explainMusicError("netease_unreachable").includes("3000"),
      "explain unreachable"
    );
    console.assert(
      audioUnavailableError().code === "MUSIC_NO_AUDIO",
      "unavailable code"
    );
    console.assert(typeof likeSong === "function", "likeSong export");
    console.assert(typeof getLyric === "function", "getLyric export");
    console.assert(typeof getHotComments === "function", "getHotComments");
    console.assert(typeof getUserListenProfile === "function", "profile");
    console.assert(typeof getMvUrl === "function", "mv deferred hook");
    const ping = await pingApi();
    console.log("ping", ping);
    if (!ping.ok) {
      console.log("netease-catalog skip live (API 未起)；结构自检 ok");
      process.exit(0);
    }
    const detail = await getSongDetail(186016); /* 晴天常见 id，失败也无所谓 */
    console.log("detail sample", detail && detail.name);
    const r = await resolvePlayQuery("晴天 周杰伦", { limit: 5 });
    console.assert(r.status === "ready" || r.status === "needs_choice" || r.status === "error", r);
    console.log("netease-catalog ok", r.status, r.song && r.song.name);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/**
 * 从「分享xxx的歌单：https://…」整段文案里抠出 URL / 数字 ID。
 * @param {string|number} value
 * @returns {string}
 */
function extractPlaylistInput(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{5,}$/.test(s)) return s;
  const url =
    s.match(/https?:\/\/[^\s\]）)】>"]+/i) ||
    s.match(/music\.163\.com[^\s\]）)】>"]*/i);
  if (url) {
    let u = url[0].replace(/[，。；、,.]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  }
  return s;
}

/**
 * 解析歌单分享链或纯数字 ID。
 * @param {string|number} value
 * @returns {number|null}
 */
function resolvePlaylistId(value) {
  const s = extractPlaylistInput(value);
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return Math.floor(Number(s));
  const m =
    s.match(/[?#&]id=(\d+)/i) ||
    s.match(/playlist[\/?#?]*id=(\d+)/i) ||
    s.match(/\/playlist\/(\d+)/i) ||
    s.match(/songlist\/(\d+)/i) ||
    s.match(/[?&]playlistId=(\d+)/i);
  if (m) return Math.floor(Number(m[1]));
  return null;
}

/**
 * 短链（163cn.tv 等）跟一次跳转，再解析 id。
 * @param {string} urlStr
 * @returns {Promise<number|null>}
 */
function resolvePlaylistIdViaRedirect(urlStr) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve(null);
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 AriadnePlaylist",
          Accept: "text/html,*/*",
        },
        timeout: 12_000,
      },
      (res) => {
        const loc = res.headers.location;
        res.resume();
        if (loc) {
          try {
            const abs = new URL(loc, u).href;
            resolve(resolvePlaylistId(abs));
          } catch {
            resolve(null);
          }
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8").slice(0, 80_000);
          const hit =
            html.match(/[?&#]id=(\d{5,})/i) ||
            html.match(/playlist[\/?#]+(\d{5,})/i) ||
            html.match(/"playlistId"\s*:\s*(\d{5,})/i);
          resolve(hit ? Math.floor(Number(hit[1])) : null);
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * @param {string|number} playlistIdOrUrl
 * @param {{ limit?: number }} [opts]
 */
async function getPlaylistDetail(playlistIdOrUrl, opts = {}) {
  const raw = extractPlaylistInput(playlistIdOrUrl);
  let id = resolvePlaylistId(raw);
  if (!id && /^https?:\/\//i.test(raw)) {
    id = await resolvePlaylistIdViaRedirect(raw);
  }
  if (!id) {
    const err = new Error(
      "歌单链接或 ID 无效。请贴完整分享链（含 https），或纯数字歌单 ID"
    );
    err.code = "bad_playlist_id";
    throw err;
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit) || 200)));
  const data = await apiGet("/playlist/detail?id=" + id);
  const pl = (data && data.playlist) || (data && data.result) || {};
  const name = String(pl.name || "未命名歌单").trim() || "未命名歌单";
  let rawTracks = Array.isArray(pl.tracks) ? pl.tracks : [];
  const trackCount = Math.max(
    Number(pl.trackCount) || 0,
    rawTracks.length
  );
  if (rawTracks.length < Math.min(limit, trackCount || limit)) {
    try {
      const all = await apiGet(
        "/playlist/track/all?id=" +
          id +
          "&limit=" +
          limit +
          "&offset=0"
      );
      if (Array.isArray(all.songs) && all.songs.length) rawTracks = all.songs;
    } catch (_) {
      /* 保留 detail 里的 tracks */
    }
  }
  const tracks = [];
  const seen = new Set();
  for (const raw of rawTracks) {
    if (tracks.length >= limit) break;
    const t = normalizeTrack(raw);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    tracks.push(t);
  }
  return {
    id,
    name,
    source: PROVIDER,
    track_count: tracks.length,
    updated_at: Math.floor(Date.now() / 1000),
    cover: String((pl.coverImgUrl || pl.picUrl || "") + "").trim() || undefined,
    tracks,
  };
}

/**
 * 红心 / 取消红心（需登录 Cookie）。
 * @param {number|string} songId
 * @param {boolean} like
 */
async function likeSong(songId, like = true) {
  const sid = Math.floor(Number(songId));
  if (!Number.isFinite(sid) || sid <= 0) {
    const err = new Error("歌曲 ID 无效");
    err.code = "bad_song_id";
    throw err;
  }
  const want = like !== false;
  const data = await apiGet(
    "/like?id=" + sid + "&like=" + (want ? "true" : "false")
  );
  const code = Number(
    data && data.body && data.body.code != null
      ? data.body.code
      : data && data.code
  );
  if (code && code !== 200) {
    const err = new Error(
      (data && (data.message || data.msg)) ||
        "红心同步失败（需扫码登录网易云）"
    );
    err.code = "like_failed";
    throw err;
  }
  return { ok: true, id: sid, liked: want };
}

/**
 * 歌词（LRC + 纯文本）。
 * @param {number|string} songId
 */
async function getLyric(songId) {
  const sid = Math.floor(Number(songId));
  if (!Number.isFinite(sid) || sid <= 0) {
    const err = new Error("歌曲 ID 无效");
    err.code = "bad_song_id";
    throw err;
  }
  const data = await apiGet("/lyric?id=" + sid);
  const lrc = String(
    (data && data.lrc && data.lrc.lyric) ||
      (data && data.lyric) ||
      ""
  ).trim();
  const tlyric = String(
    (data && data.tlyric && data.tlyric.lyric) || ""
  ).trim();
  const parseLrc = (raw) => {
    const out = [];
    const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]([^\n\r]*)/g;
    let m;
    while ((m = re.exec(String(raw || "")))) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const msPart = m[3]
        ? Number(String(m[3]).padEnd(3, "0").slice(0, 3))
        : 0;
      const text = String(m[4] || "").trim();
      if (!text) continue;
      out.push({ t: min * 60 + sec + msPart / 1000, text });
    }
    return out;
  };
  const lines = parseLrc(lrc);
  const tlines = parseLrc(tlyric);
  const tmap = new Map();
  for (const row of tlines) {
    tmap.set(Math.round(row.t * 10), row.text);
  }
  for (const row of lines) {
    const key = Math.round(row.t * 10);
    let trans = tmap.get(key) || "";
    if (!trans) {
      /* 差一格也对一下，网易云有时毫秒对不齐 */
      trans = tmap.get(key - 1) || tmap.get(key + 1) || "";
    }
    if (trans) row.trans = trans;
  }
  return {
    ok: true,
    id: sid,
    lrc,
    tlyric,
    has_trans: lines.some((x) => !!x.trans),
    lines,
    plain: lines.map((x) => x.text).join("\n") || lrc.replace(/\[[^\]]*\]/g, "").trim(),
  };
}

/**
 * 热门评论（短列表）。
 * @param {number|string} songId
 * @param {{ limit?: number }} [opts]
 */
async function getHotComments(songId, opts = {}) {
  const sid = Math.floor(Number(songId));
  if (!Number.isFinite(sid) || sid <= 0) {
    const err = new Error("歌曲 ID 无效");
    err.code = "bad_song_id";
    throw err;
  }
  const limit = Math.max(1, Math.min(20, Math.floor(Number(opts.limit) || 8)));
  const data = await apiGet(
    "/comment/music?id=" + sid + "&limit=" + limit
  );
  const hot =
    (data && data.hotComments) ||
    (data && data.body && data.body.hotComments) ||
    [];
  const comments = (Array.isArray(hot) ? hot : [])
    .slice(0, limit)
    .map((c) => ({
      id: c && c.commentId != null ? c.commentId : undefined,
      content: String((c && c.content) || "").trim().slice(0, 280),
      nickname: String(
        (c && c.user && c.user.nickname) || "网友"
      ).trim().slice(0, 40),
      liked_count: Math.max(0, Math.floor(Number(c && c.likedCount) || 0)),
    }))
    .filter((c) => c.content);
  return { ok: true, id: sid, comments };
}

/** 当前登录账号（Cookie）；失败返回 null */
async function getLoginAccount() {
  try {
    const data = await apiGet("/user/account");
    const profile = (data && data.profile) || (data && data.body && data.body.profile);
    const account = (data && data.account) || (data && data.body && data.body.account);
    const uid = Math.floor(
      Number(
        (profile && profile.userId) ||
          (account && account.id) ||
          0
      )
    );
    if (!uid) return null;
    return {
      uid,
      nickname: String((profile && profile.nickname) || "").trim(),
      avatar: String((profile && profile.avatarUrl) || "").trim(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 听歌排行 + 简易资料（「机眼里的你」）。
 * @param {{ uid?: number, type?: 0|1 }} [opts] type 1=周榜 0=全部
 */
async function getUserListenProfile(opts = {}) {
  let uid = Math.floor(Number(opts.uid) || 0);
  let account = null;
  if (!uid) {
    account = await getLoginAccount();
    uid = account ? account.uid : 0;
  }
  if (!uid) {
    const err = new Error("未登录网易云，请先在设定扫码");
    err.code = "need_login";
    throw err;
  }
  const type = opts.type === 0 ? 0 : 1;
  let detail = null;
  try {
    const d = await apiGet("/user/detail?uid=" + uid);
    detail = (d && d.profile) || (d && d.body && d.body.profile) || null;
  } catch (_) {
    detail = null;
  }
  const rec = await apiGet("/user/record?uid=" + uid + "&type=" + type);
  const weekData =
    (rec && rec.weekData) ||
    (rec && rec.allData) ||
    (rec && rec.body && (rec.body.weekData || rec.body.allData)) ||
    [];
  const records = (Array.isArray(weekData) ? weekData : [])
    .slice(0, 30)
    .map((row) => {
      const song = row && row.song;
      const t = normalizeTrack(song);
      if (!t) return null;
      return {
        ...t,
        play_count: Math.max(0, Math.floor(Number(row.playCount) || 0)),
      };
    })
    .filter(Boolean);
  return {
    ok: true,
    uid,
    nickname:
      String((detail && detail.nickname) || (account && account.nickname) || "").trim() ||
      "你",
    avatar:
      String((detail && detail.avatarUrl) || (account && account.avatar) || "").trim(),
    signature: String((detail && detail.signature) || "").trim().slice(0, 120),
    level: Math.max(0, Math.floor(Number(detail && detail.level) || 0)),
    record_type: type === 0 ? "all" : "week",
    records,
  };
}

/**
 * 红心歌单（需登录 Cookie）。/likelist → /song/detail 分批补全。
 * @param {{ limit?: number, uid?: number }} [opts]
 */
async function getLikedSongs(opts = {}) {
  let uid = Math.floor(Number(opts.uid) || 0);
  let account = null;
  if (!uid) {
    account = await getLoginAccount();
    uid = account ? account.uid : 0;
  }
  if (!uid) {
    const err = new Error("未登录网易云，请先在设定扫码");
    err.code = "need_login";
    throw err;
  }
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 100)));
  const data = await apiGet("/likelist?uid=" + uid);
  const idsRaw =
    (data && data.ids) ||
    (data && data.body && data.body.ids) ||
    [];
  const allIds = (Array.isArray(idsRaw) ? idsRaw : [])
    .map((x) => Math.floor(Number(x)))
    .filter((x) => Number.isFinite(x) && x > 0);
  const total = allIds.length;
  const ids = allIds.slice(0, limit);
  const songs = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    try {
      const detail = await apiGet("/song/detail?ids=" + batch.join(","));
      const rawSongs =
        (detail && detail.songs) ||
        (detail && detail.data && detail.data.songs) ||
        [];
      for (const raw of rawSongs) {
        const t = normalizeTrack(raw);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        songs.push(t);
      }
    } catch (_) {
      /* 批失败则跳过 */
    }
  }
  return {
    ok: true,
    uid,
    nickname:
      String((account && account.nickname) || "").trim() || "你",
    count: total,
    songs,
  };
}

/**
 * MV 地址（S6 后置：默认不播，仅解析）。
 * @param {number|string} mvId
 */
async function getMvUrl(mvId) {
  const mid = Math.floor(Number(mvId));
  if (!Number.isFinite(mid) || mid <= 0) {
    const err = new Error("MV ID 无效");
    err.code = "bad_mv_id";
    throw err;
  }
  /* ponytail: S6 MV/悬浮窗后置；默认关，避免与 Cove 单播叠声。升级：独立 media 轨 + UI 开关 */
  const data = await apiGet("/mv/url?id=" + mid);
  const url = String(
    (data && data.data && data.data.url) ||
      (data && data.url) ||
      ""
  ).trim();
  return {
    ok: true,
    id: mid,
    url: url || null,
    deferred: true,
    enabled: false,
  };
}

/**
 * 把歌加入用户自有网易云歌单（需已扫码）。
 * @param {number} playlistId
 * @param {number} songId
 */
async function addSongToUserPlaylist(playlistId, songId) {
  const pid = Math.floor(Number(playlistId));
  const sid = Math.floor(Number(songId));
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(sid) || sid <= 0) {
    const err = new Error("歌单或歌曲 ID 无效");
    err.code = "bad_ids";
    throw err;
  }
  const data = await apiGet(
    "/playlist/tracks?op=add&pid=" +
      pid +
      "&tracks=" +
      sid
  );
  const code = Number(data && data.body && data.body.code != null
    ? data.body.code
    : data && data.code);
  if (code && code !== 200) {
    const err = new Error(
      (data && data.message) || "加入歌单失败（需登录且是自己的歌单）"
    );
    err.code = "add_playlist_failed";
    throw err;
  }
  return { ok: true, playlist_id: pid, song_id: sid };
}

module.exports = {
  PROVIDER,
  isConfigured,
  readMusicConfig,
  searchSongs,
  getSongDetail,
  getAudioUrl,
  audioUnavailableError,
  explainMusicError,
  resolvePlayQuery,
  extractPlaylistInput,
  resolvePlaylistId,
  getPlaylistDetail,
  addSongToUserPlaylist,
  likeSong,
  getLyric,
  getHotComments,
  getLoginAccount,
  getUserListenProfile,
  getLikedSongs,
  getMvUrl,
  pingApi,
  startQrLogin,
  checkQrLogin,
};
