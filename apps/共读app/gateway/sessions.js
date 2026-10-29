const fs = require("node:fs");
const path = require("node:path");
const { getHighlights, findBook } = require("./highlights");
const { readBooks, setInProgress, ensureActivePass, setBookDefaultMode, setBookDefaultTone } = require("./books");
const {
  readSettings,
  normalizeFollowMode,
  normalizeFollowTone,
  FOLLOW_TONES,
  tokensFromBudgetRmb,
} = require("./settings");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_PATH)) {
    fs.writeFileSync(
      SESSIONS_PATH,
      JSON.stringify({ sessions: [], open: null }, null, 2),
      "utf8"
    );
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
    return {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      open: raw.open && typeof raw.open === "object" ? raw.open : null,
    };
  } catch {
    return { sessions: [], open: null };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(
    SESSIONS_PATH,
    JSON.stringify(
      { sessions: data.sessions || [], open: data.open || null },
      null,
      2
    ),
    "utf8"
  );
}

function listSessions() {
  const { sessions } = readAll();
  return { sessions };
}

const IDLE_CHUNK_DEFAULT = 420;
const IDLE_LOG_MAX = 24;

function normalizeOpenIdle(open) {
  if (!open || typeof open !== "object") return open;
  if (!Number.isFinite(Number(open.idle_offset)) || Number(open.idle_offset) < 0) {
    open.idle_offset = 0;
  } else {
    open.idle_offset = Math.floor(Number(open.idle_offset));
  }
  if (!Array.isArray(open.idle_log)) open.idle_log = [];
  return open;
}

function getOpenSession() {
  const open = readAll().open;
  return open ? normalizeOpenIdle(open) : null;
}

/**
 * 从正文 offset 切下一段空闲自读（尽量在句号/段末断开）。
 * 纯函数，供自检与 idleReadAdvance 共用。
 */
function pickIdleChunk(textIn, offsetIn, chunkChars) {
  const text = String(textIn || "");
  let offset = Math.max(0, Math.floor(Number(offsetIn) || 0));
  if (offset >= text.length) {
    return { excerpt: "", from: offset, to: offset, done: true };
  }
  while (offset < text.length && /\s/.test(text[offset])) offset++;
  if (offset >= text.length) {
    return { excerpt: "", from: offset, to: offset, done: true };
  }
  const n = Math.max(80, Math.min(2000, Math.floor(Number(chunkChars) || IDLE_CHUNK_DEFAULT)));
  let end = Math.min(text.length, offset + n);
  const slice = text.slice(offset, end);
  const breaks = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("；"),
  ];
  const breakAt = Math.max.apply(null, breaks);
  if (breakAt >= 40) end = offset + breakAt + 1;
  const excerpt = text.slice(offset, end).trim();
  return {
    excerpt,
    from: offset,
    to: end,
    done: end >= text.length || !excerpt,
  };
}

/**
 * 本场空闲自读推进一段（有正文；关门锁拒）。不调 LLM，只记日志。
 */
function idleReadAdvance({ chunkChars } = {}) {
  const { assertDoorOpen } = require("./settings");
  assertDoorOpen();
  const all = readAll();
  if (!all.open) {
    const err = new Error("没有进行中的场次");
    err.code = "no_open_session";
    throw err;
  }
  normalizeOpenIdle(all.open);
  const { getBookBody } = require("./bodies");
  let body;
  try {
    body = getBookBody(all.open.book_id);
  } catch (e) {
    if (e && e.code === "no_body") {
      const err = new Error("这本书还没有本地正文，无法空闲自读");
      err.code = "no_body";
      throw err;
    }
    throw e;
  }
  const text = String(body.text || "");
  if (!text.trim()) {
    const err = new Error("正文是空的");
    err.code = "no_body";
    throw err;
  }
  const picked = pickIdleChunk(text, all.open.idle_offset, chunkChars);
  if (!picked.excerpt) {
    all.open.idle_offset = text.length;
    writeAll(all);
    return {
      ok: true,
      done: true,
      excerpt: null,
      idle_offset: all.open.idle_offset,
      idle_log: all.open.idle_log,
      message: "正文已读到末尾",
    };
  }
  const entry = {
    at: Date.now(),
    from: picked.from,
    to: picked.to,
    excerpt: picked.excerpt.slice(0, 800),
  };
  const log = all.open.idle_log.slice();
  log.push(entry);
  while (log.length > IDLE_LOG_MAX) log.shift();
  all.open.idle_offset = picked.to;
  all.open.idle_log = log;
  writeAll(all);
  return {
    ok: true,
    done: !!picked.done,
    excerpt: entry.excerpt,
    idle_offset: all.open.idle_offset,
    idle_log: all.open.idle_log,
    chars: entry.excerpt.length,
  };
}

function getSession(id) {
  return readAll().sessions.find((s) => s.id === id) || null;
}

