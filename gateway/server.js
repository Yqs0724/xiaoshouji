const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("./load-env").loadEnv();
const { readSettings, patchSettings, healthFlags, listLlmModels } = require("./settings");
const { readBooks, syncFromWeread } = require("./books");
const { getHighlights, syncHighlights } = require("./highlights");
const { followPending } = require("./follow");
const { listSessions, getSession, buildSummary, endSession } = require("./sessions");

const PORT = Number(process.env.PORT) || 8787;
const PWA_ROOT = path.join(__dirname, "..", "pwa");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function servePwa(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.normalize(path.join(PWA_ROOT, urlPath));
  if (!filePath.startsWith(PWA_ROOT + path.sep) && filePath !== PWA_ROOT) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && urlPath === "/api/v1/health") {
    const flags = healthFlags();
    sendJson(res, 200, { ok: true, gateway: "up", ...flags });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/settings") {
    sendJson(res, 200, readSettings());
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/models") {
    sendJson(res, 200, { ok: true, ...listLlmModels() });
    return;
  }

  if (req.method === "PATCH" && urlPath === "/api/v1/settings") {
    try {
      const raw = await readBody(req);
      const patch = raw ? JSON.parse(raw) : {};
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 200, patchSettings(patch));
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/books") {
    sendJson(res, 200, readBooks());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/books/sync") {
    const key = (readSettings().weread_key || "").trim();
    if (!key) {
      sendJson(res, 400, {
        ok: false,
        error: "weread_key_missing",
        message: "请先在设定里填写微信读书 API Key",
      });
      return;
    }
    try {
      const result = await syncFromWeread(key);
      sendJson(res, 200, {
        ok: true,
        synced: result.synced,
        total_remote: result.total_remote,
        albums_skipped: result.albums,
        books: result.books,
      });
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "weread_sync_failed",
        message: e.message || "微信读书书架同步失败",
      });
    }
    return;
  }

  const highlightGet = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/highlights$/);
  if (req.method === "GET" && highlightGet) {
    const bookKey = decodeURIComponent(highlightGet[1]);
    sendJson(res, 200, getHighlights(bookKey));
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/highlights/sync") {
    const key = (readSettings().weread_key || "").trim();
    if (!key) {
      sendJson(res, 400, {
        ok: false,
        error: "weread_key_missing",
        message: "请先在设定里填写微信读书 API Key",
      });
      return;
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      let bookKey = body.bookId || body.book_id;
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      if (!bookKey) {
        sendJson(res, 400, {
          ok: false,
          error: "book_required",
          message: "请指定 bookId，或先同步书架并有进行中的书",
        });
        return;
      }
      const result = await syncHighlights(key, bookKey);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "no_weread_id" ? 400 : 502, {
        ok: false,
        error: e.code || "highlight_sync_failed",
        message: e.message || "划线同步失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/follow") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      let bookKey = body.bookId || body.book_id;
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      if (!bookKey) {
        sendJson(res, 400, {
          ok: false,
          error: "book_required",
          message: "请指定 bookId",
        });
        return;
      }
      const limit = Number(body.limit) || 3;
      const think = body.think !== false;
      const retry = !!body.retry;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const result = await followPending(bookKey, { limit, think, retry, model });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "llm_not_configured" || e.code === "book_not_found" ? 400 : 502, {
        ok: false,
        error: e.code || "follow_failed",
        message: e.message || "跟批失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/sessions") {
    sendJson(res, 200, { ok: true, ...listSessions() });
    return;
  }

  const sessionGet = urlPath.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionGet) {
    const id = decodeURIComponent(sessionGet[1]);
    const session = getSession(id);
    if (!session) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/sessions/preview") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      let bookKey = body.bookId || body.book_id;
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      if (!bookKey) {
        sendJson(res, 400, { ok: false, error: "book_required", message: "请指定 bookId" });
        return;
      }
      const startedAt = Number(body.startedAt || body.started_at) || Date.now();
      sendJson(res, 200, { ok: true, summary: buildSummary(bookKey, startedAt) });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "book_not_found" ? 400 : 500, {
        ok: false,
        error: e.code || "preview_failed",
        message: e.message || "预览失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/sessions/end") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      let bookKey = body.bookId || body.book_id;
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      if (!bookKey) {
        sendJson(res, 400, { ok: false, error: "book_required", message: "请指定 bookId" });
        return;
      }
      const startedAt = Number(body.startedAt || body.started_at) || Date.now();
      const session = endSession(bookKey, startedAt);
      sendJson(res, 200, { ok: true, session });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "book_not_found" ? 400 : 500, {
        ok: false,
        error: e.code || "end_failed",
        message: e.message || "结束本场失败",
      });
    }
    return;
  }

  if (req.method === "GET") {
    servePwa(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`gateway listening on http://127.0.0.1:${PORT}`);
});
