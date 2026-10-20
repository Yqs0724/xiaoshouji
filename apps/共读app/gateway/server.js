const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("./load-env").loadEnv();
const { readSettings, patchSettings, healthFlags, publicSettings, listLlmModels, effectiveDialogue, assertDoorOpen } = require("./settings");
const { readBooks, syncFromWeread, listBooksNormalized, setActivePass, addNextPass, refreshBookProgress, createLocalBookFromText, renameLocalBook, deleteLocalBook } = require("./books");
const { putBookBody, getBookBody, BODY_MAX_CHARS } = require("./bodies");
const { getHighlights, listNotesIndex, searchNotes, syncHighlights, exportNotesBook, exportNotesAll, setHighlightPass, addLocalHighlight, addLocalIdea } = require("./highlights");
const { followPending, regenerateFollow, selectFollowVariant, editFollow } = require("./follow");
const {
  sendShortChatStream,
  summarizeRecent,
  listOpenChats,
  estimateDialogueContext,
} = require("./chat");
const { listSessions, getSession, getOpenSession, startSession, patchOpenSession, buildSummary, endSession, sessionStats, openActiveDurationMs, exportSession, exportSessionsPeriod, idleReadAdvance, budgetExhausted } = require("./sessions");
const { buildBackup, previewBackup, restoreFromBackup } = require("./backup");
const {
  listWorld,
  listWorldPublic,
  replaceWorld,
  addBookFromText,
  deleteBook,
  setBookActive,
} = require("./world");
const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  proposeEvents,
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  upsertNote,
} = require("../../日历app/gateway/calendar");
const { getBudgetSummary } = require("../../额度app/gateway/budget");
const {
  listMessages,
  searchMessages,
  createMessageWithReplyStream,
  recallMessageWithReplyStream,
  regenerateMessageStream,
  setMessageVariant,
  deleteMessage,
  recallMessage,
  recallExpired,
  toggleMessageReaction,
  toggleVoiceTranscript,
  createPat,
  createMessage,
  assertRegenTarget,
  unreadCount,
  markAllRead,
  pokeDaily,
  getChatPrefs,
  setChatPrefs,
  clearChatMessages,
  listAllStickers,
  saveChatMedia,
  resolveChatMediaPath,
  claimIncomingMoney,
  translateChatText,
  startChatCall,
  setChatCallPhase,
  finishChatCallStream,
  MEDIA_MAX_BYTES,
} = require("../../聊天app/gateway/daily-chat");
const { getMoodPublic } = require("../../聊天app/gateway/mood");
const {
  addUserSticker,
  resolveUserStickerPath,
  STICKER_MAX_BYTES,
} = require("../../聊天app/gateway/stickers");
const { listChatTools, pingMcpConnection } = require("../../聊天app/gateway/chat-tools");
const {
  listMoments,
  createPost: createMomentPost,
  deletePost: deleteMomentPost,
  updatePost: updateMomentPost,
  toggleLike: toggleMomentLike,
  addComment: addMomentComment,
} = require("../../聊天app/gateway/moments");
const {
  listFavorites,
  addFavorite,
  removeFavorite,
} = require("../../聊天app/gateway/favorites");
const { getWallet } = require("../../资产app/gateway/wallet");
const { listCards, createCard, deleteCard } = require("./lore");
const {
  listTitles,
  getTitle,
  getWatchPresence,
  addTitleFromStream,
  deleteTitle,
  streamMedia,
  listSpit,
  createSpitWithReplyStream,
  endActivePass,
  patchPassBudget,
} = require("../../共看app/gateway/watch");
const {
  patchListenAuth,
  appleMusicHealth,
  publicListenAuth,
  getSession: getListenSession,
  controlPlayback,
  setProposal,
  respondProposal,
  createSpit: createListenSpit,
  createSpitWithReplyStream: createListenSpitStream,
  endActivePass: endListenPass,
  getListenPresence,
  engageListen,
  toggleFavorite: toggleListenFavorite,
  getHistory: getListenHistory,
} = require("../../共听app/gateway/listen");
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
const ARIADNE_ROOT = path.join(__dirname, "..", "..", "..");
const PWA_ROOT = path.join(__dirname, "..", "pwa");
const APPS_ROOT = path.join(ARIADNE_ROOT, "apps");
const COLISTEN_PWA_ROOT = path.join(APPS_ROOT, "共听app", "pwa");
/** 运行时素材真源：母仓 assets/（各 App 不再自带素材目录） */
const ASSETS_ROOT = path.join(ARIADNE_ROOT, "assets");

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
  ".gif": "image/gif",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
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

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    // ponytail: HTML 无版本指纹时靠 no-store，避免旧 #view-cal{display:flex} 缓存挡其它页
    if (ext === ".html" || ext === "") {
      headers["Cache-Control"] = "no-store, no-cache";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-cache",
  });
  res.end(text);
}

/** 壳 index：注入各 App pwa/view*.html（标记 <!--APP_VIEW:文件夹:文件-->） */
function buildShellIndexHtml() {
  let html = fs.readFileSync(path.join(PWA_ROOT, "index.html"), "utf8");
  html = html.replace(
    /<!--APP_VIEW:([^:>]+):([^>]+)-->/g,
    (_, appFolder, fileName) => {
      const fp = path.join(APPS_ROOT, appFolder.trim(), "pwa", fileName.trim());
      if (!fp.startsWith(APPS_ROOT + path.sep)) return "";
      try {
        return fs.readFileSync(fp, "utf8");
      } catch {
        return `<!-- missing ${appFolder}/${fileName} -->`;
      }
    }
  );
  return html;
}