function resolveBook(bookKey) {
  if (bookKey) {
    const book = findBook(bookKey);
    if (!book) {
      const err = new Error("找不到这本书");
      err.code = "book_not_found";
      throw err;
    }
    return book;
  }
  const active = readBooks().books.find((b) => b.in_progress);
  if (!active) {
    const err = new Error("请指定 book_id，或先在书架选一本进行中的书");
    err.code = "book_required";
    throw err;
  }
  return active;
}

function sessionLinks(book) {
  const port = Number(process.env.PORT) || 8787;
  const links = {
    pwa_url: `http://127.0.0.1:${port}/`,
    pwa_hint: "打开 PWA → 继续 / 书架进入共读中",
  };
  if (book.weread_id) {
    links.weread_web = `https://weread.qq.com/web/reader/${book.weread_id}`;
  }
  return links;
}

/**
 * 开场：写入 open；同书未结束则恢复；异书未结束则报错（须先结束）。
 */
function startSession(bookKey) {
  const book = resolveBook(bookKey);
  const all = readAll();
  if (all.open) {
    if (all.open.book_id === book.id) {
      const bookReady = ensureActivePass(book.id);
      let open = all.open;
      let dirty = false;
      if (!Array.isArray(open.chats)) {
        open.chats = [];
        dirty = true;
      }
      const prevPass = Math.max(1, Number(open.pass_ordinal) || 1);
      // 旧短聊无刷次：先归到切换前的本场刷次，再允许切刷
      for (const m of open.chats) {
        if (m && m.pass_ordinal == null) {
          m.pass_ordinal = prevPass;
          dirty = true;
        }
      }
      const wantPass = Math.max(1, Number(bookReady.active_pass) || 1);
      if (Number(open.pass_ordinal) !== wantPass) {
        open.pass_ordinal = wantPass;
        dirty = true;
      }
      if (!open.pass_ordinal) {
        open.pass_ordinal = wantPass;
        dirty = true;
      }
      if (open.weread_read_seconds_at_start == null) {
        open.weread_read_seconds_at_start = Number(bookReady.weread_read_seconds) || 0;
        dirty = true;
      }
      // 进程被杀/后台回来：丢掉未结算墙钟段；计时须用户点「开始/继续」才 resume
      if (open.active_ms == null) {
        open.active_ms = 0;
        dirty = true;
      }
      normalizeOpenIdle(open);
      if (open.active_since) {
        open.active_since = null;
        dirty = true;
      }
      if (dirty) {
        all.open = open;
        writeAll(all);
      }
      setInProgress(book.id);
      return {
        open: all.open,
        resumed: true,
        links: sessionLinks(bookReady),
      };
    }
    const err = new Error(
      `已有未结束场次《${all.open.book_title || all.open.book_id}》，请先 end_coread`
    );
    err.code = "session_open";
    err.open = all.open;
    throw err;
  }

  const defaults = readSettings();
  const bookReady = ensureActivePass(book.id);
  const open = {
    id: "o_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    book_id: book.id,
    book_title: book.title || "未命名",
    pass_ordinal: Number(bookReady.active_pass) || 1,
    started_at: Date.now(),
    active_ms: 0,
    active_since: null,
    follow_paused: false,
    lore_light: false,
    follow_tone: Object.prototype.hasOwnProperty.call(bookReady, "default_tone")
      ? normalizeFollowTone(bookReady.default_tone)
      : normalizeFollowTone(defaults.default_follow_tone),
    follow_mode: bookReady.default_mode
      ? normalizeFollowMode(bookReady.default_mode)
      : normalizeFollowMode(defaults.default_follow_mode),
    budget_tokens: tokensFromBudgetRmb(defaults.default_budget_rmb),
    tokens_used: 0,
    chats: [],
    weread_read_seconds_at_start: Number(bookReady.weread_read_seconds) || 0,
    idle_offset: 0,
    idle_log: [],
  };
  all.open = open;
  writeAll(all);
  setInProgress(book.id);
  return { open, resumed: false, links: sessionLinks(bookReady) };
}

const FOLLOW_MODES = ["immersive", "ideas", "silent"];

/** 粗算：一条跟批大约 1000 token（含深思），只用于「大约几条」展示 */
const TOKENS_PER_FOLLOW_EST = 1000;

function budgetExhausted(open) {
  if (!open) return false;
  const cap = Number(open.budget_tokens) || 0;
  if (cap <= 0) return false;
  return (Number(open.tokens_used) || 0) >= cap;
}

function addOpenTokensUsed(n) {
  const all = readAll();
  if (!all.open) return null;
  const add = Math.max(0, Number(n) || 0);
  all.open.tokens_used = (Number(all.open.tokens_used) || 0) + add;
  writeAll(all);
  return all.open;
}

