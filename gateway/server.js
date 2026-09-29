const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("./load-env").loadEnv();
const { readSettings, patchSettings, healthFlags, publicSettings, listLlmModels, effectiveDialogue } = require("./settings");
const { readBooks, syncFromWeread, listBooksNormalized, setActivePass, addNextPass, refreshBookProgress, createLocalBookFromText, renameLocalBook, deleteLocalBook } = require("./books");
const { putBookBody, getBookBody, BODY_MAX_CHARS } = require("./bodies");
const { getHighlights, listNotesIndex, searchNotes, syncHighlights, exportNotesBook, exportNotesAll, setHighlightPass, addLocalHighlight, addLocalIdea } = require("./highlights");
const { followPending, regenerateFollow, selectFollowVariant, editFollow } = require("./follow");
const {
  sendShortChat,
  summarizeRecent,
  listOpenChats,
  estimateDialogueContext,
} = require("./chat");
const { listSessions, getSession, getOpenSession, startSession, patchOpenSession, buildSummary, endSession, sessionStats, openActiveDurationMs, exportSession, exportSessionsPeriod, idleReadAdvance } = require("./sessions");
const { buildBackup, previewBackup, restoreFromBackup } = require("./backup");
const { listWorld, replaceWorld } = require("./world");
const {
  getPassLore,
  setPassLore,
  generatePassLoreDraft,
  appendSessionToPassLore,
} = require("./pass-lore");
const { docxToText, explainDocxError, DOCX_MAX_BYTES } = require("./docx-text");
const { epubToText, explainEpubError, EPUB_MAX_BYTES } = require("./epub-text");
const {
  gateEnabled,
  passwordMatches,
  isGateUnlocked,
  signUnlockToken,
  unlockCookieHeader,
  clearCookieHeader,
  applyGatePasswordPatch,
  gatePublicStatus,
} = require("./gate");

const PORT = Number(process.env.PORT) || 8787;
const PWA_ROOT = path.join(__dirname, "..", "pwa");

const GATE_OPEN_PATHS = new Set([
  "/api/v1/gate/status",
  "/api/v1/gate/unlock",
]);

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