function servePwa(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // 旧前缀兼容 → 母仓 assets/chat、assets/colisten
  if (urlPath.startsWith("/assets-chat/")) {
    urlPath = "/assets/chat/" + urlPath.slice("/assets-chat/".length);
  }
  if (urlPath.startsWith("/assets-colisten/assets/")) {
    urlPath = "/assets/colisten/" + urlPath.slice("/assets-colisten/assets/".length);
  }

  if (urlPath.startsWith("/assets-colisten/")) {
    const rel = urlPath.slice("/assets-colisten/".length);
    const filePath = path.normalize(path.join(COLISTEN_PWA_ROOT, rel));
    if (!filePath.startsWith(COLISTEN_PWA_ROOT + path.sep)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    sendFile(res, filePath);
    return;
  }

  if (urlPath.startsWith("/app-ui/")) {
    const rel = urlPath.slice("/app-ui/".length);
    const filePath = path.normalize(path.join(APPS_ROOT, rel));
    if (!filePath.startsWith(APPS_ROOT + path.sep)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    sendFile(res, filePath);
    return;
  }

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

  if (urlPath === "/index.html") {
    try {
      sendText(res, 200, buildShellIndexHtml(), "text/html; charset=utf-8");
    } catch (e) {
      sendJson(res, 500, { ok: false, error: "index_build_failed", message: e.message });
    }
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
      apple_music: appleMusicHealth(),
      gate_enabled: gateEnabled(),
      gate_unlocked: isGateUnlocked(req),
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/listen/auth") {
    sendJson(res, 200, publicListenAuth());
    return;
  }

  if (req.method === "PATCH" && urlPath === "/api/v1/listen/auth") {
    try {
      const raw = await readBody(req);
      const patch = raw ? JSON.parse(raw) : {};
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 200, patchListenAuth(patch));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "patch_failed",
        message: e.message || "保存共听授权失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/listen/session") {
    try {
      sendJson(res, 200, getListenSession());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "读取共听场次失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/listen/presence") {
    try {
      sendJson(res, 200, getListenPresence());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "读取共听状态失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/engage") {
    try {
      sendJson(res, 200, engageListen());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "进入共听失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/listen/history") {
    try {
      sendJson(res, 200, getListenHistory());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "读取共听历史失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/favorite") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, toggleListenFavorite(body.trackId || body.id));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_favorite" ? 400 : 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "收藏失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/control") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, controlPlayback(body.action, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_control" ? 400 : 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "播控失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/spit") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!String(body && body.body != null ? body.body : "").trim()) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_spit_body",
          message: "吐槽不能为空",
        });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      res.write(":" + " ".repeat(2048) + "\n\n");
      const emit = (obj) =>
        new Promise((resolve, reject) => {
          const line = "data: " + JSON.stringify(obj) + "\n\n";
          const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      await createListenSpitStream(body, emit);
      res.end();
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
        } else {
          try {
            res.write(
              "data: " +
                JSON.stringify({
                  type: "bot_error",
                  code: "invalid_json",
                  message: "请求格式不对",
                }) +
                "\n\n"
            );
            res.end();
          } catch (_) {}
        }
        return;
      }
      if (!res.headersSent) {
        sendJson(res, e.code === "bad_spit_body" ? 400 : 500, {
          ok: false,
          error: e.code || "listen_failed",
          message: e.message || "吐槽失败",
        });
      } else {
        try {
          res.write(
            "data: " +
              JSON.stringify({
                type: "bot_error",
                code: e.code || "listen_failed",
                message: e.message || "吐槽失败",
              }) +
              "\n\n"
          );
          res.end();
        } catch (_) {}
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/end") {
    try {
      sendJson(res, 200, endListenPass());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "结束本场失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/listen/proposal") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (body.action === "demo" || body.demo) {
        sendJson(res, 200, setProposal(true));
        return;
      }
      sendJson(res, 200, respondProposal(body.decision || body.action));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_proposal" ? 400 : 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "提议处理失败",
      });
    }
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
      sendJson(
        res,
        e.code === "bad_budget" ||
        e.code === "bad_meet_date" ||
        e.code === "bad_pin_day" ||
        e.code === "bad_anniv"
          ? 400
          : 500,
        {
          ok: false,
          error: e.code || "patch_failed",
          message: e.message || "保存设定失败",
        }
      );
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/budget/summary") {
    try {
      sendJson(res, 200, getBudgetSummary());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "budget_summary_failed",
        message: e.message || "读取额度失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/cal/events") {
    try {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      sendJson(
        res,
        200,
        listEvents({
          date: q.get("date") || undefined,
          from: q.get("from") || undefined,
          to: q.get("to") || undefined,
        })
      );
    } catch (e) {
      sendJson(res, e.code === "bad_cal_date" ? 400 : 500, {
        ok: false,
        error: e.code || "cal_list_failed",
        message: e.message || "读取日程失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/cal/propose") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, await proposeEvents(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_cal_date" ? 400 : 500, {
        ok: false,
        error: e.code || "cal_propose_failed",
        message: e.message || "排程提议失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/cal/notes") {
    try {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      sendJson(res, 200, listNotes({ date: q.get("date") || undefined }));
    } catch (e) {
      sendJson(res, e.code === "bad_cal_date" ? 400 : 500, {
        ok: false,
        error: e.code || "cal_note_get_failed",
        message: e.message || "读取便签失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/cal/notes") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, body && body.id ? upsertNote(body) : createNote(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "bad_cal_date" ||
        e.code === "bad_cal_note" ||
        e.code === "cal_not_found";
      sendJson(res, bad ? (e.code === "cal_not_found" ? 404 : 400) : 500, {
        ok: false,
        error: e.code || "cal_note_upsert_failed",
        message: e.message || "保存便签失败",
      });
    }
    return;
  }

  const calNoteOne = urlPath.match(/^\/api\/v1\/cal\/notes\/([^/]+)$/);
  if (calNoteOne) {
    const nid = decodeURIComponent(calNoteOne[1]);
    if (req.method === "PATCH") {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        sendJson(res, 200, updateNote(nid, body));
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const bad =
          e.code === "bad_cal_date" ||
          e.code === "bad_cal_note" ||
          e.code === "cal_not_found";
        sendJson(res, bad ? (e.code === "cal_not_found" ? 404 : 400) : 500, {
          ok: false,
          error: e.code || "cal_note_update_failed",
          message: e.message || "更新便签失败",
        });
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        sendJson(res, 200, deleteNote(nid));
      } catch (e) {
        sendJson(res, e.code === "cal_not_found" ? 404 : 500, {
          ok: false,
          error: e.code || "cal_note_delete_failed",
          message: e.message || "删除便签失败",
        });
      }
      return;
    }
  }

  if (req.method === "POST" && urlPath === "/api/v1/cal/events") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, createEvent(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad = e.code === "bad_cal_date" || e.code === "bad_cal_title";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "cal_create_failed",
        message: e.message || "创建日程失败",
      });
    }
    return;
  }

  const calOne = urlPath.match(/^\/api\/v1\/cal\/events\/([^/]+)$/);
  if (calOne) {
    const id = decodeURIComponent(calOne[1]);
    if (req.method === "PATCH") {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        sendJson(res, 200, updateEvent(id, body));
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const bad =
          e.code === "bad_cal_date" ||
          e.code === "bad_cal_title" ||
          e.code === "cal_not_found";
        sendJson(res, bad ? (e.code === "cal_not_found" ? 404 : 400) : 500, {
          ok: false,
          error: e.code || "cal_update_failed",
          message: e.message || "更新日程失败",
        });
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        sendJson(res, 200, deleteEvent(id));
      } catch (e) {
        sendJson(res, e.code === "cal_not_found" ? 404 : 500, {
          ok: false,
          error: e.code || "cal_delete_failed",
          message: e.message || "删除日程失败",
        });
      }
      return;
    }
  }

  if (req.method === "GET" && urlPath === "/api/v1/moments") {
    try {
      sendJson(res, 200, listMoments());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        posts: [],
        error: e.code || "moments_failed",
        message: e.message || "读取朋友圈失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/moments") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, createMomentPost(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "empty_text" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "moments_create_failed",
        message: e.message || "发动态失败",
      });
    }
    return;
  }

  {
    const momIdMatch = urlPath.match(/^\/api\/v1\/moments\/([^/]+)$/);
    if (momIdMatch && (req.method === "DELETE" || req.method === "PATCH")) {
      const mid = decodeURIComponent(momIdMatch[1]);
      try {
        if (req.method === "DELETE") {
          sendJson(res, 200, deleteMomentPost(mid));
        } else {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          sendJson(res, 200, updateMomentPost(mid, body || {}));
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const status =
          e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "moments_mutate_failed",
          message: e.message || "操作失败",
        });
      }
      return;
    }
  }

  {
    const likeMatch = urlPath.match(/^\/api\/v1\/moments\/([^/]+)\/like$/);
    if (req.method === "POST" && likeMatch) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        sendJson(res, 200, toggleMomentLike(decodeURIComponent(likeMatch[1]), body.who));
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const status = e.code === "not_found" ? 404 : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "moments_like_failed",
          message: e.message || "点赞失败",
        });
      }
      return;
    }
  }

  {
    const cmtMatch = urlPath.match(/^\/api\/v1\/moments\/([^/]+)\/comments$/);
    if (req.method === "POST" && cmtMatch) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        sendJson(
          res,
          200,
          addMomentComment(decodeURIComponent(cmtMatch[1]), body || {})
        );
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const status =
          e.code === "not_found" ? 404 : e.code === "empty_text" ? 400 : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "moments_comment_failed",
          message: e.message || "评论失败",
        });
      }
      return;
    }
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/favorites") {
    try {
      sendJson(res, 200, listFavorites());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        items: [],
        error: e.code || "favorites_failed",
        message: e.message || "读取收藏失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/favorites") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, addFavorite(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "empty_text" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "favorites_add_failed",
        message: e.message || "收藏失败",
      });
    }
    return;
  }

  {
    const favDel = urlPath.match(/^\/api\/v1\/chat\/favorites\/([^/]+)$/);
    if (req.method === "DELETE" && favDel) {
      try {
        sendJson(res, 200, removeFavorite(decodeURIComponent(favDel[1])));
      } catch (e) {
        const status = e.code === "not_found" ? 404 : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "favorites_delete_failed",
          message: e.message || "删除收藏失败",
        });
      }
      return;
    }
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/messages") {
    sendJson(res, 200, listMessages());
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/prefs") {
    sendJson(res, 200, getChatPrefs());
    return;
  }

  if (req.method === "DELETE" && urlPath === "/api/v1/chat/messages") {
    try {
      sendJson(res, 200, clearChatMessages());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_clear_failed",
        message: e.message || "清空失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/mood") {
    try {
      sendJson(res, 200, getMoodPublic());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "mood_failed",
        message: e.message || "读取心情失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/translate") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = await translateChatText(body && body.text);
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "bad_translate" ||
        e.code === "bad_translate_kind" ||
        e.code === "llm_not_configured";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "translate_failed",
        message: e.message || "翻译失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/tools") {
    try {
      const catalog = await listChatTools(readSettings());
      sendJson(res, 200, catalog);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        tools: [],
        error: "tools_failed",
        message: (e && e.message) || "工具列表失败",
      });
    }
    return;
  }

  /* H1.23：MCP 一键测连通（可用未保存的表单值） */
  if (req.method === "POST" && urlPath === "/api/v1/chat/mcp/ping") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const settings = readSettings();
      const url =
        body && body.url != null
          ? String(body.url)
          : String(settings.mcp_url || "");
      const token =
        body && body.token != null
          ? String(body.token)
          : String(settings.mcp_token || "");
      const out = await pingMcpConnection({ url, token });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const bad =
        e.code === "mcp_no_url" ||
        e.code === "mcp_bad_url" ||
        e.code === "mcp_bad_name";
      sendJson(res, bad ? 400 : 502, {
        ok: false,
        error: e.code || "mcp_ping_failed",
        message: e.message || "MCP 连通失败",
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath === "/api/v1/chat/prefs") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, setChatPrefs(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_prefs_failed",
        message: e.message || "保存失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/search") {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      sendJson(
        res,
        200,
        searchMessages({
          q: u.searchParams.get("q") || "",
          kind: u.searchParams.get("kind") || "all",
          from: u.searchParams.get("from") || "",
          to: u.searchParams.get("to") || "",
        })
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_search_failed",
        message: e.message || "搜索失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/wallet") {
    try {
      sendJson(res, 200, getWallet());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "wallet_failed",
        message: e.message || "读取钱包失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/stickers") {
    sendJson(res, 200, { ok: true, stickers: listAllStickers() });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/stickers") {
    try {
      const buf = await readBodyBuffer(req, STICKER_MAX_BYTES);
      const label = String((req.headers["x-sticker-label"] || "")).trim();
      const out = addUserSticker(buf, req.headers["content-type"], label);
      sendJson(res, 200, out);
    } catch (e) {
      const status =
        e.code === "sticker_too_large" || e.code === "docx_too_large"
          ? 413
          : e.code === "bad_sticker_media"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "sticker_upload_failed",
        message: e.message || "贴纸上传失败",
      });
    }
    return;
  }

  {
    const stickerFile = urlPath.match(/^\/api\/v1\/chat\/stickers\/file\/([^/]+)$/);
    if (req.method === "GET" && stickerFile) {
      const filePath = resolveUserStickerPath(decodeURIComponent(stickerFile[1]));
      if (!filePath) {
        sendJson(res, 404, { ok: false, error: "not_found", message: "贴纸不存在" });
        return;
      }
      sendFile(res, filePath);
      return;
    }
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/media") {
    try {
      const buf = await readBodyBuffer(req, MEDIA_MAX_BYTES);
      const out = saveChatMedia(buf, req.headers["content-type"]);
      sendJson(res, 200, out);
    } catch (e) {
      const status =
        e.code === "chat_media_too_large" || e.code === "docx_too_large"
          ? 413
          : e.code === "bad_chat_media"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "chat_media_failed",
        message: e.message || "上传失败",
      });
    }
    return;
  }

  {
    const mediaMatch = urlPath.match(/^\/api\/v1\/chat\/media\/([^/]+)$/);
    if (req.method === "GET" && mediaMatch) {
      const filePath = resolveChatMediaPath(decodeURIComponent(mediaMatch[1]));
      if (!filePath) {
        sendJson(res, 404, { ok: false, error: "not_found", message: "图片不存在" });
        return;
      }
      sendFile(res, filePath);
      return;
    }
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/unread") {
    try {
      sendJson(res, 200, unreadCount());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_unread_failed",
        message: e.message || "读取未读失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/read") {
    try {
      sendJson(res, 200, markAllRead());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_read_failed",
        message: e.message || "标记已读失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/poke") {
    try {
      sendJson(res, 200, pokeDaily({}));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_poke_failed",
        message: e.message || "主动短讯失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/money/claim") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, claimIncomingMoney(body && body.id));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_money_claim" || e.code === "bad_chat_body" ? 400 : 500, {
        ok: false,
        error: e.code || "money_claim_failed",
        message: e.message || "领取失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/call/start") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(
        res,
        200,
        startChatCall(
          body && body.media,
          (body && (body.dir || body.direction)) || "out"
        )
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_chat_call" ? 400 : 500, {
        ok: false,
        error: e.code || "chat_call_failed",
        message: e.message || "发起通话失败",
      });
    }
    return;
  }

  {
    const callPhase = urlPath.match(/^\/api\/v1\/chat\/call\/([^/]+)\/phase$/);
    if (req.method === "POST" && callPhase) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const msg = setChatCallPhase(decodeURIComponent(callPhase[1]), body || {});
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const status =
          e.code === "not_found"
            ? 404
            : e.code === "bad_chat_call" || e.code === "bad_chat_body"
              ? 400
              : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "chat_call_failed",
          message: e.message || "更新通话失败",
        });
      }
      return;
    }
  }

  {
    const callFin = urlPath.match(/^\/api\/v1\/chat\/call\/([^/]+)\/finish$/);
    if (req.method === "POST" && callFin) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (res.socket && typeof res.socket.setNoDelay === "function") {
          res.socket.setNoDelay(true);
        }
        res.write(":" + " ".repeat(2048) + "\n\n");
        const emit = (obj) =>
          new Promise((resolve, reject) => {
            const line = "data: " + JSON.stringify(obj) + "\n\n";
            const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
            if (!ok) res.once("drain", resolve);
          });
        const emitFlush = async (obj) => {
          await emit(obj);
          await new Promise((resolve, reject) => {
            const ok = res.write(":\n\n", (err) =>
              err ? reject(err) : resolve()
            );
            if (!ok) res.once("drain", resolve);
          });
        };
        await finishChatCallStream(
          decodeURIComponent(callFin[1]),
          body || {},
          emitFlush
        );
        res.end();
      } catch (e) {
        if (e instanceof SyntaxError) {
          if (!res.headersSent) {
            sendJson(res, 400, { ok: false, error: "invalid_json" });
          }
          return;
        }
        if (!res.headersSent) {
          sendJson(res, e.code === "not_found" ? 404 : 500, {
            ok: false,
            error: e.code || "chat_call_failed",
            message: e.message || "结束通话失败",
          });
        } else {
          try {
            res.write(
              "data: " +
                JSON.stringify({
                  type: "bot_error",
                  code: e.code || "chat_call_failed",
                  message: e.message || "结束通话失败",
                }) +
                "\n\n"
            );
            res.end();
          } catch (_) {}
        }
      }
      return;
    }
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/messages") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const kindRaw = body && body.kind;
      const kind =
        kindRaw === "sticker" ||
        kindRaw === "image" ||
        kindRaw === "voice" ||
        kindRaw === "redpacket" ||
        kindRaw === "transfer" ||
        kindRaw === "location" ||
        kindRaw === "file" ||
        kindRaw === "music"
          ? kindRaw
          : "text";
      body.kind = kind;
      if (kind === "redpacket" || kind === "transfer") {
        if (!(Number(body.amount) > 0)) {
          sendJson(res, 400, {
            ok: false,
            error: "bad_wallet_amount",
            message: "请填写金额",
          });
          return;
        }
      } else if (kind === "location") {
        if (!String(body.name || "").trim()) {
          sendJson(res, 400, {
            ok: false,
            error: "bad_chat_location",
            message: "请填写位置名称",
          });
          return;
        }
      } else if (kind === "file") {
        if (!String(body.name || "").trim()) {
          sendJson(res, 400, {
            ok: false,
            error: "bad_chat_file",
            message: "请选择文件",
          });
          return;
        }
      } else if (kind === "music") {
        if (!String(body.name || "").trim()) {
          sendJson(res, 400, {
            ok: false,
            error: "bad_chat_music",
            message: "请选择音乐",
          });
          return;
        }
      } else if (!String(body && body.body != null ? body.body : "").trim()) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_chat_body",
          message: "内容不能为空",
        });
        return;
      }
      if (body.noreply) {
        sendJson(res, 200, createMessage(body));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      res.write(":" + " ".repeat(2048) + "\n\n");
      const emit = (obj) =>
        new Promise((resolve, reject) => {
          const line = "data: " + JSON.stringify(obj) + "\n\n";
          const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      /* 关键事件后冲一发注释帧，避免 Node/代理把 you 和后续合并缓冲 */
      const emitFlush = async (obj) => {
        await emit(obj);
        await new Promise((resolve, reject) => {
          const ok = res.write(":\n\n", (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      };
      await createMessageWithReplyStream(body, emitFlush);
      res.end();
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
        } else {
          try {
            res.write(
              "data: " +
                JSON.stringify({
                  type: "bot_error",
                  code: "invalid_json",
                  message: "请求格式不对",
                }) +
                "\n\n"
            );
            res.end();
          } catch (_) {}
        }
        return;
      }
      if (!res.headersSent) {
        const bad =
          e.code === "bad_chat_body" ||
          e.code === "bad_chat_sticker" ||
          e.code === "bad_chat_image" ||
          e.code === "bad_chat_location" ||
          e.code === "bad_wallet_amount" ||
          e.code === "bad_wallet_party" ||
          e.code === "wallet_insufficient";
        sendJson(res, bad ? 400 : 500, {
          ok: false,
          error: e.code || "chat_create_failed",
          message: e.message || "发送失败",
        });
      } else {
        try {
          res.write(
            "data: " +
              JSON.stringify({
                type: "bot_error",
                code: e.code || "chat_create_failed",
                message: e.message || "发送失败",
              }) +
              "\n\n"
          );
          res.end();
        } catch (_) {}
      }
    }
    return;
  }

  {
    const regenMatch = urlPath.match(/^\/api\/v1\/chat\/messages\/([^/]+)\/regenerate$/);
    if (req.method === "POST" && regenMatch) {
      try {
        const id = decodeURIComponent(regenMatch[1]);
        try {
          assertRegenTarget(id);
        } catch (e) {
          const bad =
            e.code === "not_found" ||
            e.code === "not_regen_target" ||
            e.code === "not_latest";
          sendJson(res, e.code === "not_found" ? 404 : bad ? 400 : 500, {
            ok: false,
            error: e.code || "chat_regen_failed",
            message: e.message || "重新生成失败",
          });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (res.socket && typeof res.socket.setNoDelay === "function") {
          res.socket.setNoDelay(true);
        }
        res.write(":" + " ".repeat(2048) + "\n\n");
        const emit = (obj) =>
          new Promise((resolve, reject) => {
            const line = "data: " + JSON.stringify(obj) + "\n\n";
            const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
            if (!ok) res.once("drain", resolve);
          });
        await regenerateMessageStream(id, emit);
        res.end();
      } catch (e) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            ok: false,
            error: e.code || "chat_regen_failed",
            message: e.message || "重新生成失败",
          });
        } else {
          try {
            res.write(
              "data: " +
                JSON.stringify({
                  type: "bot_error",
                  code: e.code || "chat_regen_failed",
                  message: e.message || "重新生成失败",
                }) +
                "\n\n"
            );
            res.end();
          } catch (_) {}
        }
      }
      return;
    }
  }

  {
    const varMatch = urlPath.match(/^\/api\/v1\/chat\/messages\/([^/]+)\/variant$/);
    if (req.method === "POST" && varMatch) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const msg = setMessageVariant(
          decodeURIComponent(varMatch[1]),
          body && body.index
        );
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const bad =
          e.code === "not_found" ||
          e.code === "not_regen_target" ||
          e.code === "no_variants" ||
          e.code === "bad_variant_index";
        sendJson(res, e.code === "not_found" ? 404 : bad ? 400 : 500, {
          ok: false,
          error: e.code || "chat_variant_failed",
          message: e.message || "切换版本失败",
        });
      }
      return;
    }
  }

  {
    const recallMatch = urlPath.match(/^\/api\/v1\/chat\/messages\/([^/]+)\/recall$/);
    if (req.method === "POST" && recallMatch) {
      try {
        const recallId = decodeURIComponent(recallMatch[1]);
        const hit = (listMessages().messages || []).find((m) => m && m.id === recallId);
        if (hit && !hit.recalled && recallExpired(hit.ts)) {
          sendJson(res, 400, {
            ok: false,
            error: "recall_expired",
            message: "超过2分钟不能撤回",
          });
          return;
        }
        const raw = await readBody(req);
        let recallOpts = {};
        try {
          const o = raw ? JSON.parse(raw) : {};
          if (o && typeof o === "object") {
            if (o.screenshot) recallOpts.screenshotUrl = String(o.screenshot);
            if (o.force_sight) recallOpts.forceSight = String(o.force_sight);
          }
        } catch (_) {
          recallOpts = {};
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (res.socket && typeof res.socket.setNoDelay === "function") {
          res.socket.setNoDelay(true);
        }
        res.write(":" + " ".repeat(2048) + "\n\n");
        const emit = (obj) =>
          new Promise((resolve, reject) => {
            const line = "data: " + JSON.stringify(obj) + "\n\n";
            const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
            if (!ok) res.once("drain", resolve);
          });
        await recallMessageWithReplyStream(recallId, emit, recallOpts);
        res.end();
      } catch (e) {
        const bad =
          e.code === "not_found" ||
          e.code === "not_yours" ||
          e.code === "recall_expired";
        if (!res.headersSent) {
          sendJson(res, e.code === "not_found" ? 404 : bad ? 400 : 500, {
            ok: false,
            error: e.code || "chat_recall_failed",
            message: e.message || "撤回失败",
          });
        } else {
          try {
            res.write(
              "data: " +
                JSON.stringify({
                  type: "bot_error",
                  code: e.code || "chat_recall_failed",
                  message: e.message || "撤回失败",
                }) +
                "\n\n"
            );
            res.end();
          } catch (_) {}
        }
      }
      return;
    }
  }

  {
    const reactMatch = urlPath.match(/^\/api\/v1\/chat\/messages\/([^/]+)\/react$/);
    if (req.method === "POST" && reactMatch) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const msg = toggleMessageReaction(
          decodeURIComponent(reactMatch[1]),
          body && body.emoji,
          "you"
        );
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
          return;
        }
        const status =
          e.code === "not_found"
            ? 404
            : e.code === "bad_reaction"
              ? 400
              : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "chat_react_failed",
          message: e.message || "表情回应失败",
        });
      }
      return;
    }
  }

  {
    const asrMatch = urlPath.match(
      /^\/api\/v1\/chat\/messages\/([^/]+)\/transcribe$/
    );
    if (req.method === "POST" && asrMatch) {
      try {
        const msg = await toggleVoiceTranscript(
          decodeURIComponent(asrMatch[1])
        );
        sendJson(res, 200, { ok: true, message: msg });
      } catch (e) {
        const status =
          e.code === "not_found"
            ? 404
            : e.code === "bad_voice" ||
                e.code === "llm_not_configured" ||
                e.code === "bad_audio"
              ? 400
              : e.code === "asr_unsupported" ||
                  e.code === "asr_failed" ||
                  e.code === "asr_empty"
                ? 502
                : 500;
        sendJson(res, status, {
          ok: false,
          error: e.code || "chat_transcribe_failed",
          message: e.message || "转文字失败",
        });
      }
      return;
    }
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/pat") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = createPat({
        target: body && body.target === "you" ? "you" : "bot",
      });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_pat_failed",
        message: e.message || "拍一拍失败",
      });
    }
    return;
  }

  {
    const delMatch = urlPath.match(/^\/api\/v1\/chat\/messages\/([^/]+)$/);
    if (req.method === "DELETE" && delMatch) {
      try {
        const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
        const indexRaw = q.get("index");
        const indexOpt =
          indexRaw != null && indexRaw !== "" ? Number(indexRaw) : undefined;
        sendJson(
          res,
          200,
          deleteMessage(decodeURIComponent(delMatch[1]), indexOpt)
        );
      } catch (e) {
        const bad =
          e.code === "not_found" || e.code === "bad_variant_index";
        sendJson(res, e.code === "not_found" ? 404 : bad ? 400 : 500, {
          ok: false,
          error: e.code || "chat_delete_failed",
          message: e.message || "删除失败",
        });
      }
      return;
    }
  }

  if (req.method === "GET" && urlPath === "/api/v1/lore/cards") {
    sendJson(res, 200, listCards());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/lore/cards") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, createCard(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_lore_body" ? 400 : 500, {
        ok: false,
        error: e.code || "lore_create_failed",
        message: e.message || "保存摘要失败",
      });
    }
    return;
  }

  const loreOne = urlPath.match(/^\/api\/v1\/lore\/cards\/([^/]+)$/);
  if (loreOne && req.method === "DELETE") {
    try {
      sendJson(res, 200, deleteCard(decodeURIComponent(loreOne[1])));
    } catch (e) {
      sendJson(res, e.code === "lore_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "lore_delete_failed",
        message: e.message || "删除失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/watch/presence") {
    try {
      sendJson(res, 200, getWatchPresence());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "watch_failed",
        message: e.message || "读取共看状态失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/watch/titles") {
    sendJson(res, 200, listTitles());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/watch/titles") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const name =
        q.get("name") ||
        (req.headers["x-filename"] && String(req.headers["x-filename"])) ||
        "未命名.mp4";
      const result = await addTitleFromStream(req, { name: decodeURIComponent(name) });
      sendJson(res, 200, result);
    } catch (e) {
      const code = e.code || "watch_create_failed";
      const status =
        code === "watch_too_large"
          ? 413
          : code === "bad_watch_type" ||
              code === "bad_watch_empty" ||
              code === "bad_watch_file"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: e.message || "加入失败",
      });
    }
    return;
  }

  const watchMedia = urlPath.match(/^\/api\/v1\/watch\/titles\/([^/]+)\/media$/);
  if (watchMedia && req.method === "GET") {
    try {
      streamMedia(req, res, decodeURIComponent(watchMedia[1]));
    } catch (e) {
      const code = e.code || "watch_media_failed";
      const status =
        code === "watch_not_found" || code === "watch_media_missing" ? 404 : 500;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: e.message || "无法播放",
      });
    }
    return;
  }

  const watchSpit = urlPath.match(/^\/api\/v1\/watch\/titles\/([^/]+)\/spit$/);
  if (watchSpit && req.method === "GET") {
    try {
      sendJson(res, 200, listSpit(decodeURIComponent(watchSpit[1])));
    } catch (e) {
      sendJson(res, e.code === "watch_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "watch_spit_failed",
        message: e.message || "加载吐槽失败",
      });
    }
    return;
  }

  if (watchSpit && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const titleId = decodeURIComponent(watchSpit[1]);
      if (!getTitle(titleId)) {
        sendJson(res, 404, {
          ok: false,
          error: "watch_not_found",
          message: "找不到该片子",
        });
        return;
      }
      if (!String(body && body.body != null ? body.body : "").trim()) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_spit_body",
          message: "吐槽不能为空",
        });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      // 撑破中间层缓冲，避免整段攒到 end 才给浏览器
      res.write(":" + " ".repeat(2048) + "\n\n");
      const emit = (obj) =>
        new Promise((resolve, reject) => {
          const line = "data: " + JSON.stringify(obj) + "\n\n";
          const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      await createSpitWithReplyStream(titleId, body, emit);
      res.end();
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
        } else {
          try {
            res.write(
              JSON.stringify({
                type: "bot_error",
                code: "invalid_json",
                message: "请求格式不对",
              }) + "\n"
            );
            res.end();
          } catch (_) {}
        }
        return;
      }
      if (!res.headersSent) {
        const code = e.code || "watch_spit_failed";
        const status =
          code === "watch_not_found" ? 404 : code === "bad_spit_body" ? 400 : 500;
        sendJson(res, status, {
          ok: false,
          error: code,
          message: e.message || "发送失败",
        });
      } else {
        try {
          res.write(
            JSON.stringify({
              type: "bot_error",
              code: e.code || "watch_spit_failed",
              message: e.message || "发送失败",
            }) + "\n"
          );
          res.end();
        } catch (_) {}
      }
    }
    return;
  }

  const watchEnd = urlPath.match(/^\/api\/v1\/watch\/titles\/([^/]+)\/end$/);
  if (watchEnd && req.method === "POST") {
    try {
      sendJson(res, 200, endActivePass(decodeURIComponent(watchEnd[1])));
    } catch (e) {
      sendJson(res, e.code === "watch_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "watch_end_failed",
        message: e.message || "结束本场失败",
      });
    }
    return;
  }

  const watchBudget = urlPath.match(/^\/api\/v1\/watch\/titles\/([^/]+)\/budget$/);
  if (watchBudget && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const rmb =
        body.rmb != null
          ? body.rmb
          : body.budget_rmb != null
            ? body.budget_rmb
            : body.default_budget_rmb;
      sendJson(res, 200, patchPassBudget(decodeURIComponent(watchBudget[1]), rmb));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "watch_not_found"
          ? 404
          : e.code === "bad_budget"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "watch_budget_failed",
        message: e.message || "改额度失败",
      });
    }
    return;
  }

  const watchOne = urlPath.match(/^\/api\/v1\/watch\/titles\/([^/]+)$/);
  if (watchOne && req.method === "DELETE") {
    try {
      sendJson(res, 200, deleteTitle(decodeURIComponent(watchOne[1])));
    } catch (e) {
      sendJson(res, e.code === "watch_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "watch_delete_failed",
        message: e.message || "删除失败",
      });
    }
    return;
  }

  if (watchOne && req.method === "GET") {
    try {
      const title = getTitle(decodeURIComponent(watchOne[1]));
      if (!title) {
        sendJson(res, 404, {
          ok: false,
          error: "watch_not_found",
          message: "找不到该片子",
        });
        return;
      }
      sendJson(res, 200, { ok: true, title });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "watch_get_failed",
        message: e.message || "读取失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/world") {
    sendJson(res, 200, { ok: true, ...listWorldPublic() });
    return;
  }

  if (req.method === "PUT" && urlPath === "/api/v1/world") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const data = replaceWorld(body.entries);
      sendJson(res, 200, { ok: true, ...listWorldPublic(), ...data });
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

  if (req.method === "POST" && urlPath === "/api/v1/world/books") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = String(body.text != null ? body.text : body.content || "");
      const book = addBookFromText(text, {
        name: body.name,
        filename: body.filename,
      });
      sendJson(res, 200, {
        ok: true,
        book: {
          id: book.id,
          name: book.name,
          filename: book.filename,
          active: book.active,
          entry_count: book.entries.length,
        },
        ...listWorldPublic(),
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "world_empty" ? 400 : 500,
        {
          ok: false,
          error: e.code || "world_import_failed",
          message: e.message || "导入世界书失败",
        }
      );
    }
    return;
  }

  if (req.method === "PATCH" && urlPath.startsWith("/api/v1/world/books/")) {
    const id = decodeURIComponent(urlPath.slice("/api/v1/world/books/".length));
    if (!id || id.includes("/")) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!Object.prototype.hasOwnProperty.call(body, "active")) {
        sendJson(res, 400, { ok: false, error: "need_active", message: "需要 active" });
        return;
      }
      const data = setBookActive(id, body.active);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "world_not_found" ? 404 : e.code === "world_active_cap" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "world_patch_failed",
        message: e.message || "更新失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/world/books/")) {
    const id = decodeURIComponent(urlPath.slice("/api/v1/world/books/".length));
    if (!id || id.includes("/")) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    try {
      const data = deleteBook(id);
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      sendJson(res, e.code === "world_not_found" ? 404 : 500, {
        ok: false,
        error: e.code || "world_delete_failed",
        message: e.message || "删除失败",
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
      const isRegen = !!(body.regenerate && hid);

      const runFollow = async (emit) => {
        if (isRegen) {
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
          return regenerateFollow(bookKey, hid, opts, emit);
        }
        const limit = Number(body.limit) || 3;
        const retry = !!body.retry;
        const hidOnly = body.highlightId || body.highlight_id;
        return followPending(
          bookKey,
          {
            limit,
            think,
            retry,
            model,
            highlightId: !body.regenerate && hidOnly ? hidOnly : undefined,
          },
          emit
        );
      };

      // 对话路径强制 SSE，禁止 JSON 整段兜底
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      res.write(":" + " ".repeat(2048) + "\n\n");
      const emit = (obj) =>
        new Promise((resolve, reject) => {
          const line = "data: " + JSON.stringify(obj) + "\n\n";
          const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      try {
        await runFollow(emit);
      } catch (e) {
        try {
          await emit({
            type: "follow_error",
            code: e.code || "follow_failed",
            message: e.message || "跟批失败",
          });
          await emit({
            type: "done",
            ok: false,
            error: e.code || "follow_failed",
            message: e.message || "跟批失败",
          });
        } catch (_) {}
      }
      res.end();
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
        }
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "book_not_found" ||
        e.code === "highlight_required" ||
        e.code === "no_follow" ||
        e.code === "budget_exhausted" ||
        e.code === "door_locked";
      if (!res.headersSent) {
        sendJson(res, bad ? 400 : 502, {
          ok: false,
          error: e.code || "follow_failed",
          message: e.message || "跟批失败",
        });
      } else {
        try {
          res.write(
            "data: " +
              JSON.stringify({
                type: "follow_error",
                code: e.code || "follow_failed",
                message: e.message || "跟批失败",
              }) +
              "\n\n"
          );
          res.end();
        } catch (_) {}
      }
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
      // 校验先于 SSE，避免 200 空流挂死前端；对话路径强制 SSE
      try {
        assertDoorOpen();
        if (!String(text || "").trim()) {
          const err = new Error("请输入内容");
          err.code = "empty_message";
          throw err;
        }
        const open = getOpenSession();
        if (!open) {
          const err = new Error("请先进入共读（开场）");
          err.code = "no_open_session";
          throw err;
        }
        if (budgetExhausted(open)) {
          const err = new Error("本场额度已用尽");
          err.code = "budget_exhausted";
          throw err;
        }
      } catch (pre) {
        const bad =
          pre.code === "llm_not_configured" ||
          pre.code === "no_open_session" ||
          pre.code === "empty_message" ||
          pre.code === "budget_exhausted" ||
          pre.code === "door_locked";
        sendJson(res, bad ? 400 : 502, {
          ok: false,
          error: pre.code || "chat_failed",
          message: pre.message || "短聊失败",
        });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      res.write(":" + " ".repeat(2048) + "\n\n");
      const emit = (obj) =>
        new Promise((resolve, reject) => {
          const line = "data: " + JSON.stringify(obj) + "\n\n";
          const ok = res.write(line, (err) => (err ? reject(err) : resolve()));
          if (!ok) res.once("drain", resolve);
        });
      await sendShortChatStream(
        text,
        { think, model, replyToHighlightId: replyTo },
        emit
      );
      res.end();
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (!res.headersSent) {
          sendJson(res, 400, { ok: false, error: "invalid_json" });
        }
        return;
      }
      const bad =
        e.code === "llm_not_configured" ||
        e.code === "no_open_session" ||
        e.code === "empty_message" ||
        e.code === "budget_exhausted" ||
        e.code === "highlight_not_found" ||
        e.code === "door_locked";
      if (!res.headersSent) {
        sendJson(res, bad ? 400 : 502, {
          ok: false,
          error: e.code || "chat_failed",
          message: e.message || "短聊失败",
        });
      } else {
        try {
          res.write(
            "data: " +
              JSON.stringify({
                type: "bot_error",
                code: e.code || "chat_failed",
                message: e.message || "短聊失败",
              }) +
              "\n\n"
          );
          res.end();
        } catch (_) {}
      }
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