function listOpenChats() {
  const open = getOpenSession();
  if (!open) return [];
  return Array.isArray(open.chats) ? open.chats.slice() : [];
}

function appendOpenChats(msgs) {
  const all = readAll();
  if (!all.open) {
    const err = new Error("没有进行中的场次");
    err.code = "no_open_session";
    throw err;
  }
  if (!Array.isArray(all.open.chats)) all.open.chats = [];
  const pass = Math.max(1, Number(all.open.pass_ordinal) || 1);
  for (const m of msgs || []) {
    if (m && m.body) {
      if (m.pass_ordinal == null) m.pass_ordinal = pass;
      all.open.chats.push(m);
    }
  }
  writeAll(all);
  return all.open.chats.slice();
}

/** 更新当前 open 场次字段 */
function patchOpenSession(patch) {
  const all = readAll();
  if (!all.open) {
    const err = new Error("没有进行中的场次");
    err.code = "no_open_session";
    throw err;
  }
  if (typeof patch.follow_paused === "boolean") {
    all.open.follow_paused = patch.follow_paused;
  }
  if (typeof patch.lore_light === "boolean") {
    all.open.lore_light = patch.lore_light;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "follow_tone")) {
    all.open.follow_tone = normalizeFollowTone(patch.follow_tone);
    try {
      setBookDefaultTone(all.open.book_id, all.open.follow_tone);
    } catch (_) {
      /* 书丢了也不阻断改本场 */
    }
  }
  if (typeof patch.follow_mode === "string") {
    const m = patch.follow_mode.trim();
    if (!FOLLOW_MODES.includes(m)) {
      const err = new Error("未知跟批模式：" + m);
      err.code = "bad_follow_mode";
      throw err;
    }
    all.open.follow_mode = m;
    try {
      setBookDefaultMode(all.open.book_id, m);
    } catch (_) {
      /* 书丢了也不阻断改本场 */
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "budget_tokens")) {
    const n = Number(patch.budget_tokens);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error("预算须为 ≥0 的数字（0=不限）");
      err.code = "bad_budget";
      throw err;
    }
    all.open.budget_tokens = Math.floor(n);
  }
  if (patch.timing === "pause") {
    const since = Number(all.open.active_since) || 0;
    if (since > 0) {
      all.open.active_ms = (Number(all.open.active_ms) || 0) + Math.max(0, Date.now() - since);
      all.open.active_since = null;
    }
  } else if (patch.timing === "resume") {
    if (!all.open.active_since) {
      all.open.active_since = Date.now();
    }
    if (all.open.active_ms == null) all.open.active_ms = 0;
  }
  if (patch.dialogue && typeof patch.dialogue === "object") {
    const { normalizeAvatar, DEFAULTS } = require("./settings");
    const cur =
      all.open.dialogue && typeof all.open.dialogue === "object"
        ? { ...all.open.dialogue }
        : {};
    for (const k of ["persona", "name_user", "name_bot", "avatar_user", "avatar_bot"]) {
      if (!Object.prototype.hasOwnProperty.call(patch.dialogue, k)) continue;
      const v = patch.dialogue[k];
      if (v == null || String(v).trim() === "") {
        delete cur[k];
        continue;
      }
      if (k === "avatar_user" || k === "avatar_bot") {
        cur[k] = normalizeAvatar(v, DEFAULTS[k]);
      } else {
        cur[k] = String(v).trim();
      }
    }
    all.open.dialogue = cur;
  }
  writeAll(all);
  return all.open;
}

/** 本场有效共读时长（不含退后台）；旧场次无 active_ms 时退回墙钟 */
function openActiveDurationMs(open, now = Date.now()) {
  if (!open) return 0;
  if (open.active_ms != null || open.active_since != null) {
    let ms = Number(open.active_ms) || 0;
    const since = Number(open.active_since) || 0;
    if (since > 0) ms += Math.max(0, now - since);
    return Math.max(0, ms);
  }
  const start = Number(open.started_at) || now;
  return Math.max(0, now - start);
}

/** 本场：划线 created_at / 跟批 follow.at 落在 [startedAt, endedAt] */
function toMs(t) {
  const n = Number(t) || 0;
  if (n <= 0) return 0;
  // WeRead createTime 多为秒；跟批/场次为毫秒
  return n < 1e12 ? n * 1000 : n;
}

