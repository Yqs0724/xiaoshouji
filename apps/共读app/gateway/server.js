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
const { getBudgetSummary, patchModelRates } = require("../../额度app/gateway/budget");
const {
  listMessages,
  listPeers,
  createPeer,
  updatePeer,
  renamePeer,
  deletePeer,
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
  FILE_MAX_BYTES,
  addTokensUsed,
  withPeer,
  normalizePeerId,
  DEFAULT_PEER_ID,
  resolvePeerForMessage,
  setArchiveAtMessage,
  setArchiveBeforeTs,
} = require("../../聊天app/gateway/daily-chat");
const { ttsStatus, synthesizeSpeech } = require("../../聊天app/gateway/tts");
const { runVoiceTurn } = require("../../聊天app/gateway/voice-turn");
const { runCallHeartbeat } = require("../../聊天app/gateway/call-heartbeat");
const { listGifts, giftByTier } = require("../../聊天app/gateway/call-gifts");

function peerFromRequest(req, body) {
  try {
    const u = new URL(req.url || "/", "http://local");
    const q = u.searchParams.get("peer") || u.searchParams.get("peerId");
    if (q) return normalizePeerId(q);
  } catch (_) {}
  if (body && (body.peer || body.peerId)) {
    return normalizePeerId(body.peer || body.peerId);
  }
  return DEFAULT_PEER_ID;
}

function topicFromRequest(req, body) {
  try {
    const u = new URL(req.url || "/", "http://local");
    const q = u.searchParams.get("topic") || u.searchParams.get("topicId");
    if (q) {
      const { normalizeTopicId } = require("../../聊天app/gateway/daily-chat");
      return normalizeTopicId(q);
    }
  } catch (_) {}
  if (body && (body.topic || body.topicId)) {
    const { normalizeTopicId } = require("../../聊天app/gateway/daily-chat");
    return normalizeTopicId(body.topic || body.topicId);
  }
  return "";
}

function withChatRequest(req, body, fn) {
  const { withPeerTopic } = require("../../聊天app/gateway/daily-chat");
  return withPeerTopic(
    peerFromRequest(req, body),
    topicFromRequest(req, body),
    fn
  );
}

function peerForMessageOp(req, body, msgId) {
  const found = resolvePeerForMessage(msgId);
  if (found) return found;
  return peerFromRequest(req, body);
}