function readBodyBuffer(req, limit = DOCX_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
      req.destroy();
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error("too large");
        err.code = "docx_too_large";
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

const ASSETS_ROOT = path.join(__dirname, "..", "assets");

function sendFile(res, filePath) {
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

function servePwa(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  if (urlPath.startsWith("/assets/")) {
    const rel = urlPath.slice("/assets/".length);
    const filePath = path.normalize(path.join(ASSETS_ROOT, rel));
    if (!filePath.startsWith(ASSETS_ROOT + path.sep)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    sendFile(res, filePath);
    return;
  }

  const filePath = path.normalize(path.join(PWA_ROOT, urlPath));
  if (!filePath.startsWith(PWA_ROOT + path.sep) && filePath !== PWA_ROOT) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  sendFile(res, filePath);
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && urlPath === "/api/v1/gate/status") {
    sendJson(res, 200, gatePublicStatus(req));
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/gate/unlock") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const s = readSettings();
      if (!gateEnabled(s)) {
        sendJson(res, 200, { ok: true, enabled: false, unlocked: true, message: "未启用访问密码" });
        return;
      }
      if (!passwordMatches(body.password, s)) {
        sendJson(res, 401, { ok: false, error: "bad_password", message: "密码不对" });
        return;
      }
      const token = signUnlockToken(s);
      const payload = JSON.stringify({ ok: true, enabled: true, unlocked: true });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Set-Cookie": unlockCookieHeader(token),
      });
      res.end(payload);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, { ok: false, error: "unlock_failed", message: e.message || "解锁失败" });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/gate/lock") {
    const payload = JSON.stringify({ ok: true, unlocked: false });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Set-Cookie": clearCookieHeader(),
    });
    res.end(payload);
    return;
  }

  if (gateEnabled() && !isGateUnlocked(req) && !GATE_OPEN_PATHS.has(urlPath)) {
    if (urlPath.startsWith("/api/")) {
      sendJson(res, 401, {
        ok: false,
        error: "gate_locked",
        message: "小屋已设访问密码，请先解锁",
      });
      return;
    }
    // 静态页仍下发，由 PWA 弹解锁层；避免裸 API 被扫
  }

  if (req.method === "GET" && urlPath === "/api/v1/health") {
    const flags = healthFlags();
    sendJson(res, 200, {
      ok: true,
      gateway: "up",
      ...flags,
      gate_enabled: gateEnabled(),
      gate_unlocked: isGateUnlocked(req),
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/backup/export") {
    try {
      const q = (req.url || "").split("?")[1] || "";
      const format = new URLSearchParams(q).get("format") || "json";
      const file = buildBackup(format);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": file.contentDisposition,
        "Content-Length": file.body.length,
      });
      res.end(file.body);
    } catch (e) {
      sendJson(res, e.code === "no_data" ? 400 : 500, {
        ok: false,
        error: e.code || "backup_failed",
        message: e.message || "备份失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/backup/preview") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const preview = previewBackup(body.backup != null ? body.backup : body);
      sendJson(res, 200, { ok: true, preview });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json", message: "JSON 解析失败" });
        return;
      }
      sendJson(res, e.code === "bad_backup" ? 400 : 500, {
        ok: false,
        error: e.code || "preview_failed",
        message: e.message || "预览失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/backup/restore") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const confirm = body.confirm === true || body.confirm === "true" || body.confirm === 1;
      if (!confirm) {
        sendJson(res, 400, {
          ok: false,
          error: "confirm_required",
          message: "请确认后恢复（会覆盖当前 data）",
        });
        return;
      }
      const result = restoreFromBackup(body.backup != null ? body.backup : body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json", message: "JSON 解析失败" });
        return;
      }
      sendJson(res, e.code === "bad_backup" || e.code === "no_data" ? 400 : 500, {
        ok: false,
        error: e.code || "restore_failed",
        message: e.message || "恢复失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/settings") {
    sendJson(res, 200, publicSettings());
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
      if (Object.prototype.hasOwnProperty.call(patch, "gate_password")) {
        if (gateEnabled() && !isGateUnlocked(req)) {
          sendJson(res, 401, {
            ok: false,
            error: "gate_locked",
            message: "请先解锁再改访问密码",
          });
          return;
        }
        applyGatePasswordPatch(patch.gate_password);
        delete patch.gate_password;
        delete patch.gate_hash;
        delete patch.gate_salt;
      }
      delete patch.gate_hash;
      delete patch.gate_salt;
      const hasMore = Object.keys(patch).length > 0;
      const s = hasMore ? patchSettings(patch) : readSettings();
      sendJson(res, 200, publicSettings(s));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_budget" ? 400 : 500, {
        ok: false,
        error: e.code || "patch_failed",
        message: e.message || "保存设定失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/world") {
    sendJson(res, 200, { ok: true, ...listWorld() });
    return;
  }

  if (req.method === "PUT" && urlPath === "/api/v1/world") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const data = replaceWorld(body.entries);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "world_save_failed",
        message: e.message || "保存世界书失败",
      });
    }
    return;
  }

  // 二进制 .docx → 纯文本（世界书 / 剧情摘要导入）
  if (req.method === "POST" && urlPath === "/api/v1/import/docx") {
    try {
      const buf = await readBodyBuffer(req, DOCX_MAX_BYTES);
      const text = docxToText(buf);
      sendJson(res, 200, { ok: true, text });
    } catch (e) {
      const code = e.code || "docx_bad";
      const status =
        code === "docx_too_large" ? 413 : code === "docx_empty" ? 400 : 400;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: explainDocxError(code),
      });
    }
    return;
  }

  // 二进制 .epub → 纯文本（本地书 / 挂正文）
  if (req.method === "POST" && urlPath === "/api/v1/import/epub") {
    try {
      const buf = await readBodyBuffer(req, EPUB_MAX_BYTES);
      const result = epubToText(buf);
      sendJson(res, 200, {
        ok: true,
        text: result.text,
        title: result.title,
        chars: result.chars,
        chapters: result.chapters || [],
      });
    } catch (e) {
      const code = e.code || "epub_bad";
      const status =
        code === "epub_too_large" ? 413 : code === "epub_empty" ? 400 : 400;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: explainEpubError(code),
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/books") {
    sendJson(res, 200, listBooksNormalized());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/books/import-local") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text != null ? body.text : body.body;
      const result = createLocalBookFromText(text, {
        filename: body.filename,
        title: body.title,
        author: body.author,
        chapters: body.chapters,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "empty_body" ||
        e.code === "body_too_large" ||
        e.code === "bad_book_id";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "import_local_failed",
        message: e.message || "导入本地书失败",
        max_chars: BODY_MAX_CHARS,
      });
    }
    return;
  }

  const bookPassLore = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/pass-lore$/);
  if (bookPassLore && req.method === "GET") {
    try {
      const bookKey = decodeURIComponent(bookPassLore[1]);
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const pass = q.get("pass") || q.get("pass_ordinal") || undefined;
      const data = getPassLore(bookKey, pass);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      sendJson(res, e.code === "book_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "pass_lore_failed",
        message: e.message || "读取本刷摘要失败",
      });
    }
    return;
  }
  if (bookPassLore && req.method === "PUT") {
    try {
      const bookKey = decodeURIComponent(bookPassLore[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const pass = body.pass ?? body.pass_ordinal;
      const text = body.text != null ? body.text : body.lore != null ? body.lore : "";
      const data = setPassLore(bookKey, pass, text);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "book_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "pass_lore_save_failed",
        message: e.message || "保存本刷摘要失败",
      });
    }
    return;
  }

  const bookPassLoreGen = urlPath.match(
    /^\/api\/v1\/books\/([^/]+)\/pass-lore\/generate$/
  );
  if (bookPassLoreGen && req.method === "POST") {
    try {
      const bookKey = decodeURIComponent(bookPassLoreGen[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const think = body.think === true;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const pass = body.pass ?? body.pass_ordinal;
      const result = await generatePassLoreDraft(bookKey, {
        passOrdinal: pass,
        think,
        model,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "no_open_session" ||
        e.code === "book_not_found" ||
        e.code === "book_mismatch" ||
        e.code === "budget_exhausted" ||
        e.code === "nothing_to_summarize" ||
        e.code === "door_locked";
      sendJson(res, bad ? 400 : 502, {
        ok: false,
        error: e.code || "pass_lore_generate_failed",
        message: e.message || "生成摘要失败",
      });
    }
    return;
  }

  const bookOne = urlPath.match(/^\/api\/v1\/books\/([^/]+)$/);
  if (bookOne && req.method === "PATCH") {
    try {
      const bookKey = decodeURIComponent(bookOne[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const title = body.title != null ? body.title : body.name;
      const result = renameLocalBook(bookKey, title);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "book_not_found"
          ? 404
          : e.code === "not_local_book" || e.code === "empty_title"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "rename_failed",
        message: e.message || "改名失败",
      });
    }
    return;
  }
  if (bookOne && req.method === "DELETE") {
    try {
      const bookKey = decodeURIComponent(bookOne[1]);
      const result = deleteLocalBook(bookKey);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      const status =
        e.code === "book_not_found"
          ? 404
          : e.code === "not_local_book" || e.code === "session_open"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "delete_failed",
        message: e.message || "删除失败",
      });
    }
    return;
  }

  const bookBody = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/body$/);
  if (bookBody && req.method === "GET") {
    try {
      const bookKey = decodeURIComponent(bookBody[1]);
      const data = getBookBody(bookKey);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      const status =
        e.code === "book_not_found" || e.code === "no_body"
          ? 404
          : e.code === "bad_book_id"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "body_get_failed",
        message: e.message || "读正文失败",
      });
    }
    return;
  }
  if (bookBody && req.method === "PUT") {
    try {
      const bookKey = decodeURIComponent(bookBody[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text != null ? body.text : body.body;
      const result = putBookBody(bookKey, text, {
        filename: body.filename,
        chapters: body.chapters,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "book_not_found" ||
        e.code === "empty_body" ||
        e.code === "body_too_large" ||
        e.code === "bad_book_id";
      sendJson(res, e.code === "book_not_found" ? 404 : bad ? 400 : 500, {
        ok: false,
        error: e.code || "body_put_failed",
        message: e.message || "保存正文失败",
        max_chars: BODY_MAX_CHARS,
      });
    }
    return;
  }

  const passNext = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/passes\/next$/);
  if (req.method === "POST" && passNext) {
    try {
      const bookId = decodeURIComponent(passNext[1]);
      const book = addNextPass(bookId);
      sendJson(res, 200, { ok: true, book });
    } catch (e) {
      sendJson(res, e.code === "book_not_found" ? 404 : 400, {
        ok: false,
        error: e.code || "pass_failed",
        message: e.message || "开下一刷失败",
      });
    }
    return;
  }

  const passSet = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/passes\/active$/);
  if (req.method === "POST" && passSet) {
    try {
      const bookId = decodeURIComponent(passSet[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const book = setActivePass(bookId, body.pass || body.ordinal || body.active_pass);
      sendJson(res, 200, { ok: true, book });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "book_not_found" || e.code === "pass_not_found";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "pass_failed",
        message: e.message || "切换刷次失败",
      });
    }
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
        progress_enriched: result.progress_enriched,
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

  if (req.method === "GET" && urlPath === "/api/v1/notes") {
    sendJson(res, 200, { ok: true, ...listNotesIndex() });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/notes/search") {
    const q = (req.url || "").split("?")[1] || "";
    const query = new URLSearchParams(q).get("q") || "";
    sendJson(res, 200, { ok: true, ...searchNotes(query) });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/notes/export") {
    try {
      const q = (req.url || "").split("?")[1] || "";
      const format = new URLSearchParams(q).get("format") || "md";
      const file = exportNotesAll(format);
      const buf = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8");
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": file.contentDisposition,
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      sendJson(res, e.code === "no_notes" ? 400 : 500, {
        ok: false,
        error: e.code || "export_failed",
        message: e.message || "导出失败",
      });
    }
    return;
  }

  const notesExport = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/notes\/export$/);
  if (req.method === "GET" && notesExport) {
    try {
      const bookKey = decodeURIComponent(notesExport[1]);
      const q = (req.url || "").split("?")[1] || "";
      const format = new URLSearchParams(q).get("format") || "md";
      const file = exportNotesBook(bookKey, format);
      const buf = Buffer.from(file.body, "utf8");
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": file.contentDisposition,
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      sendJson(res, e.code === "book_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "export_failed",
        message: e.message || "导出失败",
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
  if (req.method === "POST" && highlightGet) {
    try {
      const bookKey = decodeURIComponent(highlightGet[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text != null ? body.text : body.markText;
      const result = addLocalHighlight(bookKey, text);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "book_not_found"
          ? 404
          : e.code === "empty_mark"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "local_mark_failed",
        message: e.message || "加划线失败",
      });
    }
    return;
  }

  const ideaPost = urlPath.match(/^\/api\/v1\/books\/([^/]+)\/ideas$/);
  if (req.method === "POST" && ideaPost) {
    try {
      const bookKey = decodeURIComponent(ideaPost[1]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const idea = body.idea != null ? body.idea : body.content;
      const quote =
        body.quote != null
          ? body.quote
          : body.text != null
            ? body.text
            : body.markText != null
              ? body.markText
              : body.anchor;
      const result = addLocalIdea(bookKey, idea, { text: quote });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "book_not_found"
          ? 404
          : e.code === "empty_idea"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "local_idea_failed",
        message: e.message || "写想法失败",
      });
    }
    return;
  }

  const highlightPass = urlPath.match(
    /^\/api\/v1\/books\/([^/]+)\/highlights\/([^/]+)\/pass$/
  );
  if (req.method === "POST" && highlightPass) {
    try {
      const bookKey = decodeURIComponent(highlightPass[1]);
      const hid = decodeURIComponent(highlightPass[2]);
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const pass =
        body.pass_ordinal != null ? body.pass_ordinal : body.passOrdinal;
      const result = setHighlightPass(bookKey, hid, pass);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const code = e.code || "pass_set_failed";
      const status =
        code === "book_not_found" || code === "highlight_not_found"
          ? 404
          : code === "pass_invalid" ||
              code === "pass_not_on_book" ||
              code === "highlight_required"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: e.message || "改刷次失败",
      });
    }
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
      let progress = null;
      try {
        const book = await refreshBookProgress(key, bookKey);
        if (book) {
          progress = {
            id: book.id,
            weread_progress: book.weread_progress,
            weread_read_seconds: book.weread_read_seconds,
          };
        }
      } catch (_) {
        /* 进度失败不影响划线同步 */
      }
      sendJson(res, 200, { ok: true, ...result, progress });
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
      const think = body.think !== false;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const hid = body.highlightId || body.highlight_id;
      if (body.regenerate && hid) {
        const opts = { think, model };
        if (
          body.downvote ||
          Object.prototype.hasOwnProperty.call(body, "feedback") ||
          Object.prototype.hasOwnProperty.call(body, "reason")
        ) {
          opts.feedback =
            body.feedback != null
              ? body.feedback
              : body.reason != null
                ? body.reason
                : "";
        }
        const result = await regenerateFollow(bookKey, hid, opts);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      const limit = Number(body.limit) || 3;
      const retry = !!body.retry;
      const hidOnly = body.highlightId || body.highlight_id;
      const result = await followPending(bookKey, {
        limit,
        think,
        retry,
        model,
        highlightId: !body.regenerate && hidOnly ? hidOnly : undefined,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "book_not_found" ||
        e.code === "highlight_required" ||
        e.code === "no_follow" ||
        e.code === "budget_exhausted" ||
        e.code === "door_locked";
      sendJson(res, bad ? 400 : 502, {
        ok: false,
        error: e.code || "follow_failed",
        message: e.message || "跟批失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/follow/variant") {
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
      const hid = body.highlightId || body.highlight_id;
      if (!hid) {
        sendJson(res, 400, { ok: false, error: "highlight_required", message: "请指定 highlightId" });
        return;
      }
      const result = selectFollowVariant(bookKey, hid, body.index);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "book_not_found" || e.code === "no_follow" || e.code === "no_variants";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "variant_failed",
        message: e.message || "切换候选失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/follow/edit") {
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
      const hid = body.highlightId || body.highlight_id;
      if (!hid) {
        sendJson(res, 400, { ok: false, error: "highlight_required", message: "请指定 highlightId" });
        return;
      }
      const result = editFollow(bookKey, hid, body.body || body.text || "");
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "book_not_found" ||
        e.code === "no_follow" ||
        e.code === "empty_body" ||
        e.code === "highlight_required";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "edit_failed",
        message: e.message || "编辑跟批失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat") {
    sendJson(res, 200, { ok: true, chats: listOpenChats(), open: getOpenSession() });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/sessions/context") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const thinkRaw = String(q.get("think") || "").toLowerCase();
      const think =
        thinkRaw === "1" || thinkRaw === "true" || thinkRaw === "yes";
      const ctx = estimateDialogueContext({ think });
      sendJson(res, 200, { ok: true, ...ctx });
    } catch (e) {
      sendJson(res, e.code === "no_open_session" ? 400 : 500, {
        ok: false,
        error: e.code || "context_failed",
        message: e.message || "无法估算上下文",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = body.text || body.message || body.body || "";
      const think = body.think === true;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const replyTo =
        body.replyToHighlightId ||
        body.reply_to_highlight_id ||
        body.reply_to ||
        undefined;
      const result = await sendShortChat(text, {
        think,
        model,
        replyToHighlightId: replyTo,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "no_open_session" ||
        e.code === "empty_message" ||
        e.code === "budget_exhausted" ||
        e.code === "highlight_not_found" ||
        e.code === "door_locked";
      sendJson(res, bad ? 400 : 502, {
        ok: false,
        error: e.code || "chat_failed",
        message: e.message || "短聊失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/summarize") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const think = body.think === true;
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const limit = body.limit != null ? Number(body.limit) : undefined;
      const result = await summarizeRecent({ think, model, limit });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "no_open_session" ||
        e.code === "budget_exhausted" ||
        e.code === "nothing_to_summarize" ||
        e.code === "door_locked";
      sendJson(res, bad ? 400 : 502, {
        ok: false,
        error: e.code || "summarize_failed",
        message: e.message || "总结刚才失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/sessions") {
    sendJson(res, 200, { ok: true, open: getOpenSession(), stats: sessionStats(), ...listSessions() });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/sessions/export") {
    try {
      const q = (req.url || "").split("?")[1] || "";
      const params = new URLSearchParams(q);
      const format = params.get("format") || "md";
      const period = params.get("period") || "all";
      const file = exportSessionsPeriod(period, format);
      const buf = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8");
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": file.contentDisposition,
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      sendJson(res, e.code === "no_sessions" ? 400 : 500, {
        ok: false,
        error: e.code || "export_failed",
        message: e.message || "导出失败",
      });
    }
    return;
  }

  const sessionExport = urlPath.match(/^\/api\/v1\/sessions\/([^/]+)\/export$/);
  if (req.method === "GET" && sessionExport) {
    try {
      const id = decodeURIComponent(sessionExport[1]);
      const q = (req.url || "").split("?")[1] || "";
      const params = new URLSearchParams(q);
      const format = params.get("format") || "md";
      const file = exportSession(id, format);
      const buf = Buffer.from(file.body, "utf8");
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Disposition": file.contentDisposition,
        "Content-Length": buf.length,
      });
      res.end(buf);
    } catch (e) {
      sendJson(res, e.code === "not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "export_failed",
        message: e.message || "导出失败",
      });
    }
    return;
  }

  const sessionGet = urlPath.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionGet) {
    const id = decodeURIComponent(sessionGet[1]);
    if (id === "open") {
      sendJson(res, 200, { ok: true, open: getOpenSession() });
      return;
    }
    const session = getSession(id);
    if (!session) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/sessions/start") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const bookKey = body.bookId || body.book_id || undefined;
      const result = startSession(bookKey);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "session_open" || e.code === "book_not_found" || e.code === "book_required"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "start_failed",
        message: e.message || "开场失败",
        open: e.open || undefined,
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath === "/api/v1/sessions/open") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const open = patchOpenSession(body);
      sendJson(res, 200, { ok: true, open, dialogue: effectiveDialogue(open) });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "no_open_session" || e.code === "bad_follow_mode" || e.code === "bad_budget" || e.code === "bad_follow_tone" ? 400 : 500, {
        ok: false,
        error: e.code || "patch_failed",
        message: e.message || "更新本场失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/sessions/idle-read") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const result = idleReadAdvance({
        chunkChars: body.chunkChars != null ? body.chunkChars : body.chunk_chars,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "door_locked"
          ? 403
          : e.code === "no_open_session" || e.code === "no_body"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "idle_read_failed",
        message: e.message || "空闲自读失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/sessions/preview") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const open = getOpenSession();
      let bookKey = body.bookId || body.book_id || (open && open.book_id);
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      if (!bookKey) {
        sendJson(res, 400, { ok: false, error: "book_required", message: "请指定 bookId" });
        return;
      }
      const startedAt =
        Number(body.startedAt || body.started_at) ||
        (open && open.book_id === bookKey ? open.started_at : 0) ||
        Date.now();
      const summary = buildSummary(bookKey, startedAt);
      if (open && open.book_id === summary.book_id) {
        summary.duration_ms = openActiveDurationMs(open);
        if (open.pass_ordinal) summary.pass_ordinal = open.pass_ordinal;
      }
      sendJson(res, 200, { ok: true, summary });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "book_not_found" || e.code === "book_required" ? 400 : 500, {
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
      const open = getOpenSession();
      let bookKey = body.bookId || body.book_id || (open && open.book_id);
      if (!bookKey) {
        const active = readBooks().books.find((b) => b.in_progress);
        bookKey = active && active.id;
      }
      const startedAt = Number(body.startedAt || body.started_at) || undefined;
      const session = endSession(bookKey, startedAt);
      let pass_lore;
      if (body.append_lore || body.write_lore || body.writeLore) {
        pass_lore = appendSessionToPassLore(session);
      }
      sendJson(res, 200, {
        ok: true,
        session,
        lore_written: !!pass_lore,
        pass_lore: pass_lore || undefined,
        // 兼容旧前端字段名
        lore_summary: pass_lore ? pass_lore.text : undefined,
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "book_not_found" || e.code === "no_open_session" || e.code === "book_required"
          ? 400
          : 500,
        {
          ok: false,
          error: e.code || "end_failed",
          message: e.message || "结束本场失败",
        }
      );
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