function buildSummary(bookKey, startedAt, endedAt = Date.now()) {
  const book = resolveBook(bookKey);
  const start = Number(startedAt) || endedAt;
  const end = Number(endedAt) || Date.now();
  const inRange = (t) => {
    const n = toMs(t);
    return n >= start && n <= end;
  };

  const highlights = getHighlights(book.id).highlights || [];
  const hlNew = highlights.filter((h) => h.kind !== "idea" && inRange(h.created_at));
  const followed = highlights.filter((h) => h.follow && inRange(h.follow.at));
  let tokens_in = 0;
  let tokens_out = 0;
  for (const h of followed) {
    tokens_in += Number(h.follow.tokens_in) || 0;
    tokens_out += Number(h.follow.tokens_out) || 0;
  }
  const open = getOpenSession();
  const chats =
    open && open.book_id === book.id && Array.isArray(open.chats) ? open.chats : [];
  const chatInRange = chats.filter((c) => inRange(c.at));
  for (const c of chatInRange) {
    tokens_in += Number(c.tokens_in) || 0;
    tokens_out += Number(c.tokens_out) || 0;
  }

  return {
    book_id: book.id,
    book_title: book.title || "未命名",
    started_at: start,
    ended_at: end,
    duration_ms: Math.max(0, end - start),
    highlight_count: hlNew.length,
    follow_count: followed.length,
    chat_count: chatInRange.filter((c) => c.role === "user").length,
    chats: chatInRange,
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
  };
}