function withMessageOp(req, body, msgId, fn) {
  const { withPeerTopic, resolveChatCtxForMessage } = require(
    "../../聊天app/gateway/daily-chat"
  );
  const ctx = resolveChatCtxForMessage(msgId);
  if (ctx) return withPeerTopic(ctx.peerId, ctx.topicId, fn);
  return withPeerTopic(
    peerFromRequest(req, body),
    topicFromRequest(req, body),
    fn
  );
}
const {
  getMoodPublic,
  runMoodBatch,
  startMoodBatchScheduler,
  listLexiconPublic,
  addLexiconExtra,
  removeLexiconExtra,
} = require("../../聊天app/gateway/mood");
const {
  listPeerMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  toggleUnresolved,
  digestStatus,
  digestNewMemories,
  digestFromMessageIds,
  dehydrateMemories,
  traceMemorySource,
  llmSentinelRoute,
} = require("../../聊天app/gateway/memory");
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
const {
  getWallet,
  walletAdjust,
  addCard,
  patchCard,
  removeCard,
} = require("../../资产app/gateway/wallet");
const {
  getPocketKeys,
  ensureMemoSeeded,
} = require("../../资产app/gateway/pocket-keys");
const { getWealth, putWealth, wealthAdjust } = require("../../资产app/gateway/wealth");
const {
  listEvents: listEconomyEvents,
  createAndApply: createAndApplyEconomyEvent,
  applyEvent: applyEconomyEvent,
} = require("../../资产app/gateway/economy-events");
const {
  listTiers: listEconomyTiers,
  suggestFromPersona: suggestEconomyTier,
  applyTier: applyEconomyTier,
} = require("../../资产app/gateway/economy-tiers");
const {
  listMemo,
  upsertKey: upsertMemoKey,
  removeKey: removeMemoKey,
  upsertNote: upsertMemoNote,
  removeNote: removeMemoNote,
} = require("../../备忘录app/gateway/memo");
const { listCards, createCard, deleteCard } = require("./lore");
const {
  listTitles,
  getTitle,
  getWatchPresence,
  addTitleFromStream,
  scanMediaLibrary,
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
  shareTrackMoment: shareListenTrackMoment,
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
/** 安卓壳 / 局域网访问时设 HOST=0.0.0.0；默认仅本机 */
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
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
    // ponytail: HTML/JS/CSS 无版本指纹时靠 no-store，避免旧壳/共听脚本缓存挡改动
    if (ext === ".html" || ext === "" || ext === ".js" || ext === ".css") {
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
    const lanOpen = HOST === "0.0.0.0" || HOST === "::";
    sendJson(res, 200, {
      ok: true,
      gateway: "up",
      ...flags,
      apple_music: appleMusicHealth(),
      gate_enabled: gateEnabled(),
      gate_unlocked: isGateUnlocked(req),
      bind_host: HOST,
      bind_port: PORT,
      lan_open: lanOpen,
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

  /* Cove：搜歌（provider=netease|apple，默认跟设定） */
  if (req.method === "GET" && urlPath === "/api/v1/music/search") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const term = q.get("q") || q.get("query") || "";
      const limit = Number(q.get("limit") || 8);
      let provider = String(q.get("provider") || "").trim();
      if (!provider) {
        try {
          provider = String(readSettings().music_provider || "netease");
        } catch (_) {
          provider = "netease";
        }
      }
      let songs = [];
      let used = provider;
      if (provider === "apple") {
        songs = await require("../../共听app/gateway/apple-catalog").searchSongs(
          term,
          { limit }
        );
        used = "apple";
      } else {
        try {
          songs = await require("../../共听app/gateway/netease-catalog").searchSongs(
            term,
            { limit }
          );
          used = "netease";
        } catch (e) {
          if (provider === "netease") throw e;
          songs = await require("../../共听app/gateway/apple-catalog").searchSongs(
            term,
            { limit }
          );
          used = "apple";
        }
      }
      sendJson(res, 200, { ok: true, provider: used, songs });
    } catch (e) {
      const catalog = require("../../共听app/gateway/netease-catalog");
      sendJson(res, 500, {
        ok: false,
        error: e.code || "music_search_failed",
        message: catalog.explainMusicError(e.code, e.message || "搜歌失败"),
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/netease/ping") {
    try {
      sendJson(
        res,
        200,
        await require("../../共听app/gateway/netease-catalog").pingApi()
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "ping_failed",
        message: e.message || "探测失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/netease/qr/start") {
    try {
      const out = await require("../../共听app/gateway/netease-catalog").startQrLogin();
      sendJson(res, out.ok ? 200 : 502, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "qr_start_failed",
        message: e.message || "生成二维码失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/netease/qr/check") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const out = await require("../../共听app/gateway/netease-catalog").checkQrLogin(
        q.get("key") || ""
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "qr_check_failed",
        message: e.message || "查询扫码失败",
      });
    }
    return;
  }

  const neteaseSongMatch = urlPath.match(
    /^\/api\/v1\/music\/song\/netease\/(\d+)$/
  );
  if (req.method === "GET" && neteaseSongMatch) {
    try {
      const catalog = require("../../共听app/gateway/netease-catalog");
      const song = await catalog.getSongDetail(neteaseSongMatch[1]);
      if (!song) {
        sendJson(res, 404, {
          ok: false,
          error: "MUSIC_NOT_FOUND",
          message: catalog.explainMusicError("MUSIC_NOT_FOUND"),
        });
        return;
      }
      sendJson(res, 200, { ok: true, provider: "netease", song });
    } catch (e) {
      const catalog = require("../../共听app/gateway/netease-catalog");
      sendJson(res, 502, {
        ok: false,
        error: e.code || "song_detail_failed",
        message: catalog.explainMusicError(e.code, e.message),
      });
    }
    return;
  }

  const neteaseStreamMatch = urlPath.match(
    /^\/api\/v1\/music\/stream\/netease\/(\d+)$/
  );
  if (req.method === "GET" && neteaseStreamMatch) {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      await require("../../共听app/gateway/music-stream").handleNeteaseStream(
        req,
        res,
        neteaseStreamMatch[1],
        q.get("quality") || undefined
      );
    } catch (e) {
      if (!res.headersSent) {
        const catalog = require("../../共听app/gateway/netease-catalog");
        sendJson(res, 500, {
          ok: false,
          error: e.code || "stream_failed",
          message: catalog.explainMusicError(e.code, e.message || "代理失败"),
        });
      }
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/session") {
    try {
      sendJson(
        res,
        200,
        require("../../共听app/gateway/music-session").getMusicSession()
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "music_session_failed",
        message: e.message || "读取共听状态失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/session/event") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = require("../../共听app/gateway/music-session").recordSessionEvent(
        body
      );
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "music_event_failed",
        message: e.message || "记录播放事件失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/session/summary") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = require("../../共听app/gateway/music-session").postPhaseSummary(
        body
      );
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "music_summary_failed",
        message: e.message || "写入阶段总结失败",
      });
    }
    return;
  }

  /* Cove C：已导入歌单 / 队列 */
  if (req.method === "GET" && urlPath === "/api/v1/music/library/playlists") {
    try {
      sendJson(
        res,
        200,
        require("../../共听app/gateway/music-playlists").peekPlaylists()
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "playlists_failed",
        message: e.message || "读取歌单失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/library/playlists") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const plMod = require("../../共听app/gateway/music-playlists");
      const out = plMod.createPlaylist(body.name, body.song);
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "playlist_create_failed",
        message: e.message || "新建歌单失败",
      });
    }
    return;
  }

  /* 一首歌 → Liked / 多个本地歌单 / 新建（可多选） */
  if (req.method === "POST" && urlPath === "/api/v1/music/library/add-to") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const song = body.song;
      if (!song || song.id == null) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_song",
          message: "需要曲目",
        });
        return;
      }
      const plMod = require("../../共听app/gateway/music-playlists");
      const catalog = require("../../共听app/gateway/netease-catalog");
      const results = [];
      if (body.liked) {
        try {
          const liked = await catalog.likeSong(song.id, true);
          results.push({ target: "liked", ok: true, liked: !!liked.liked });
        } catch (e) {
          results.push({
            target: "liked",
            ok: false,
            message: e.message || "红心失败",
          });
        }
      }
      const ids = Array.isArray(body.playlist_ids) ? body.playlist_ids : [];
      for (const pid of ids) {
        const out = plMod.addTrackToPlaylist(pid, song);
        results.push({
          target: "playlist:" + pid,
          ok: !!out.ok,
          added: out.added,
          message: out.message,
        });
      }
      const createName = String(body.create_name || "").trim();
      if (createName) {
        const created = plMod.createPlaylist(createName, song);
        results.push({
          target: "create",
          ok: !!created.ok,
          playlist: created.playlist,
          message: created.message,
        });
      }
      const okAny = results.some((r) => r.ok);
      sendJson(res, okAny || !results.length ? 200 : 400, {
        ok: okAny,
        results,
        message: okAny
          ? "已加入所选"
          : results[0] && results[0].message
            ? results[0].message
            : "请至少选一项",
      });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "add_to_failed",
        message: e.message || "加入失败",
      });
    }
    return;
  }

  const libPlMatch = urlPath.match(
    /^\/api\/v1\/music\/library\/playlists\/([^/]+)$/
  );
  if (libPlMatch) {
    const plMod = require("../../共听app/gateway/music-playlists");
    const id = decodeURIComponent(libPlMatch[1]);
    if (req.method === "GET") {
      try {
        const out = plMod.getPlaylist(id);
        sendJson(res, out.ok ? 200 : 404, out);
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: e.code || "playlist_failed",
          message: e.message || "读取歌单失败",
        });
      }
      return;
    }
    if (req.method === "POST") {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const out = plMod.addTrackToPlaylist(id, body.song);
        sendJson(res, out.ok ? 200 : 400, out);
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: e.code || "playlist_add_failed",
          message: e.message || "加入歌单失败",
        });
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        const out = plMod.deletePlaylist(id);
        sendJson(res, out.ok ? 200 : 404, out);
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: e.code || "playlist_delete_failed",
          message: e.message || "删除失败",
        });
      }
      return;
    }
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/playlists/import") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const url = body.url || body.id || body.playlist_id || "";
      const out = await require("../../共听app/gateway/music-playlists").importPlaylistFromUrl(
        url,
        { limit: body.limit, actor: body.actor }
      );
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "import_failed",
        message: e.message || "导入歌单失败",
      });
    }
    return;
  }

  /* Cove E：今日私选 */
  if (req.method === "GET" && urlPath === "/api/v1/music/daily-discovery") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const refresh =
        q.get("refresh") === "1" || q.get("refresh") === "true";
      const out = await require("../../共听app/gateway/music-daily-discovery").getDailyDiscovery(
        { refresh, limit: q.get("limit") }
      );
      sendJson(res, out.ok === false ? 502 : 200, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "discovery_failed",
        message: e.message || "今日私选失败",
      });
    }
    return;
  }

  if (
    req.method === "POST" &&
    urlPath === "/api/v1/music/daily-discovery/feedback"
  ) {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = require("../../共听app/gateway/music-daily-discovery").recordFeedback(
        body
      );
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "feedback_failed",
        message: e.message || "反馈失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/queue") {
    try {
      const peek = require("../../共听app/gateway/music-playlists").peekPlaylists();
      sendJson(res, 200, { ok: true, queue: peek.queue || [] });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "queue_failed",
        message: e.message || "读取队列失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/queue") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const plMod = require("../../共听app/gateway/music-playlists");
      let out;
      if (body.action === "clear") out = plMod.clearQueue();
      else if (
        body.action === "from_playlist" ||
        body.action === "append_playlist"
      ) {
        out = plMod.setQueueFromPlaylist(body.playlist_id || body.id, {
          actor: body.actor,
          replace: body.replace === true || body.action === "replace_playlist",
        });
      } else if (body.action === "enqueue_next" || body.action === "play_next") {
        out = plMod.enqueueSongNext(
          body.song,
          body.after_id != null ? body.after_id : body.afterId
        );
      } else if (body.action === "enqueue" || body.song) {
        out = plMod.enqueueSong(body.song);
      } else if (body.action === "remove" || body.action === "remove_at") {
        out = plMod.removeQueueAt(
          body.index != null ? body.index : body.at
        );
      } else if (body.action === "move") {
        out = plMod.moveQueueItem(body.from, body.to);
      } else if (body.action === "at" || body.index != null) {
        out = plMod.queueSongAt(body.index);
      } else {
        out = { ok: false, error: "bad_action", message: "需要 action 或 song" };
      }
      sendJson(res, out.ok ? 200 : 400, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "queue_write_failed",
        message: e.message || "更新队列失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/netease/liked") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const out = await require("../../共听app/gateway/netease-catalog").getLikedSongs(
        { limit: q.get("limit") }
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, e.code === "need_login" ? 401 : 502, {
        ok: false,
        error: e.code || "liked_failed",
        message: e.message || "读取喜欢的歌失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/netease/playlists/add-song") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = await require("../../共听app/gateway/netease-catalog").addSongToUserPlaylist(
        body.playlist_id || body.pid,
        body.song_id || body.id
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "add_song_failed",
        message: e.message || "加入网易云歌单失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/music/netease/like") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = await require("../../共听app/gateway/netease-catalog").likeSong(
        body.song_id || body.id,
        body.like !== false && body.liked !== false
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "like_failed",
        message: e.message || "红心同步失败",
      });
    }
    return;
  }

  const lyricMatch = urlPath.match(/^\/api\/v1\/music\/lyric\/netease\/(\d+)$/);
  if (req.method === "GET" && lyricMatch) {
    try {
      const out = await require("../../共听app/gateway/netease-catalog").getLyric(
        lyricMatch[1]
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "lyric_failed",
        message: e.message || "歌词读取失败",
      });
    }
    return;
  }

  const commentsMatch = urlPath.match(
    /^\/api\/v1\/music\/comments\/netease\/(\d+)$/
  );
  if (req.method === "GET" && commentsMatch) {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const limit = Number(q.get("limit") || 8);
      const out = await require("../../共听app/gateway/netease-catalog").getHotComments(
        commentsMatch[1],
        { limit }
      );
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "comments_failed",
        message: e.message || "热评读取失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/music/netease/profile") {
    try {
      const q = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const type = q.get("type") === "0" ? 0 : 1;
      const uid = q.get("uid");
      const out = await require("../../共听app/gateway/netease-catalog").getUserListenProfile({
        uid: uid ? Number(uid) : undefined,
        type,
      });
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, e.code === "need_login" ? 401 : 502, {
        ok: false,
        error: e.code || "profile_failed",
        message: e.message || "资料读取失败",
      });
    }
    return;
  }

  const mvMatch = urlPath.match(/^\/api\/v1\/music\/mv\/netease\/(\d+)$/);
  if (req.method === "GET" && mvMatch) {
    try {
      const out = await require("../../共听app/gateway/netease-catalog").getMvUrl(
        mvMatch[1]
      );
      /* S6 后置：返回 deferred，前端默认不播 */
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.code || "mv_failed",
        message: e.message || "MV 暂不可用",
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

  /* 切歌/开播：家机主动丢一句听感或歌词 */
  if (req.method === "POST" && urlPath === "/api/v1/listen/track-share") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const song = body.song || body.track || null;
      const out = await shareListenTrackMoment({ song });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "listen_failed",
        message: e.message || "主动分享失败",
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
      const tid = body.trackId || body.id;
      const local = toggleListenFavorite(tid, {
        title: body.title || body.name,
        name: body.name,
        artist: body.artist,
        cover: body.cover,
        provider: body.provider,
      });
      let netease = null;
      const provider = String(body.provider || local.provider || "").toLowerCase();
      const nid = Math.floor(Number(tid));
      if (
        (provider === "netease" || (!provider && Number.isFinite(nid) && nid > 1e5)) &&
        Number.isFinite(nid) &&
        nid > 0
      ) {
        try {
          netease = await require("../../共听app/gateway/netease-catalog").likeSong(
            nid,
            !!local.liked
          );
        } catch (ne) {
          sendJson(res, 200, {
            ...local,
            netease_sync: false,
            netease_error: (ne && ne.message) || "红心同步网易云失败",
          });
          return;
        }
      }
      sendJson(res, 200, {
        ...local,
        netease_sync: netease ? true : false,
        netease,
      });
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
      try {
        require("../../聊天app/gateway/presence").restartPresenceLoop();
      } catch (_) {
        /* presence 可选 */
      }
      try {
        require("../../聊天app/gateway/activity").restartActivityLoop();
      } catch (_) {
        /* activity 可选 */
      }
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
      sendJson(res, 200, await getBudgetSummary());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "budget_summary_failed",
        message: e.message || "读取额度失败",
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath === "/api/v1/budget/rates") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const card = patchModelRates(body);
      sendJson(res, 200, { ok: true, card });
    } catch (e) {
      const bad = e.code === "bad_rates" || e instanceof SyntaxError;
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "budget_rates_failed",
        message: e.message || "保存价卡失败",
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

  if (req.method === "POST" && urlPath === "/api/v1/cal/auto-sync") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { syncAutoEvents } = require("../../日历app/gateway/calendar");
      sendJson(res, 200, syncAutoEvents(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_cal_date" ? 400 : 500, {
        ok: false,
        error: e.code || "cal_auto_sync_failed",
        message: e.message || "同步节日失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/cal/scan-chat") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { scanChatPropose } = require("../../日历app/gateway/calendar");
      sendJson(res, 200, await scanChatPropose(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_cal_date" ? 400 : 500, {
        ok: false,
        error: e.code || "cal_scan_failed",
        message: e.message || "扫近聊失败",
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

  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/moments/pending/") &&
    urlPath.endsWith("/confirm")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/moments/pending/".length, -"/confirm".length)
      );
      const { confirmPending } = require("../../聊天app/gateway/moments");
      sendJson(res, 200, confirmPending(id));
    } catch (e) {
      sendJson(res, e.code === "pending_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "moments_confirm_failed",
        message: e.message || "确认失败",
      });
    }
    return;
  }

  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/moments/pending/") &&
    urlPath.endsWith("/reject")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/moments/pending/".length, -"/reject".length)
      );
      const { rejectPending } = require("../../聊天app/gateway/moments");
      sendJson(res, 200, rejectPending(id));
    } catch (e) {
      sendJson(res, e.code === "pending_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "moments_reject_failed",
        message: e.message || "拒绝失败",
      });
    }
    return;
  }

  /* IB D1：DIY HTTP 调用前确认 */
  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/chat/diy-http/pending/") &&
    (urlPath.endsWith("/confirm") || urlPath.endsWith("/reject"))
  ) {
    try {
      const accept = urlPath.endsWith("/confirm");
      const id = decodeURIComponent(
        urlPath.slice(
          "/api/v1/chat/diy-http/pending/".length,
          accept ? -"/confirm".length : -"/reject".length
        )
      );
      const { confirmDiyPending } = require("../../聊天app/gateway/diy-http");
      sendJson(res, 200, await confirmDiyPending(id, accept));
    } catch (e) {
      sendJson(res, e.code === "diy_pending_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "diy_confirm_failed",
        message: e.message || "确认失败",
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

  if (req.method === "GET" && urlPath === "/api/v1/chat/peers") {
    try {
      sendJson(res, 200, listPeers());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_peers_failed",
        message: e.message || "读取会话列表失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/peers") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, createPeer(body || {}));
    } catch (e) {
      const bad =
        e.code === "peer_name_required" ||
        e.code === "peer_avatar_invalid" ||
        e.code === "peer_avatar_too_long" ||
        e.code === "peer_id_invalid";
      sendJson(res, bad ? 400 : 500, {
        ok: false,
        error: e.code || "chat_peer_create_failed",
        message: e.message || "创建会话失败",
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath.startsWith("/api/v1/chat/peers/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/chat/peers/".length).split("/")[0] || "");
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, updatePeer(id, body || {}));
    } catch (e) {
      const code =
        e.code === "peer_missing"
          ? 404
          : e.code === "peer_name_required" ||
              e.code === "peer_avatar_invalid" ||
              e.code === "peer_avatar_too_long"
            ? 400
            : 500;
      sendJson(res, code, {
        ok: false,
        error: e.code || "chat_peer_update_failed",
        message: e.message || "更新会话失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/file-excerpt") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const name = String((body && body.name) || "").trim().slice(0, 120);
      const b64 = String((body && body.data_base64) || "").replace(/\s/g, "");
      if (!name || !b64) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_request",
          message: "需要 name 与 data_base64",
        });
        return;
      }
      if (b64.length > 2.8e6) {
        sendJson(res, 413, {
          ok: false,
          error: "too_large",
          message: "文件太大（摘录上限约 2MB）",
        });
        return;
      }
      const buf = Buffer.from(b64, "base64");
      const { excerptByName, TEXT_MAX } = require("../../聊天app/gateway/file-excerpt");
      const text = excerptByName(name, buf);
      sendJson(res, 200, {
        ok: true,
        name,
        text: text || "",
        has_text: !!text,
        max: TEXT_MAX,
        message: text
          ? "已摘录"
          : "未能从该格式抽出正文（可改发 txt/md）",
      });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "file_excerpt_failed",
        message: e.message || "摘录失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/chat/peers/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/chat/peers/".length).split("/")[0] || "");
      sendJson(res, 200, deletePeer(id));
    } catch (e) {
      const code =
        e.code === "peer_protected"
          ? 403
          : e.code === "peer_missing"
            ? 404
            : 500;
      sendJson(res, code, {
        ok: false,
        error: e.code || "chat_peer_delete_failed",
        message: e.message || "删除失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/archive") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      const out = withChatRequest(req, body, () => {
        if (Object.prototype.hasOwnProperty.call(body, "archive_before_ts") && !body.message_id) {
          return setArchiveBeforeTs(body.archive_before_ts);
        }
        const mid = body.message_id || body.messageId || "";
        if (!mid && (body.clear || body.archive_before_ts === 0)) {
          return setArchiveBeforeTs(0);
        }
        return setArchiveAtMessage(mid);
      });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const code = e.code || "archive_failed";
      const status =
        code === "msg_missing" || code === "topic_missing" || code === "bad_archive"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: e.message || "封档失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/messages") {
    withChatRequest(req, null, () => sendJson(res, 200, listMessages()));
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/topics") {
    try {
      const {
        listTopics,
      } = require("../../聊天app/gateway/daily-chat");
      sendJson(res, 200, listTopics(peerFromRequest(req)));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "topics_list_failed",
        message: e.message || "读取话题失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/topics") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const {
        createTopic,
        setActiveTopic,
      } = require("../../聊天app/gateway/daily-chat");
      const peer = peerFromRequest(req, body);
      const out = createTopic(peer, body);
      if (body && body.activate !== false && out.topic && out.topic.id) {
        setActiveTopic(peer, out.topic.id);
      }
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "topics_full" ? 400 : 500, {
        ok: false,
        error: e.code || "topics_create_failed",
        message: e.message || "新建话题失败",
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath.startsWith("/api/v1/chat/topics/")) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/topics/".length).split("/")[0] || ""
      );
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const {
        updateTopic,
        setActiveTopic,
      } = require("../../聊天app/gateway/daily-chat");
      const peer = peerFromRequest(req, body);
      if (body && body.activate) {
        sendJson(res, 200, setActiveTopic(peer, id));
        return;
      }
      sendJson(res, 200, updateTopic(peer, id, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "topic_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "topics_update_failed",
        message: e.message || "更新话题失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/chat/topics/")) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/topics/".length).split("/")[0] || ""
      );
      const { deleteTopic } = require("../../聊天app/gateway/daily-chat");
      sendJson(res, 200, deleteTopic(peerFromRequest(req), id));
    } catch (e) {
      sendJson(res, e.code === "topic_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "topics_delete_failed",
        message: e.message || "删除话题失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/topics/activate") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { setActiveTopic } = require("../../聊天app/gateway/daily-chat");
      sendJson(
        res,
        200,
        setActiveTopic(
          peerFromRequest(req, body),
          body.topicId != null ? body.topicId : body.topic
        )
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "topic_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "topics_activate_failed",
        message: e.message || "切换话题失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/prefs") {
    sendJson(res, 200, getChatPrefs());
    return;
  }

  if (req.method === "DELETE" && urlPath === "/api/v1/chat/messages") {
    try {
      sendJson(
        res,
        200,
        withChatRequest(req, null, () => clearChatMessages())
      );
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
      const peer = peerFromRequest(req);
      sendJson(res, 200, getMoodPublic({ peerId: peer }));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "mood_failed",
        message: e.message || "读取心情失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/mood/lexicon") {
    try {
      sendJson(res, 200, listLexiconPublic());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "lexicon_failed",
        message: e.message || "读取词表失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/mood/lexicon") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      sendJson(res, 200, addLexiconExtra(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_lexicon" ? 400 : 500, {
        ok: false,
        error: e.code || "lexicon_add_failed",
        message: e.message || "加词失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/chat/mood/lexicon/")) {
    try {
      const w = decodeURIComponent(
        urlPath.slice("/api/v1/chat/mood/lexicon/".length)
      );
      sendJson(res, 200, removeLexiconExtra(w));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "lexicon_del_failed",
        message: e.message || "删词失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/letters") {
    try {
      const peer = peerFromRequest(req);
      const sp = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const { listLetters } = require("../../聊天app/gateway/letters");
      sendJson(
        res,
        200,
        listLetters(peer, {
          q: String(sp.get("q") || "").trim() || undefined,
          limit: Number(sp.get("limit") || 80),
        })
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "letters_list_failed",
        message: e.message || "读取邮局失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/letters/draft") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { saveDraft } = require("../../聊天app/gateway/letters");
      sendJson(res, 200, saveDraft(peer, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "bad_letter" ||
          e.code === "drafts_full" ||
          e.code === "letters_full" ||
          e.code === "letter_locked"
          ? 400
          : 500,
        {
          ok: false,
          error: e.code || "letters_draft_failed",
          message: e.message || "存草稿失败",
        }
      );
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/letters/send") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { sendLetter, receiveLetter } = require("../../聊天app/gateway/letters");
      const out = sendLetter(peer, body);
      if (body && body.await_reply) {
        try {
          const reply = await receiveLetter(peer, {
            reply_to: out.letter && out.letter.id,
          });
          sendJson(res, 200, { ...out, reply: reply.letter });
          return;
        } catch (re) {
          sendJson(res, 200, {
            ...out,
            reply_error: (re && re.message) || "回信失败",
          });
          return;
        }
      }
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "bad_letter" ||
          e.code === "letters_full" ||
          e.code === "letter_locked"
          ? 400
          : 500,
        {
          ok: false,
          error: e.code || "letters_send_failed",
          message: e.message || "寄信失败",
        }
      );
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/letters/receive") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { receiveLetter } = require("../../聊天app/gateway/letters");
      sendJson(res, 200, await receiveLetter(peer, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const code = e && e.code;
      sendJson(
        res,
        code === "budget_exhausted" || code === "bad_reply_to"
          ? 400
          : code === "letter_missing"
            ? 404
            : 500,
        {
          ok: false,
          error: code || "letters_receive_failed",
          message: e.message || "收信失败",
        }
      );
    }
    return;
  }

  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/chat/letters/") &&
    urlPath.endsWith("/open")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/letters/".length, -"/open".length)
      );
      const raw = await readBody(req).catch(() => "");
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { openLetter } = require("../../聊天app/gateway/letters");
      sendJson(res, 200, openLetter(peer, id));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "letter_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "letters_open_failed",
        message: e.message || "拆信失败",
      });
    }
    return;
  }

  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/chat/letters/") &&
    urlPath.endsWith("/memory")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/letters/".length, -"/memory".length)
      );
      const raw = await readBody(req).catch(() => "");
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { letterToMemory } = require("../../聊天app/gateway/letters");
      sendJson(res, 200, letterToMemory(peer, id));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "letter_missing"
          ? 404
          : e.code === "bad_memory"
            ? 400
            : 500,
        {
          ok: false,
          error: e.code || "letters_memory_failed",
          message: e.message || "写入记忆失败",
        }
      );
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/chat/letters/")) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/letters/".length).split("/")[0] || ""
      );
      const { deleteLetter } = require("../../聊天app/gateway/letters");
      sendJson(res, 200, deleteLetter(peerFromRequest(req), id));
    } catch (e) {
      sendJson(res, e.code === "letter_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "letters_delete_failed",
        message: e.message || "删信失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/auto-memory") {
    try {
      const peer = peerFromRequest(req);
      const sp = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const { listEntries } = require("../../聊天app/gateway/auto-memory");
      sendJson(
        res,
        200,
        listEntries(peer, {
          q: String(sp.get("q") || "").trim() || undefined,
          category: String(sp.get("category") || "").trim() || undefined,
          limit: Number(sp.get("limit") || 80),
        })
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "auto_memory_list_failed",
        message: e.message || "读取档案失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/auto-memory") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const { upsertEntry } = require("../../聊天app/gateway/auto-memory");
      sendJson(res, 200, upsertEntry(peer, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "bad_auto_memory" || e.code === "auto_memory_always_full"
          ? 400
          : 500,
        {
          ok: false,
          error: e.code || "auto_memory_write_failed",
          message: e.message || "写入档案失败",
        }
      );
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/chat/auto-memory/")) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/auto-memory/".length)
      );
      const peer = peerFromRequest(req);
      const { deleteEntry } = require("../../聊天app/gateway/auto-memory");
      sendJson(res, 200, deleteEntry(peer, id));
    } catch (e) {
      sendJson(res, e.code === "auto_memory_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "auto_memory_delete_failed",
        message: e.message || "删除档案失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/memory") {
    try {
      const peer = peerFromRequest(req);
      const sp = new URL(req.url || "/", "http://127.0.0.1").searchParams;
      const q = String(sp.get("q") || "").trim();
      const limit = Number(sp.get("limit") || 80);
      sendJson(res, 200, listPeerMemories(peer, { limit, q: q || undefined }));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "memory_list_failed",
        message: e.message || "读取记忆失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/memory") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      sendJson(res, 200, addMemory(peer, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_memory" ? 400 : 500, {
        ok: false,
        error: e.code || "memory_add_failed",
        message: e.message || "写入记忆失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/memory/digest-status") {
    try {
      const peer = peerFromRequest(req);
      sendJson(res, 200, digestStatus(peer));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "digest_status_failed",
        message: e.message || "读取总结状态失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/memory/digest") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      const peer = peerFromRequest(req, body);
      const ids = Array.isArray(body.message_ids)
        ? body.message_ids
        : Array.isArray(body.messageIds)
          ? body.messageIds
          : null;
      const out = ids
        ? await withChatRequest(req, body, () => digestFromMessageIds(ids))
        : await digestNewMemories(peer);
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const code = e.code || "digest_failed";
      const status =
        code === "budget_exhausted"
          ? 402
          : code === "bad_memory" || code === "bad_digest_ids"
            ? 400
            : 500;
      sendJson(res, status, {
        ok: false,
        error: code,
        message: e.message || "总结记忆失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/memory/dehydrate") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      const peer = peerFromRequest(req, body);
      const out = await dehydrateMemories(peer, body);
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const code = e.code || "dehydrate_failed";
      sendJson(res, code === "budget_exhausted" ? 402 : 500, {
        ok: false,
        error: code,
        message: e.message || "脱水失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath.startsWith("/api/v1/chat/memory/") && urlPath.endsWith("/source")) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/chat/memory/".length, -"/source".length)
      );
      const peer = peerFromRequest(req);
      sendJson(res, 200, traceMemorySource(peer, id));
    } catch (e) {
      sendJson(res, e.code === "memory_missing" ? 404 : 500, {
        ok: false,
        error: e.code || "memory_source_failed",
        message: e.message || "追溯失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/memory/sentinel") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      const peer = peerFromRequest(req, body);
      sendJson(
        res,
        200,
        await llmSentinelRoute(peer, body && (body.text || body.content))
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "sentinel_route_failed",
        message: e.message || "哨兵失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/mood/batch") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      sendJson(res, 200, await runMoodBatch(body));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "mood_batch_failed",
        message: e.message || "批处理失败",
      });
    }
    return;
  }

  const memUnresolved = urlPath.match(
    /^\/api\/v1\/chat\/memory\/([^/]+)\/unresolved$/
  );
  if (req.method === "PATCH" && memUnresolved) {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw || "{}") : {};
      const peer = peerFromRequest(req, body);
      sendJson(
        res,
        200,
        toggleUnresolved(peer, decodeURIComponent(memUnresolved[1]))
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "not_found" ? 404 : e.code === "bad_memory" ? 400 : 500,
        {
          ok: false,
          error: e.code || "memory_patch_failed",
          message: e.message || "更新记忆失败",
        }
      );
    }
    return;
  }

  const memOne = urlPath.match(/^\/api\/v1\/chat\/memory\/([^/]+)$/);
  if (memOne && (req.method === "PUT" || req.method === "DELETE")) {
    try {
      const id = decodeURIComponent(memOne[1]);
      if (req.method === "DELETE") {
        const peer = peerFromRequest(req);
        sendJson(res, 200, deleteMemory(peer, id));
      } else {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const peer = peerFromRequest(req, body);
        sendJson(res, 200, updateMemory(peer, id, body));
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(
        res,
        e.code === "not_found" ? 404 : e.code === "bad_memory" ? 400 : 500,
        {
          ok: false,
          error: e.code || "memory_mutate_failed",
          message: e.message || "操作记忆失败",
        }
      );
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/translate") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const out = await translateChatText(body && body.text, body && body.to);
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
  if (req.method === "GET" && urlPath === "/api/v1/chat/mcp/status") {
    try {
      const { getMcpStatus } = require("./mcp-remote");
      sendJson(res, 200, { ok: true, status: getMcpStatus() });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "mcp_status_failed",
        message: e.message || "读取 MCP 状态失败",
      });
    }
    return;
  }

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
      const url_2 =
        body && body.url_2 != null
          ? String(body.url_2)
          : String(settings.mcp_url_2 || "");
      const token_2 =
        body && body.token_2 != null
          ? String(body.token_2)
          : String(settings.mcp_token_2 || "");
      const out = await pingMcpConnection({ url, token, url_2, token_2 });
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
          peer: u.searchParams.get("peer") || "",
          topic: u.searchParams.get("topic") || "",
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

  if (req.method === "GET" && urlPath === "/api/v1/wallet/pocket-keys") {
    try {
      sendJson(res, 200, getPocketKeys());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "pocket_keys_failed",
        message: e.message || "读取零花钥失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/wallet/adjust") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, walletAdjust(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "bad_wallet_amount" ||
        e.code === "wallet_insufficient" ||
        e.code === "card_missing" ||
        e.code === "bad_wallet_party"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "wallet_adjust_failed",
        message: e.message || "零花调账失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/wallet/cards") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, addCard(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "bad_card" || e.code === "cards_full" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "card_add_failed",
        message: e.message || "添加银行卡失败",
      });
    }
    return;
  }

  if (req.method === "PATCH" && urlPath.startsWith("/api/v1/wallet/cards/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/wallet/cards/".length));
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, patchCard(id, body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "card_missing" || e.code === "bad_card" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "card_patch_failed",
        message: e.message || "更新银行卡失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/wallet/cards/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/wallet/cards/".length));
      sendJson(res, 200, removeCard(id));
    } catch (e) {
      const status = e.code === "card_missing" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "card_delete_failed",
        message: e.message || "删除银行卡失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/wealth") {
    try {
      sendJson(res, 200, getWealth());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "wealth_failed",
        message: e.message || "读取剧场资产失败",
      });
    }
    return;
  }

  if (req.method === "PUT" && urlPath === "/api/v1/wealth") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, putWealth(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "bad_wealth" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "wealth_save_failed",
        message: e.message || "保存剧场资产失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/wealth/adjust") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, wealthAdjust(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status = e.code === "bad_wealth_adjust" || e.code === "bad_wealth" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "wealth_adjust_failed",
        message: e.message || "剧场调账失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/memo") {
    try {
      try {
        ensureMemoSeeded();
      } catch (_) {}
      sendJson(res, 200, listMemo());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "memo_failed",
        message: e.message || "读取备忘录失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/memo/keys") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, upsertMemoKey(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "memo_missing" || e.code === "memo_full" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "memo_key_failed",
        message: e.message || "保存密钥失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/memo/keys/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/memo/keys/".length));
      sendJson(res, 200, removeMemoKey(id));
    } catch (e) {
      const status = e.code === "memo_missing" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "memo_key_delete_failed",
        message: e.message || "删除密钥失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/memo/notes") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, upsertMemoNote(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "memo_missing" || e.code === "memo_full" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "memo_note_failed",
        message: e.message || "保存杂记失败",
      });
    }
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/api/v1/memo/notes/")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/memo/notes/".length));
      sendJson(res, 200, removeMemoNote(id));
    } catch (e) {
      const status = e.code === "memo_missing" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "memo_note_delete_failed",
        message: e.message || "删除杂记失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/economy/tiers") {
    try {
      const { resolveAppPersona } = require("./settings");
      const persona = resolveAppPersona("chat");
      const text = String((persona && persona.persona_card) || "").trim();
      const suggest = suggestEconomyTier(text);
      sendJson(res, 200, {
        ok: true,
        tiers: listEconomyTiers(),
        suggested: suggest.suggested,
        suggest_reason: suggest.reason,
        has_persona: !!text,
      });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "economy_tiers_failed",
        message: e.message || "读取开局档失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/economy/tiers/apply") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, applyEconomyTier(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "confirm_required" || e.code === "bad_tier" || e.code === "bad_wealth" ? 400 : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "economy_tier_apply_failed",
        message: e.message || "应用开局档失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/economy/events") {
    try {
      sendJson(res, 200, listEconomyEvents());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "economy_events_failed",
        message: e.message || "读取经济事件失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/economy/events") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      sendJson(res, 200, createAndApplyEconomyEvent(body));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "bad_economy_event" ||
        e.code === "bad_wallet_amount" ||
        e.code === "wallet_insufficient" ||
        e.code === "bad_wealth_adjust"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "economy_event_failed",
        message: e.message || "经济事件入账失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath.startsWith("/api/v1/economy/events/") && urlPath.endsWith("/apply")) {
    try {
      const id = decodeURIComponent(urlPath.slice("/api/v1/economy/events/".length, -"/apply".length));
      sendJson(res, 200, applyEconomyEvent(id));
    } catch (e) {
      const status =
        e.code === "bad_economy_event" ||
        e.code === "economy_event_missing" ||
        e.code === "bad_wallet_amount" ||
        e.code === "wallet_insufficient" ||
        e.code === "bad_wealth_adjust"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "economy_apply_failed",
        message: e.message || "应用经济事件失败",
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
      let originalName = "";
      try {
        const hdr = req.headers["x-filename"];
        if (hdr) originalName = decodeURIComponent(String(hdr));
      } catch (_) {
        originalName = "";
      }
      const cap = originalName ? FILE_MAX_BYTES : MEDIA_MAX_BYTES;
      const buf = await readBodyBuffer(req, cap);
      const out = saveChatMedia(
        buf,
        req.headers["content-type"],
        originalName || undefined
      );
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
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      sendJson(
        res,
        200,
        withPeer(peer, () => markAllRead())
      );
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
      sendJson(
        res,
        200,
        withPeer(DEFAULT_PEER_ID, () => pokeDaily({}))
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "chat_poke_failed",
        message: e.message || "主动短讯失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/sentinel/status") {
    try {
      const { getPresenceStatus } = require("../../聊天app/gateway/presence");
      let activity = null;
      try {
        activity = require("../../聊天app/gateway/activity").getActivityStatus();
      } catch (_) {}
      sendJson(res, 200, { ...getPresenceStatus(), activity });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "sentinel_status_failed",
        message: e.message || "哨兵状态失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/activity/status") {
    try {
      const { getActivityStatus } = require("../../聊天app/gateway/activity");
      sendJson(res, 200, getActivityStatus());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "activity_status_failed",
        message: e.message || "活动状态失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/phone/presence") {
    try {
      const {
        getPresence,
        summarizePeek,
        summarizeDevice,
      } = require("../../聊天app/gateway/phone-presence");
      const { readSettings } = require("./settings");
      const s = readSettings();
      sendJson(res, 200, {
        ok: true,
        presence: getPresence(),
        peek: summarizePeek({ l1: !!s.peek_phone_l1_enabled }),
        device: summarizeDevice(),
      });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "phone_presence_failed",
        message: e.message || "读手机状态失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/phone/presence") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { putPresence } = require("../../聊天app/gateway/phone-presence");
      sendJson(res, 200, putPresence(body || {}));
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "phone_presence_write_failed",
        message: e.message || "写手机状态失败",
      });
    }
    return;
  }

  /* 查手机：翻看中代发演出结果 */
  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/phone/peek/") &&
    urlPath.endsWith("/compose")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/phone/peek/".length, -"/compose".length)
      );
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        body = {};
      }
      const { setPeekCompose } = require("../../聊天app/gateway/phone-presence");
      sendJson(res, 200, setPeekCompose(id, body));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "peek_compose_failed",
        message: e.message || "代发记录失败",
      });
    }
    return;
  }

  /* 查手机：翻看中强制下线 */
  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/phone/peek/") &&
    urlPath.endsWith("/abort")
  ) {
    try {
      const id = decodeURIComponent(
        urlPath.slice("/api/v1/phone/peek/".length, -"/abort".length)
      );
      const { abortPeekBrowse } = require("../../聊天app/gateway/phone-presence");
      const out = abortPeekBrowse(id);
      if (!out.ok) {
        sendJson(res, 404, out);
        return;
      }
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "peek_abort_failed",
        message: e.message || "强制下线失败",
      });
    }
    return;
  }

  /* 查手机申请：同意 / 拒绝（同意可附带当前 presence） */
  if (
    req.method === "POST" &&
    urlPath.startsWith("/api/v1/phone/peek/") &&
    (urlPath.endsWith("/accept") || urlPath.endsWith("/reject"))
  ) {
    try {
      const accept = urlPath.endsWith("/accept");
      const id = decodeURIComponent(
        urlPath.slice(
          "/api/v1/phone/peek/".length,
          -(accept ? "/accept".length : "/reject".length)
        )
      );
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        body = {};
      }
      const { answerPeekWait } = require("../../聊天app/gateway/phone-presence");
      const out = answerPeekWait(
        id,
        accept,
        accept && body && body.presence ? body.presence : null
      );
      if (!out.ok) {
        sendJson(res, 404, out);
        return;
      }
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "peek_answer_failed",
        message: e.message || "查手机应答失败",
      });
    }
    return;
  }

  /* 反查：家机的虚拟手机 */
  if (req.method === "GET" && urlPath === "/api/v1/bot-phone") {
    try {
      const { getOverview } = require("../../聊天app/gateway/bot-phone");
      const s = readSettings();
      sendJson(res, 200, getOverview((s && s.name_bot) || "家机"));
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "bot_phone_failed",
        message: e.message || "读取对方手机失败",
      });
    }
    return;
  }
  if (req.method === "POST" && urlPath === "/api/v1/bot-phone/open") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { openApp } = require("../../聊天app/gateway/bot-phone");
      const s = readSettings();
      sendJson(
        res,
        200,
        openApp((body && body.app) || "home", (s && s.name_bot) || "家机")
      );
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "bot_phone_open_failed",
        message: e.message || "打开失败",
      });
    }
    return;
  }
  if (req.method === "POST" && urlPath === "/api/v1/bot-phone/chat") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { openChat } = require("../../聊天app/gateway/bot-phone");
      const s = readSettings();
      const out = openChat(
        (body && body.chat_id) || "",
        (s && s.name_bot) || "家机"
      );
      sendJson(res, out.ok ? 200 : 404, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "bot_phone_chat_failed",
        message: e.message || "打开会话失败",
      });
    }
    return;
  }
  if (req.method === "POST" && urlPath === "/api/v1/bot-phone/memo") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { updateMemo } = require("../../聊天app/gateway/bot-phone");
      const s = readSettings();
      const out = updateMemo(
        (body && body.id) || "",
        (body && body.body) || "",
        (s && s.name_bot) || "家机"
      );
      sendJson(res, out.ok ? 200 : 404, out);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "bot_phone_memo_failed",
        message: e.message || "改备忘失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/geo") {
    try {
      const { readGeo } = require("../../聊天app/gateway/weather");
      sendJson(res, 200, readGeo());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "geo_read_failed",
        message: e.message || "读取定位失败",
      });
    }
    return;
  }

  /* IB M8：抽屉天气（复用 H10 Open-Meteo 缓存；不要求 AI 天气工具已开） */
  if (req.method === "GET" && urlPath === "/api/v1/chat/weather") {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const { getWeatherTool } = require("../../聊天app/gateway/weather");
      const s = readSettings();
      const city = String(u.searchParams.get("city") || "").trim();
      const out = await getWeatherTool({
        city: city || undefined,
        manualCity: s.weather_city || "",
      });
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: e.code || "weather_failed",
        message: e.message || "天气暂不可用",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/geo") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { writeGeo, clearGeo } = require("../../聊天app/gateway/weather");
      if (body && body.clear) {
        sendJson(res, 200, clearGeo());
        return;
      }
      sendJson(
        res,
        200,
        writeGeo({
          lat: body.lat,
          lon: body.lon != null ? body.lon : body.lng,
          label: body.label,
          source: body.source || "browser",
        })
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, e.code === "bad_geo" ? 400 : 500, {
        ok: false,
        error: e.code || "geo_write_failed",
        message: e.message || "写入定位失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/sentinel/tick") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { runSentinelTick } = require("../../聊天app/gateway/presence");
      const out = await runSentinelTick({
        force: !!(body && body.force),
        skipCapture: !!(body && body.skipCapture),
      });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "sentinel_tick_failed",
        message: e.message || "哨兵 tick 失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/presence/dice") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { runPresenceDiceTick } = require("../../聊天app/gateway/presence");
      const out = runPresenceDiceTick({
        force: !!(body && body.force),
        forceKind: body && body.kind ? String(body.kind) : undefined,
        roll: body && body.roll != null ? Number(body.roll) : undefined,
      });
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "presence_dice_failed",
        message: e.message || "骰子 tick 失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/sentinel/logs") {
    try {
      const u = new URL(req.url || "/", "http://local");
      const date = u.searchParams.get("date") || "";
      const {
        readMonitorLogs,
        listMonitorLogDates,
        localDateISO,
      } = require("../../聊天app/gateway/monitor-log");
      const day = date || localDateISO();
      sendJson(res, 200, {
        ok: true,
        date: day,
        dates: listMonitorLogDates(),
        logs: readMonitorLogs(day),
      });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "sentinel_logs_failed",
        message: e.message || "监控日志读取失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/sentinel/logs/stream") {
    try {
      const { subscribeMonitorLogs } = require("../../聊天app/gateway/monitor-log");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket && typeof res.socket.setNoDelay === "function") {
        res.socket.setNoDelay(true);
      }
      res.write(":" + " ".repeat(512) + "\n\n");
      res.write(
        "data: " + JSON.stringify({ type: "monitor_log_hello", ok: true }) + "\n\n"
      );
      const unsub = subscribeMonitorLogs((entry) => {
        try {
          res.write(
            "data: " +
              JSON.stringify({ type: "monitor_log", data: entry }) +
              "\n\n"
          );
        } catch (_) {}
      });
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch (_) {}
      }, 25000);
      const onClose = () => {
        clearInterval(ping);
        unsub();
      };
      req.on("close", onClose);
      res.on("close", onClose);
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: e.code || "sentinel_stream_failed",
          message: e.message || "监控日志流失败",
        });
      }
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/money/claim") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const mid = body && body.id;
      sendJson(
        res,
        200,
        withPeer(peerForMessageOp(req, body, mid), () => claimIncomingMoney(mid))
      );
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
        withPeer(peerFromRequest(req, body), () =>
          startChatCall(
            body && body.media,
            (body && (body.dir || body.direction)) || "out"
          )
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

  if (req.method === "GET" && urlPath === "/api/v1/tts/status") {
    sendJson(res, 200, ttsStatus());
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/tts") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = String((body && body.text) || "").trim();
      const language = String((body && (body.language || body.lang)) || "zh").trim();
      const audio = await synthesizeSpeech(text, { language });
      res.writeHead(200, {
        "Content-Type": audio.contentType || "audio/mpeg",
        "Cache-Control": "no-store",
        "X-TTS-Provider": audio.provider || "fish",
      });
      res.end(audio.buf);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "tts_not_configured"
          ? 503
          : e.code === "tts_empty"
            ? 400
            : e.code === "tts_fish_failed"
              ? 502
              : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "tts_failed",
        message: e.message || "朗读失败",
        fallback: "browser",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/voice-turn") {
    try {
      const peer = peerFromRequest(req);
      const ctype = String(req.headers["content-type"] || "audio/webm");
      const buf = await readBodyBuffer(req, MEDIA_MAX_BYTES);
      const videoHdr = String(req.headers["x-call-media"] || "").toLowerCase();
      const isVideo = videoHdr === "video";
      const result = await withPeer(peer, () =>
        runVoiceTurn({
          buf,
          contentType: ctype,
          filename: "call.webm",
          video: isVideo,
        })
      );
      if (result && result.used) addTokensUsed(result.used);
      sendJson(res, 200, result);
    } catch (e) {
      const status =
        e.code === "voice_empty" || e.code === "asr_empty"
          ? 400
          : e.code === "llm_not_configured" || e.code === "bad_audio"
            ? 400
            : e.code === "asr_failed" || e.code === "asr_unsupported"
              ? 502
              : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "voice_turn_failed",
        message: e.message || "通话回合失败",
      });
    }
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/call/heartbeat") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const peer = peerFromRequest(req, body);
      const result = await withPeer(peer, () =>
        runCallHeartbeat({
          streak: body && body.streak,
          video: !!(body && (body.video || body.media === "video")),
        })
      );
      if (result && result.used) addTokensUsed(result.used);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const status =
        e.code === "llm_not_configured" || e.code === "llm_empty"
          ? 400
          : 500;
      sendJson(res, status, {
        ok: false,
        error: e.code || "call_heartbeat_failed",
        message: e.message || "通话心跳失败",
      });
    }
    return;
  }

  if (req.method === "GET" && urlPath === "/api/v1/chat/call/gifts") {
    sendJson(res, 200, { ok: true, gifts: listGifts() });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/v1/chat/call/gift") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const { readSettings } = require("./settings");
      if (!readSettings().call_gift_enabled) {
        sendJson(res, 403, {
          ok: false,
          error: "gift_disabled",
          message: "礼物未开启",
        });
        return;
      }
      const gift = giftByTier(body && body.tier);
      if (!gift) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_gift",
          message: "礼物档位无效",
        });
        return;
      }
      const peer = peerFromRequest(req, body);
      const message = withPeer(peer, () => {
        const { appendMessage } = require("../../聊天app/gateway/daily-chat");
        return appendMessage(
          "you",
          gift.emoji + " 送出了" + gift.name,
          "text",
          {
            payload: {
              source: "call_gift",
              gift: { tier: gift.tier, id: gift.id, name: gift.name },
            },
          }
        );
      });
      sendJson(res, 200, { ok: true, gift, message });
    } catch (e) {
      if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: e.code || "gift_failed",
        message: e.message || "送礼失败",
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
      await withChatRequest(req, body, async () => {
        let { youBlockedPeer } = require("../../聊天app/gateway/daily-chat");
        /* 你已拉黑：强制 noreply + blocked_send，保证气泡有感叹号 */
        if (youBlockedPeer()) {
          body.noreply = true;
          body.blocked_send = true;
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
      });
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
        const peer = peerForMessageOp(req, null, id);
        await withPeer(peer, async () => {
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
        });
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
        const id = decodeURIComponent(varMatch[1]);
        const msg = withPeer(peerForMessageOp(req, body, id), () =>
          setMessageVariant(id, body && body.index)
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
        const raw = await readBody(req);
        let recallOpts = {};
        let recallBody = {};
        try {
          const o = raw ? JSON.parse(raw) : {};
          if (o && typeof o === "object") {
            recallBody = o;
            if (o.screenshot) recallOpts.screenshotUrl = String(o.screenshot);
            if (o.force_sight) recallOpts.forceSight = String(o.force_sight);
          }
        } catch (_) {
          recallOpts = {};
        }
        const peer = peerForMessageOp(req, recallBody, recallId);
        await withPeer(peer, async () => {
        const hit = (listMessages().messages || []).find((m) => m && m.id === recallId);
        if (hit && !hit.recalled && recallExpired(hit.ts)) {
          sendJson(res, 400, {
            ok: false,
            error: "recall_expired",
            message: "超过2分钟不能撤回",
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
        await recallMessageWithReplyStream(recallId, emit, recallOpts);
        res.end();
        });
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
        const id = decodeURIComponent(reactMatch[1]);
        const msg = withPeer(peerForMessageOp(req, body, id), () =>
          toggleMessageReaction(id, body && body.emoji, "you")
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
        const id = decodeURIComponent(asrMatch[1]);
        const msg = await withPeer(peerForMessageOp(req, null, id), () =>
          toggleVoiceTranscript(id)
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
      const peer = peerFromRequest(req, body);
      const out = withPeer(peer, () =>
        createPat({
          target: body && body.target === "you" ? "you" : "bot",
        })
      );
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
        const id = decodeURIComponent(delMatch[1]);
        const peer = peerForMessageOp(req, null, id);
        sendJson(
          res,
          200,
          withPeer(peer, () => deleteMessage(id, indexOpt))
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

  if (req.method === "POST" && urlPath === "/api/v1/watch/titles/scan") {
    try {
      sendJson(res, 200, scanMediaLibrary());
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e.code || "watch_scan_failed",
        message: e.message || "扫库失败",
      });
    }
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

try {
  require("./ws-hub").attachWsHub(server);
} catch (e) {
  console.warn("ws hub skipped:", (e && e.message) || e);
}

server.listen(PORT, HOST, () => {
  console.log(`gateway listening on http://${HOST}:${PORT}`);
  console.log(`websocket on ws://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/ws`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.log("LAN bind on: set phone URL to http://<电脑局域网IP>:" + PORT);
  }
  try {
    require("../../聊天app/gateway/presence").restartPresenceLoop();
  } catch (e) {
    console.warn("presence loop skipped:", (e && e.message) || e);
  }
  try {
    require("../../聊天app/gateway/activity").restartActivityLoop();
  } catch (e) {
    console.warn("activity loop skipped:", (e && e.message) || e);
  }
  try {
    startMoodBatchScheduler();
  } catch (e) {
    console.warn("mood batch skipped:", (e && e.message) || e);
  }
  try {
    ensureMemoSeeded();
  } catch (e) {
    console.warn("pocket-keys memo seed skipped:", (e && e.message) || e);
  }
  try {
    require("../../聊天app/gateway/schedule-monitor").startMonitorLoop();
  } catch (e) {
    console.warn("schedule-monitor loop skipped:", (e && e.message) || e);
  }
  try {
    require("./mcp-remote").startMcpHeartbeat(() => readSettings());
  } catch (e) {
    console.warn("mcp heartbeat skipped:", (e && e.message) || e);
  }
});
