/**
 * Cove：后端代理音频流（Range / 206），前端不持有临时 CDN。
 */
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".local")) return true;
  if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function assertAudioUrlAllowed(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    const err = new Error("音源地址无效");
    err.code = "bad_audio_url";
    throw err;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    const err = new Error("音源协议不允许");
    err.code = "bad_audio_proto";
    throw err;
  }
  if (isPrivateOrLocalHost(u.hostname)) {
    const err = new Error("拒绝代理内网地址");
    err.code = "ssrf_blocked";
    throw err;
  }
  return u;
}

/**
 * 把上游音频流式转给浏览器（支持 Range）。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} audioUrl
 * @param {{ referer?: string }} [opts]
 */
function proxyAudioStream(req, res, audioUrl, opts = {}) {
  const u = assertAudioUrlAllowed(audioUrl);
  const lib = u.protocol === "https:" ? https : http;
  const range = req.headers.range;
  const upstreamHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: opts.referer || "https://music.163.com/",
    Accept: "*/*",
  };
  if (range) upstreamHeaders.Range = range;

  /* ponytail: 整曲流可能数分钟；勿用短 timeout 在浏览器背压空闲时掐断（表现为「只能听一部分」） */
  const upstream = lib.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: upstreamHeaders,
    },
    (up) => {
      const status = up.statusCode || 502;
      if (status >= 400 && status !== 206) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "upstream_audio",
            message:
              status === 403 || status === 401
                ? "上游拒绝音源（版权/登录态），可换一首或重新扫码"
                : "上游音源不可用（HTTP " + status + "）",
          })
        );
        up.resume();
        return;
      }
      const headers = {
        "Content-Type": up.headers["content-type"] || "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      if (up.headers["content-length"]) {
        headers["Content-Length"] = up.headers["content-length"];
      }
      if (up.headers["content-range"]) {
        headers["Content-Range"] = up.headers["content-range"];
      }
      res.writeHead(status === 206 ? 206 : 200, headers);
      up.pipe(res);
      req.on("close", () => {
        try {
          up.destroy();
        } catch (_) {}
      });
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "proxy_failed",
          message: "音源代理失败",
        })
      );
    } else {
      try {
        res.destroy();
      } catch (_) {}
    }
  });
  upstream.setTimeout(120_000);
  upstream.on("timeout", () => {
    /* 仅连接阶段卡住才杀；已开始传流则靠 pipe/close */
    if (!upstream.destroyed && !res.headersSent) {
      upstream.destroy();
    }
  });
  upstream.end();
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string|number} songId
 * @param {string} [quality]
 */
async function handleNeteaseStream(req, res, songId, quality) {
  const {
    getAudioUrl,
    audioUnavailableError,
    explainMusicError,
  } = require("./netease-catalog");
  let audioUrl;
  try {
    audioUrl = await getAudioUrl(songId, quality);
  } catch (e) {
    const code = e.code || "url_failed";
    const status =
      code === "netease_unreachable" || code === "netease_timeout" ? 502 : 502;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: false,
        error: code,
        message: explainMusicError(code, e && e.message),
      })
    );
    return;
  }
  if (!audioUrl) {
    const e = audioUnavailableError();
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: false,
        error: e.code,
        message: e.message,
      })
    );
    return;
  }
  proxyAudioStream(req, res, audioUrl, { referer: "https://music.163.com/" });
}

module.exports = {
  proxyAudioStream,
  handleNeteaseStream,
  assertAudioUrlAllowed,
};