function endSession(bookKey, startedAt) {
  const all = readAll();
  const open = all.open;
  const key = bookKey || (open && open.book_id);
  if (!key) {
    const err = new Error("没有进行中的场次");
    err.code = "no_open_session";
    throw err;
  }
  const book = findBook(key);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  let startFinal = Number(startedAt) || 0;
  if (!startFinal && open && open.book_id === book.id) {
    startFinal = open.started_at;
  }
  if (!startFinal) startFinal = Date.now();

  const summary = buildSummary(book.id, startFinal);
  const passOrdinal =
    (open && open.book_id === book.id && Number(open.pass_ordinal)) ||
    Number(book.active_pass) ||
    1;
  const wrStart =
    open && open.book_id === book.id
      ? Number(open.weread_read_seconds_at_start) || 0
      : 0;
  const wrEnd = Number(book.weread_read_seconds) || 0;
  const wereadDelta = Math.max(0, wrEnd - wrStart);

  // 结束前先结算当前前台段
  if (open && open.book_id === book.id) {
    const since = Number(open.active_since) || 0;
    if (since > 0) {
      open.active_ms = (Number(open.active_ms) || 0) + Math.max(0, Date.now() - since);
      open.active_since = null;
    }
  }
  const durationMs =
    open && open.book_id === book.id && (open.active_ms != null || open.active_since != null)
      ? Math.max(0, Number(open.active_ms) || 0)
      : summary.duration_ms;

  const session = {
    id: "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    ...summary,
    duration_ms: durationMs,
    pass_ordinal: passOrdinal,
    weread_read_seconds: wereadDelta,
  };
  all.sessions.unshift(session);
  if (open && open.book_id === book.id) {
    if (open.follow_mode) {
      try {
        setBookDefaultMode(book.id, open.follow_mode);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      setBookDefaultTone(book.id, open.follow_tone);
    } catch (_) {
      /* ignore */
    }
    all.open = null;
  }
  writeAll(all);
  return session;
}

function formatDurationMs(ms) {
  const m = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (m < 60) return m + " 分钟";
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + " 小时" + (rm ? " " + rm + " 分" : "");
}

function formatWhenLocal(ts) {
  const d = new Date(ts || 0);
  if (!ts || Number.isNaN(d.getTime())) return "—";
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function passLabelExport(n) {
  const labels = ["", "一刷", "二刷", "三刷", "四刷", "五刷"];
  const x = Number(n) || 0;
  return labels[x] || x + "刷";
}

function safeFilenamePart(s) {
  return (
    String(s || "未命名")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "未命名"
  );
}

/** 本场时间窗内的划线/跟批（只读拼装，供导出） */
function sessionMarksInRange(session) {
  const start = Number(session.started_at) || 0;
  const end = Number(session.ended_at) || Date.now();
  const inRange = (t) => {
    const n = toMs(t);
    return n >= start && n <= end;
  };
  const highlights = getHighlights(session.book_id).highlights || [];
  return highlights.filter(
    (h) => inRange(h.created_at) || (h.follow && inRange(h.follow.at))
  );
}

const CTX_DEFAULT = 10;
const CTX_MAX = 24;
const CTX_CLIP = 160;

function clipCtx(s, n) {
  const t = String(s || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * 剧情号接戏用：未结束场次优先，否则最近一场已结束。
 * 返回时间序最近 N 条划线/想法/跟批/短聊（截断）。
 */
function getRecentCoreadContext(limit) {
  const n = Math.min(
    CTX_MAX,
    Math.max(1, Math.floor(Number(limit) || CTX_DEFAULT) || CTX_DEFAULT)
  );
  const open = getOpenSession();
  let scope;
  if (open) {
    scope = {
      open: true,
      session_id: null,
      book_id: open.book_id,
      book_title: open.book_title || "未命名",
      pass_ordinal: Number(open.pass_ordinal) || null,
      started_at: open.started_at,
      ended_at: null,
      follow_mode: open.follow_mode || null,
      chats: Array.isArray(open.chats) ? open.chats : [],
    };
  } else {
    const last = listSessions().sessions[0];
    if (!last) {
      return {
        open: false,
        session: null,
        book: null,
        entries: [],
        count: 0,
        returned: 0,
        truncated: false,
        message: "还没有共读场次；请先 start_coread",
      };
    }
    scope = {
      open: false,
      session_id: last.id,
      book_id: last.book_id,
      book_title: last.book_title || "未命名",
      pass_ordinal: Number(last.pass_ordinal) || null,
      started_at: last.started_at,
      ended_at: last.ended_at,
      follow_mode: null,
      chats: Array.isArray(last.chats) ? last.chats : [],
    };
  }

  const marks = sessionMarksInRange({
    book_id: scope.book_id,
    started_at: scope.started_at,
    ended_at: scope.ended_at || Date.now(),
  });
  const events = [];
  for (const h of marks) {
    const at =
      toMs(h.created_at) || (h.follow && toMs(h.follow.at)) || 0;
    let kind = "highlight";
    if (h.kind === "idea") kind = "idea";
    else if (h.follow && h.follow.body) kind = "follow";
    events.push({
      at,
      kind,
      text: clipCtx(h.text, CTX_CLIP),
      idea: clipCtx(h.idea, CTX_CLIP) || null,
      follow_body: clipCtx(h.follow && h.follow.body, CTX_CLIP) || null,
      chapter_title: h.chapter_title || null,
    });
  }
  for (const c of scope.chats) {
    events.push({
      at: Number(c.at) || 0,
      kind: c.role === "user" ? "chat_user" : "chat_assistant",
      text: clipCtx(c.body, CTX_CLIP),
      idea: null,
      follow_body: null,
      chapter_title: null,
    });
  }
  events.sort((a, b) => a.at - b.at || 0);
  const sliced = events.slice(-n);
  const book = findBook(scope.book_id);
  return {
    open: scope.open,
    session: {
      id: scope.session_id,
      pass_ordinal: scope.pass_ordinal,
      started_at: scope.started_at,
      ended_at: scope.ended_at,
      follow_mode: scope.follow_mode,
      highlight_count: marks.filter((h) => h.kind !== "idea").length,
      follow_count: marks.filter((h) => h.follow && h.follow.body).length,
      chat_count: scope.chats.filter((c) => c.role === "user").length,
    },
    book: {
      id: scope.book_id,
      title: (book && book.title) || scope.book_title,
      author: (book && book.author) || null,
      cabin_progress: book ? book.progress ?? 0 : null,
      weread_progress: book ? book.weread_progress ?? null : null,
    },
    count: events.length,
    returned: sliced.length,
    truncated: events.length > sliced.length,
    entries: sliced,
    message: sliced.length
      ? undefined
      : scope.open
        ? "本场还没有划线/跟批/短聊"
        : "上场没有可摘的划线/跟批/短聊",
  };
}

function buildSessionExportPayload(session) {
  const marks = sessionMarksInRange(session);
  const chats = Array.isArray(session.chats) ? session.chats : [];
  return {
    id: session.id,
    book_id: session.book_id,
    book_title: session.book_title || "未命名",
    pass_ordinal: session.pass_ordinal || null,
    started_at: session.started_at,
    ended_at: session.ended_at,
    duration_ms: session.duration_ms,
    weread_read_seconds: Number(session.weread_read_seconds) || 0,
    highlight_count: Number(session.highlight_count) || 0,
    follow_count: Number(session.follow_count) || 0,
    chat_count: Number(session.chat_count) || 0,
    tokens_in: Number(session.tokens_in) || 0,
    tokens_out: Number(session.tokens_out) || 0,
    tokens_total: Number(session.tokens_total) || 0,
    chats: chats.map((c) => ({
      id: c.id,
      role: c.role,
      body: c.body || "",
      at: c.at,
      reply_label: c.reply_label || null,
      tokens_in: c.tokens_in || 0,
      tokens_out: c.tokens_out || 0,
    })),
    highlights: marks.map((h) => ({
      id: h.id,
      kind: h.kind,
      text: h.text || "",
      idea: h.idea || "",
      chapter_title: h.chapter_title || null,
      created_at: h.created_at,
      follow:
        h.follow && h.follow.body
          ? {
              body: h.follow.body,
              at: h.follow.at,
              tokens_in: h.follow.tokens_in || 0,
              tokens_out: h.follow.tokens_out || 0,
            }
          : null,
    })),
  };
}

function sessionToMarkdown(payload) {
  const pass = payload.pass_ordinal ? passLabelExport(payload.pass_ordinal) : "";
  const lines = [
    `# 《${payload.book_title}》${pass ? " · " + pass : ""} · 共读记录`,
    "",
    `- 场次：${payload.id}`,
    `- 开始：${formatWhenLocal(payload.started_at)}`,
    `- 结束：${formatWhenLocal(payload.ended_at)}`,
    `- 共读时长：${formatDurationMs(payload.duration_ms)}`,
  ];
  if (payload.weread_read_seconds > 0) {
    lines.push(
      `- 微信阅读增量：${Math.max(1, Math.round(payload.weread_read_seconds / 60))} 分钟`
    );
  }
  lines.push(
    `- 划线 ${payload.highlight_count} · 跟批 ${payload.follow_count} · 短聊 ${payload.chat_count}`
  );
  lines.push(
    `- Token：${payload.tokens_total}（${payload.tokens_in} in / ${payload.tokens_out} out）`
  );
  lines.push("");

  if (payload.chats.length) {
    lines.push("## 短聊", "");
    for (const c of payload.chats) {
      const who = c.role === "user" ? "你" : "陪伴";
      lines.push(`**${who}**（${formatWhenLocal(c.at)}）`);
      if (c.reply_label) lines.push(`> 续：${c.reply_label}`);
      lines.push(String(c.body || "").trim(), "");
    }
  }

  lines.push("## 划线与跟批", "");
  if (!payload.highlights.length) {
    lines.push("（本场无划线/跟批）", "");
  } else {
    for (const h of payload.highlights) {
      if (h.chapter_title) lines.push(`### ${h.chapter_title}`);
      if (h.text) lines.push(`> ${String(h.text).replace(/\n/g, "\n> ")}`);
      if (h.idea) lines.push(`想法：${h.idea}`);
      if (h.follow && h.follow.body) {
        lines.push("", `跟批：${h.follow.body}`);
      }
      lines.push("");
    }
  }

  lines.push("---", "由共读小屋导出；不含 API Key。");
  return lines.join("\n");
}

function escapeHtmlSession(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Word / WPS 可开的 .doc（HTML Word 文档） */
function sessionToWordDoc(payload) {
  const pass = payload.pass_ordinal ? passLabelExport(payload.pass_ordinal) : "";
  const parts = [
    "<h1>《" +
      escapeHtmlSession(payload.book_title) +
      "》" +
      (pass ? " · " + escapeHtmlSession(pass) : "") +
      " · 共读记录</h1>",
    "<p>场次：" +
      escapeHtmlSession(payload.id) +
      "<br/>开始：" +
      escapeHtmlSession(formatWhenLocal(payload.started_at)) +
      "<br/>结束：" +
      escapeHtmlSession(formatWhenLocal(payload.ended_at)) +
      "<br/>共读时长：" +
      escapeHtmlSession(formatDurationMs(payload.duration_ms)) +
      "<br/>划线 " +
      payload.highlight_count +
      " · 跟批 " +
      payload.follow_count +
      " · 短聊 " +
      payload.chat_count +
      "</p>",
    "<hr/>",
  ];
  if (payload.chats.length) {
    parts.push("<h2>短聊</h2>");
    for (const c of payload.chats) {
      const who = c.role === "user" ? "你" : "陪伴";
      parts.push(
        "<p><b>" +
          who +
          "</b>（" +
          escapeHtmlSession(formatWhenLocal(c.at)) +
          "）<br/>" +
          escapeHtmlSession(c.body || "").replace(/\n/g, "<br/>") +
          "</p>"
      );
    }
  }
  parts.push("<h2>划线与跟批</h2>");
  if (!payload.highlights.length) {
    parts.push("<p>（本场无划线/跟批）</p>");
  } else {
    for (const h of payload.highlights) {
      if (h.chapter_title) parts.push("<h3>" + escapeHtmlSession(h.chapter_title) + "</h3>");
      if (h.text) {
        parts.push(
          "<blockquote>" + escapeHtmlSession(h.text).replace(/\n/g, "<br/>") + "</blockquote>"
        );
      }
      if (h.idea) {
        parts.push("<p><b>想法：</b>" + escapeHtmlSession(h.idea).replace(/\n/g, "<br/>") + "</p>");
      }
      if (h.follow && h.follow.body) {
        parts.push(
          "<p><b>跟批：</b>" + escapeHtmlSession(h.follow.body).replace(/\n/g, "<br/>") + "</p>"
        );
      }
    }
  }
  parts.push("<p><small>由共读小屋导出；不含 API Key。</small></p>");
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
    "<head><meta charset=\"utf-8\"><title>" +
    escapeHtmlSession(payload.book_title) +
    "</title>" +
    "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->" +
    "</head><body>" +
    parts.join("\n") +
    "</body></html>"
  );
}

function contentDispositionAttachment(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_") || "export";
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 导出一场记录。format: md | json | doc
 * @returns {{ filename, contentType, body, contentDisposition }}
 */
function exportSession(id, format = "md") {
  const session = getSession(id);
  if (!session) {
    const err = new Error("找不到这场记录");
    err.code = "not_found";
    throw err;
  }
  const payload = buildSessionExportPayload(session);
  const stamp = formatWhenLocal(session.ended_at || session.started_at)
    .replace(/[: ]/g, "-")
    .slice(0, 16);
  const base = `共读-${safeFilenamePart(session.book_title)}-${stamp}`;
  const fmt = String(format || "md").toLowerCase();
  if (fmt === "json") {
    const filename = base + ".json";
    return {
      filename,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(payload, null, 2),
      contentDisposition: contentDispositionAttachment(filename),
    };
  }
  if (fmt === "doc" || fmt === "word") {
    const filename = base + ".doc";
    return {
      filename,
      contentType: "application/msword; charset=utf-8",
      body: sessionToWordDoc(payload),
      contentDisposition: contentDispositionAttachment(filename),
    };
  }
  const filename = base + ".md";
  return {
    filename,
    contentType: "text/markdown; charset=utf-8",
    body: sessionToMarkdown(payload),
    contentDisposition: contentDispositionAttachment(filename),
  };
}

function sessionsInPeriod(period, now = Date.now()) {
  const { sessions } = readAll();
  const p = String(period || "all").toLowerCase();
  let since = 0;
  if (p === "today") since = startOfLocalDay(now);
  else if (p === "week") since = startOfLocalWeek(now);
  else if (p === "month") since = startOfLocalMonth(now);
  else return sessions.slice();
  return sessions.filter((s) => {
    const t = Number(s.ended_at) || Number(s.started_at) || 0;
    return t >= since;
  });
}

/**
 * 按时间段批量导出场次 zip。format: md | doc；period: all|today|week|month
 */
function exportSessionsPeriod(period = "all", format = "md") {
  const { zipStore } = require("./backup");
  const fmt = String(format || "md").toLowerCase();
  const useDoc = fmt === "doc" || fmt === "word";
  const list = sessionsInPeriod(period);
  if (!list.length) {
    const err = new Error("这段时间还没有场次可导出");
    err.code = "no_sessions";
    throw err;
  }
  const used = new Set();
  const entries = [];
  for (const s of list) {
    const file = exportSession(s.id, useDoc ? "doc" : "md");
    let name = file.filename;
    if (used.has(name)) {
      const i = name.lastIndexOf(".");
      name = (i > 0 ? name.slice(0, i) : name) + "-" + String(s.id).slice(-6) + (i > 0 ? name.slice(i) : "");
    }
    used.add(name);
    entries.push({ name, data: file.body });
  }
  const labels = { all: "全部", today: "今日", week: "本周", month: "本月" };
  const stamp = new Date();
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const tag =
    stamp.getFullYear() +
    pad(stamp.getMonth() + 1) +
    pad(stamp.getDate()) +
    "-" +
    pad(stamp.getHours()) +
    pad(stamp.getMinutes());
  const filename =
    "共读记录-" +
    (labels[String(period || "all").toLowerCase()] || "全部") +
    "-" +
    (useDoc ? "doc" : "md") +
    "-" +
    tag +
    ".zip";
  const body = zipStore(entries);
  return {
    filename,
    contentType: "application/zip",
    body,
    contentDisposition: contentDispositionAttachment(filename),
  };
}

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周从周一起算（本地时区） */
function startOfLocalWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function startOfLocalMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyBucket() {
  return {
    sessions: 0,
    duration_ms: 0,
    highlight_count: 0,
    follow_count: 0,
    tokens_total: 0,
    weread_read_seconds: 0,
  };
}

function accumulateSession(bucket, s) {
  bucket.sessions += 1;
  bucket.duration_ms += Number(s.duration_ms) || 0;
  bucket.highlight_count += Number(s.highlight_count) || 0;
  bucket.follow_count += Number(s.follow_count) || 0;
  bucket.tokens_total += Number(s.tokens_total) || 0;
  bucket.weread_read_seconds += Number(s.weread_read_seconds) || 0;
  return bucket;
}

/**
 * 已结束场次按本地日/周/月汇总（以 ended_at 归桶；缺省用 started_at）。
 */
function sessionStats(now = Date.now()) {
  const { sessions } = readAll();
  const day0 = startOfLocalDay(now);
  const week0 = startOfLocalWeek(now);
  const month0 = startOfLocalMonth(now);
  const all = emptyBucket();
  const today = emptyBucket();
  const week = emptyBucket();
  const month = emptyBucket();

  for (const s of sessions) {
    if (!s) continue;
    const t = Number(s.ended_at) || Number(s.started_at) || 0;
    accumulateSession(all, s);
    if (t >= day0) accumulateSession(today, s);
    if (t >= week0) accumulateSession(week, s);
    if (t >= month0) accumulateSession(month, s);
  }

  return {
    as_of: now,
    all,
    today,
    week,
    month,
  };
}

if (require.main === module) {
  console.assert(formatDurationMs(90 * 1000) === "2 分钟");
  console.assert(formatDurationMs(125 * 60000) === "2 小时 5 分");
  console.assert(formatDurationMs(0) === "0 分钟");
  console.assert(toMs(1788793033) === 1788793033000);
  console.assert(toMs(1790419709459) === 1790419709459);
  const fakeNow = new Date(2026, 8, 26, 15, 0, 0).getTime(); // local Sep 26
  console.assert(startOfLocalDay(fakeNow) < fakeNow);
  console.assert(startOfLocalWeek(fakeNow) <= startOfLocalDay(fakeNow));
  console.assert(startOfLocalMonth(fakeNow) <= startOfLocalDay(fakeNow));
  const open = getOpenSession();
  if (!open) {
    try {
      patchOpenSession({ follow_paused: true });
      throw new Error("expected no_open_session");
    } catch (e) {
      if (e.code !== "no_open_session") throw e;
    }
  } else {
    const prev = open.follow_mode || "immersive";
    const patched = patchOpenSession({ follow_mode: "ideas" });
    console.assert(patched.follow_mode === "ideas");
    patchOpenSession({ follow_mode: prev });
    console.assert(normalizeFollowTone("short") === "short");
    console.assert(normalizeFollowTone("default") === "");
    console.assert(normalizeFollowTone("nope") === "");
    const tonePatched = patchOpenSession({ follow_tone: "ask" });
    console.assert(tonePatched.follow_tone === "ask");
    patchOpenSession({ follow_tone: "" });
    console.assert(!budgetExhausted({ budget_tokens: 0, tokens_used: 9999 }));
    console.assert(budgetExhausted({ budget_tokens: 100, tokens_used: 100 }));
    console.assert(!budgetExhausted({ budget_tokens: 100, tokens_used: 99 }));
  }
  const st = sessionStats(Date.now());
  console.assert(st.all && typeof st.all.sessions === "number");
  console.assert(st.today && st.week && st.month);
  console.assert(openActiveDurationMs({ started_at: Date.now() - 5000, active_ms: 1000, active_since: null }) === 1000);
  console.assert(openActiveDurationMs({ active_ms: 0, active_since: Date.now() - 2000 }) >= 1900);
  {
    const ctx = getRecentCoreadContext(3);
    console.assert(ctx && Array.isArray(ctx.entries) && typeof ctx.open === "boolean");
    console.assert(ctx.returned <= 3);
  }
  const idleSample =
    "第一段。\n\n" +
    "第二段比较长，用来测试空闲自读切片是否在句号处断开。".repeat(8) +
    "还有下文收尾。";
  const chunk1 = pickIdleChunk(idleSample, 0, 100);
  console.assert(chunk1.excerpt.includes("第一段"), chunk1);
  console.assert(chunk1.to > 0 && chunk1.to < idleSample.length && !chunk1.done, chunk1);
  const chunkEnd = pickIdleChunk(idleSample, idleSample.length, 100);
  console.assert(chunkEnd.done && !chunkEnd.excerpt);
  const { sessions } = listSessions();
  if (sessions[0]) {
    const md = exportSession(sessions[0].id, "md");
    console.assert(md.body.includes("共读记录") && md.filename.endsWith(".md"));
    const js = exportSession(sessions[0].id, "json");
    console.assert(js.body.includes(sessions[0].id) && js.filename.endsWith(".json"));
    const doc = exportSession(sessions[0].id, "doc");
    console.assert(doc.filename.endsWith(".doc") && doc.body.includes("<html"));
    const zip = exportSessionsPeriod("all", "md");
    console.assert(Buffer.isBuffer(zip.body) && zip.body[0] === 0x50 && zip.filename.endsWith(".zip"));
  } else {
    try {
      exportSessionsPeriod("all", "md");
      throw new Error("expected no_sessions");
    } catch (e) {
      if (e.code !== "no_sessions") throw e;
    }
  }
  console.log("sessions ok");
}

module.exports = {
  listSessions,
  getSession,
  getOpenSession,
  startSession,
  idleReadAdvance,
  pickIdleChunk,
  IDLE_CHUNK_DEFAULT,
  IDLE_LOG_MAX,
  patchOpenSession,
  budgetExhausted,
  addOpenTokensUsed,
  listOpenChats,
  appendOpenChats,
  FOLLOW_TONES,
  normalizeFollowTone,
  TOKENS_PER_FOLLOW_EST,
  buildSummary,
  endSession,
  exportSession,
  exportSessionsPeriod,
  formatDurationMs,
  sessionStats,
  openActiveDurationMs,
  startOfLocalDay,
  startOfLocalWeek,
  startOfLocalMonth,
  sessionLinks,
  getRecentCoreadContext,
  SESSIONS_PATH,
};
