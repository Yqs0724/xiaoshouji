/**
 * 现实日历（D23）：只认本机本地日 YYYY-MM-DD。
 * 剧情/异时间线不进本库。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const CAL_PATH = path.join(DATA_DIR, "calendar.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CAL_PATH)) {
    fs.writeFileSync(CAL_PATH, JSON.stringify({ events: [] }, null, 2), "utf8");
  }
}

function normalizeDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error("日期须为 YYYY-MM-DD（现实本地日）");
    err.code = "bad_cal_date";
    throw err;
  }
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    const err = new Error("不是有效日期");
    err.code = "bad_cal_date";
    throw err;
  }
  return s;
}

function normalizeOwner(v) {
  const s = String(v || "").trim();
  if (s === "companion" || s === "both" || s === "you") return s;
  return "you";
}

/** 可选钟点 HH:MM；空=全日 */
function normalizeTime(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return "";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const title = String(raw.title || "").trim();
  if (!id || !title) return null;
  let date;
  try {
    date = normalizeDate(raw.date);
  } catch {
    return null;
  }
  const time = normalizeTime(raw.time);
  const out = {
    id: id.slice(0, 80),
    title: title.slice(0, 120),
    date,
    time,
    allDay: !time,
    owner: normalizeOwner(raw.owner),
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
  if (raw.source === "auto") out.source = "auto";
  return out;
}

function normalizeNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const body = String(raw.body || "").trim().slice(0, 500);
  if (!id || !body) return null;
  let date;
  try {
    date = normalizeDate(raw.date);
  } catch {
    return null;
  }
  const out = {
    id,
    date,
    body,
    owner: normalizeOwner(raw.owner),
    liked: !!raw.liked,
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
  /* H4：可挂关联行程（署名已有 owner） */
  const eventId = String(raw.event_id || "").trim().slice(0, 64);
  if (eventId) {
    out.event_id = eventId;
    const et = String(raw.event_title || "").trim().slice(0, 40);
    if (et) out.event_title = et;
  }
  return out;
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(CAL_PATH, "utf8"));
    const events = Array.isArray(raw.events)
      ? raw.events.map(normalizeEvent).filter(Boolean)
      : [];
    const notes = Array.isArray(raw.notes)
      ? raw.notes.map(normalizeNote).filter(Boolean)
      : [];
    notes.sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.updated_at - b.updated_at
    );
    const auto_dismissed = Array.isArray(raw.auto_dismissed)
      ? raw.auto_dismissed
          .map((x) => String(x || "").trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 500)
      : [];
    return {
      events,
      notes,
      tokens_used: Math.max(0, Math.floor(Number(raw.tokens_used) || 0)),
      auto_dismissed,
    };
  } catch {
    return { events: [], notes: [], tokens_used: 0, auto_dismissed: [] };
  }
}

function writeAll(data) {
  ensureFile();
  const prev = readAll();
  const events = (data.events || []).map(normalizeEvent).filter(Boolean);
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.created_at - b.created_at));
  const notes = Object.prototype.hasOwnProperty.call(data, "notes")
    ? (data.notes || []).map(normalizeNote).filter(Boolean)
    : prev.notes;
  notes.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.updated_at - b.updated_at
  );
  const tokens_used =
    data && Object.prototype.hasOwnProperty.call(data, "tokens_used")
      ? Math.max(0, Math.floor(Number(data.tokens_used) || 0))
      : prev.tokens_used;
  const auto_dismissed = Object.prototype.hasOwnProperty.call(
    data || {},
    "auto_dismissed"
  )
    ? (data.auto_dismissed || [])
        .map((x) => String(x || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 500)
    : prev.auto_dismissed || [];
  fs.writeFileSync(
    CAL_PATH,
    JSON.stringify({ events, notes, tokens_used, auto_dismissed }, null, 2),
    "utf8"
  );
  return { events, notes, tokens_used, auto_dismissed };
}

/** 按日列便签（可多条；你/家机各写各的） */
function listNotes({ date } = {}) {
  let notes = readAll().notes;
  if (date) {
    const d = normalizeDate(date);
    notes = notes.filter((n) => n.date === d);
  }
  return { ok: true, notes };
}

/** @deprecated 兼容旧调用：该日最新一条 */
function getNote(opts) {
  const notes = listNotes(opts).notes;
  return { ok: true, note: notes.length ? notes[notes.length - 1] : null };
}

function resolveEventTitle(eventId) {
  const eid = String(eventId || "").trim();
  if (!eid) return "";
  const hit = readAll().events.find((e) => e && e.id === eid);
  return hit && hit.title ? String(hit.title).trim().slice(0, 40) : "";
}

function createNote(patch) {
  const date = normalizeDate(patch && patch.date);
  const body = String(patch && patch.body != null ? patch.body : "").trim().slice(0, 500);
  if (!body) {
    const err = new Error("便签不能为空");
    err.code = "bad_cal_note";
    throw err;
  }
  const now = Date.now();
  const eventId = String((patch && patch.event_id) || "").trim().slice(0, 64);
  let eventTitle = String((patch && patch.event_title) || "").trim().slice(0, 40);
  if (eventId && !eventTitle) eventTitle = resolveEventTitle(eventId);
  const note = normalizeNote({
    id: randomUUID(),
    date,
    body,
    owner: normalizeOwner(patch && patch.owner),
    liked: false,
    event_id: eventId || undefined,
    event_title: eventTitle || undefined,
    created_at: now,
    updated_at: now,
  });
  const all = readAll();
  all.notes.push(note);
  writeAll(all);
  return { ok: true, note };
}

function updateNote(id, patch) {
  const nid = String(id || "").trim();
  const all = readAll();
  const i = all.notes.findIndex((n) => n.id === nid);
  if (i < 0) {
    const err = new Error("找不到该便签");
    err.code = "cal_not_found";
    throw err;
  }
  const cur = all.notes[i];
  if (
    patch &&
    Object.prototype.hasOwnProperty.call(patch, "body") &&
    !String(patch.body || "").trim()
  ) {
    all.notes.splice(i, 1);
    writeAll(all);
    return { ok: true, note: null, deleted: nid };
  }
  let eventId = cur.event_id || "";
  let eventTitle = cur.event_title || "";
  if (patch && Object.prototype.hasOwnProperty.call(patch, "event_id")) {
    eventId = String(patch.event_id || "").trim().slice(0, 64);
    eventTitle = eventId
      ? String(patch.event_title || "").trim().slice(0, 40) ||
        resolveEventTitle(eventId)
      : "";
  } else if (
    patch &&
    Object.prototype.hasOwnProperty.call(patch, "event_title") &&
    eventId
  ) {
    eventTitle = String(patch.event_title || "").trim().slice(0, 40);
  }
  const next = normalizeNote({
    ...cur,
    body:
      patch && Object.prototype.hasOwnProperty.call(patch, "body")
        ? String(patch.body || "").trim().slice(0, 500)
        : cur.body,
    date:
      patch && Object.prototype.hasOwnProperty.call(patch, "date")
        ? normalizeDate(patch.date)
        : cur.date,
    owner:
      patch && Object.prototype.hasOwnProperty.call(patch, "owner")
        ? normalizeOwner(patch.owner)
        : cur.owner,
    liked:
      patch && Object.prototype.hasOwnProperty.call(patch, "liked")
        ? !!patch.liked
        : cur.liked,
    event_id: eventId || undefined,
    event_title: eventTitle || undefined,
    updated_at: Date.now(),
  });
  all.notes[i] = next;
  writeAll(all);
  return { ok: true, note: next };
}

function deleteNote(id) {
  return updateNote(id, { body: "" });
}

/** 旧 upsert：有 id 则改，无 id 则新建；body 空且有 id 则删 */
function upsertNote(patch) {
  const id = patch && patch.id != null ? String(patch.id).trim() : "";
  if (id) return updateNote(id, patch);
  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) return { ok: true, note: null };
  return createNote(patch);
}

function addCalTokensUsed(n) {
  const add = Math.max(0, Number(n) || 0);
  if (!add) return readAll();
  const all = readAll();
  return writeAll({ ...all, tokens_used: all.tokens_used + add });
}

function listEvents({ date, from, to } = {}) {
  let events = readAll().events;
  if (date) {
    const d = normalizeDate(date);
    events = events.filter((e) => e.date === d);
  } else {
    if (from) {
      const f = normalizeDate(from);
      events = events.filter((e) => e.date >= f);
    }
    if (to) {
      const t = normalizeDate(to);
      events = events.filter((e) => e.date <= t);
    }
  }
  return { ok: true, events };
}

/** C6：用户改历后短暂 [NEW]（进程内；约 10 分钟） */
const NEW_TTL_MS = 10 * 60 * 1000;
/** @type {{ at: number, summary: string } | null} */
let lastCalChange = null;

function markCalendarChanged(summary) {
  const s = String(summary || "").trim().slice(0, 120);
  if (!s) return;
  lastCalChange = { at: Date.now(), summary: s };
}

/** @returns {string} 空或一行 [NEW] … */
function buildNewPrompt() {
  if (!lastCalChange) return "";
  if (Date.now() - lastCalChange.at > NEW_TTL_MS) {
    lastCalChange = null;
    return "";
  }
  return (
    "[NEW] 用户刚改过日历：" +
    lastCalChange.summary +
    "。请以最新为准，勿沿用旧行程。"
  );
}

function createEvent(patch) {
  const title = String(patch && patch.title != null ? patch.title : "").trim();
  if (!title) {
    const err = new Error("标题不能为空");
    err.code = "bad_cal_title";
    throw err;
  }
  const date = normalizeDate(patch && patch.date);
  const time = normalizeTime(patch && patch.time);
  const now = Date.now();
  const idRaw = String((patch && patch.id) || "").trim();
  const ev = normalizeEvent({
    id: idRaw || randomUUID(),
    title,
    date,
    time,
    owner: normalizeOwner(patch && patch.owner),
    source: patch && patch.source === "auto" ? "auto" : undefined,
    created_at: now,
    updated_at: now,
  });
  const all = readAll();
  if (all.events.some((e) => e.id === ev.id)) {
    const err = new Error("日程 id 已存在");
    err.code = "cal_id_exists";
    throw err;
  }
  all.events.push(ev);
  writeAll(all);
  markCalendarChanged(
    "新增「" +
      (title.length > 24 ? title.slice(0, 24) + "…" : title) +
      "」· " +
      date +
      (time ? " " + time : "")
  );
  return { ok: true, event: ev };
}

function updateEvent(id, patch) {
  const eid = String(id || "").trim();
  const all = readAll();
  const i = all.events.findIndex((e) => e.id === eid);
  if (i < 0) {
    const err = new Error("找不到该日程");
    err.code = "cal_not_found";
    throw err;
  }
  const cur = all.events[i];
  const next = {
    ...cur,
    title:
      patch && Object.prototype.hasOwnProperty.call(patch, "title")
        ? String(patch.title || "").trim()
        : cur.title,
    date:
      patch && Object.prototype.hasOwnProperty.call(patch, "date")
        ? normalizeDate(patch.date)
        : cur.date,
    time:
      patch && Object.prototype.hasOwnProperty.call(patch, "time")
        ? normalizeTime(patch.time)
        : cur.time || "",
    updated_at: Date.now(),
  };
  if (!next.title) {
    const err = new Error("标题不能为空");
    err.code = "bad_cal_title";
    throw err;
  }
  all.events[i] = normalizeEvent(next);
  writeAll(all);
  const saved = all.events.find((e) => e.id === eid);
  markCalendarChanged(
    "改了「" +
      String((saved && saved.title) || "").slice(0, 24) +
      "」· " +
      ((saved && saved.date) || "")
  );
  return { ok: true, event: saved };
}

function deleteEvent(id) {
  const eid = String(id || "").trim();
  const all = readAll();
  const doomed = all.events.find((e) => e.id === eid);
  const next = all.events.filter((e) => e.id !== eid);
  if (next.length === all.events.length) {
    const err = new Error("找不到该日程");
    err.code = "cal_not_found";
    throw err;
  }
  let auto_dismissed = all.auto_dismissed || [];
  if (doomed && doomed.source === "auto" && !auto_dismissed.includes(eid)) {
    auto_dismissed = auto_dismissed.concat(eid).slice(-500);
  }
  writeAll({ ...all, events: next, auto_dismissed });
  markCalendarChanged(
    "删了「" + String((doomed && doomed.title) || "").slice(0, 24) + "」"
  );
  return { ok: true, deleted: eid };
}

function localDateISO(d) {
  const x = d instanceof Date ? d : new Date();
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function addDaysISO(iso, n) {
  const parts = String(iso || "").split("-").map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  d.setDate(d.getDate() + n);
  return localDateISO(d);
}

/** C7：公历固定节日（不做农历换算） */
const FIXED_HOLIDAYS = [
  ["01-01", "元旦"],
  ["02-14", "情人节"],
  ["03-08", "妇女节"],
  ["05-01", "劳动节"],
  ["05-04", "青年节"],
  ["06-01", "儿童节"],
  ["10-01", "国庆节"],
  ["12-25", "圣诞节"],
];

function autoEventId(kind, date, title) {
  const t = String(title || "")
    .replace(/[^\w\u4e00-\u9fff]+/g, "")
    .slice(0, 20);
  return ("auto-" + kind + "-" + date + "-" + (t || "x")).slice(0, 72);
}

function readAnnivsSafe() {
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    const list = (readSettings().annivs || []).filter(
      (a) => a && a.date && a.title
    );
    return list;
  } catch (_) {
    return [];
  }
}

/** 生成 from～to 内的节日/纪念日候选（尚未写库） */
function listAutoCandidates(from, to) {
  const a = normalizeDate(from);
  const b = normalizeDate(to);
  const y0 = Number(a.slice(0, 4));
  const y1 = Number(b.slice(0, 4));
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (const [md, title] of FIXED_HOLIDAYS) {
      const date = y + "-" + md;
      if (date < a || date > b) continue;
      out.push({
        id: autoEventId("hol", date, title),
        title,
        date,
        owner: "both",
        source: "auto",
        kind: "holiday",
      });
    }
  }
  for (const ann of readAnnivsSafe()) {
    let md;
    try {
      md = normalizeDate(ann.date).slice(5);
    } catch (_) {
      continue;
    }
    const title = String(ann.title || "纪念日").trim().slice(0, 40) || "纪念日";
    for (let y = y0; y <= y1; y++) {
      const date = y + "-" + md;
      if (date < a || date > b) continue;
      out.push({
        id: autoEventId("ann", date, title),
        title: title,
        date,
        owner: "both",
        source: "auto",
        kind: "anniv",
      });
    }
  }
  return out;
}

/**
 * C7：把范围内缺失的节日/纪念日写入日历（幂等 id；删过的进 auto_dismissed 不再补）。
 */
function syncAutoEvents(patch) {
  const today = localDateISO(new Date());
  let from;
  let to;
  try {
    from = normalizeDate(
      (patch && patch.from) || today.slice(0, 4) + "-01-01"
    );
  } catch {
    from = today.slice(0, 4) + "-01-01";
  }
  try {
    to = normalizeDate(
      (patch && patch.to) || String(Number(today.slice(0, 4)) + 1) + "-12-31"
    );
  } catch {
    to = String(Number(today.slice(0, 4)) + 1) + "-12-31";
  }
  if (to < from) {
    const t = from;
    from = to;
    to = t;
  }
  const all = readAll();
  const dismissed = new Set(all.auto_dismissed || []);
  const haveId = new Set(all.events.map((e) => e.id));
  const haveKey = new Set(
    all.events.map((e) => e.date + "\0" + String(e.title || "").trim())
  );
  let added = 0;
  const now = Date.now();
  for (const c of listAutoCandidates(from, to)) {
    if (dismissed.has(c.id) || haveId.has(c.id)) continue;
    if (haveKey.has(c.date + "\0" + c.title)) continue;
    const ev = normalizeEvent({
      id: c.id,
      title: c.title,
      date: c.date,
      time: "",
      owner: c.owner,
      source: "auto",
      created_at: now,
      updated_at: now,
    });
    if (!ev) continue;
    all.events.push(ev);
    haveId.add(ev.id);
    haveKey.add(ev.date + "\0" + ev.title);
    added += 1;
  }
  if (added) writeAll(all);
  return { ok: true, added, from, to };
}

/** 近聊启发式扫出提议（无 LLM / 失败兜底） */
function heuristicChatProposals(chatLines, baseDate) {
  const base = normalizeDate(baseDate || localDateISO(new Date()));
  const blob = (chatLines || []).join("\n");
  const out = [];
  const push = (title, date) => {
    if (!title || !date || out.length >= 4) return;
    if (out.some((p) => p.date === date && p.title === title)) return;
    out.push({
      id: randomUUID(),
      kind: "event",
      title: String(title).slice(0, 120),
      date,
      status: "proposed",
      from_scan: true,
    });
  };
  const act = /(约|见面|吃饭|开会|出发|看|陪|一起|安排)/;
  if (/明天/.test(blob) && act.test(blob)) {
    push("明天有约（近聊）", addDaysISO(base, 1));
  }
  if (/后天/.test(blob) && act.test(blob)) {
    push("后天有约（近聊）", addDaysISO(base, 2));
  }
  const weekMap = { 天: 0, 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const wm = blob.match(/下周([一二三四五六日天])/);
  if (wm && act.test(blob)) {
    const wd = weekMap[wm[1]];
    if (wd != null) {
      const parts = base.split("-").map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      d.setDate(d.getDate() + 7);
      while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
      push("下周" + wm[1] + "有约（近聊）", localDateISO(d));
    }
  }
  const md = blob.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md && (act.test(blob) || /生日|纪念日/.test(blob))) {
    const y = Number(base.slice(0, 4));
    const m = String(Number(md[1])).padStart(2, "0");
    const day = String(Number(md[2])).padStart(2, "0");
    try {
      push(
        Number(md[1]) + "月" + Number(md[2]) + "日安排（近聊）",
        normalizeDate(y + "-" + m + "-" + day)
      );
    } catch (_) {}
  }
  const iso = blob.match(/(20\d{2}-\d{2}-\d{2})/);
  if (iso && act.test(blob)) {
    try {
      push("日程（近聊）", normalizeDate(iso[1]));
    } catch (_) {}
  }
  return out;
}

/**
 * C7：扫近聊 → 提议待确认（不静默落库）。
 */
async function scanChatPropose(patch) {
  let baseDate;
  try {
    baseDate = normalizeDate(
      (patch && patch.baseDate) || localDateISO(new Date())
    );
  } catch {
    baseDate = localDateISO(new Date());
  }
  let chatBits = [];
  try {
    const { listMessages } = require("../../聊天app/gateway/daily-chat");
    const msgs = (listMessages().messages || []).slice(-40);
    chatBits = msgs.map((m) => {
      const who = m.from === "bot" ? "家机" : "你";
      return who + "：" + String(m.body || "").replace(/\s+/g, " ").slice(0, 100);
    });
  } catch (_) {
    /* ignore */
  }
  if (!chatBits.length) {
    return {
      ok: true,
      source: "empty",
      proposals: [],
      noteProposals: [],
      message: "近聊为空，没什么可扫",
    };
  }

  const forceMock = !!(patch && patch.mock);
  if (forceMock) {
    return {
      ok: true,
      source: "mock",
      proposals: heuristicChatProposals(chatBits, baseDate),
      noteProposals: [],
    };
  }

  try {
    const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
    const existing = listEvents({
      from: baseDate,
      to: addDaysISO(baseDate, 21),
    }).events
      .map((e) => e.date + " " + e.title)
      .slice(0, 12);
    const system =
      "你从近聊里抽出**已经说定**的现实日程。只输出 JSON 对象，不要 markdown。" +
      '{"events":[{"title":"短标题","date":"YYYY-MM-DD"}],"notes":[{"body":"短句","date":"YYYY-MM-DD"}]}。' +
      "不确定、玩笑、已有日程重复的不要。最多 4 条行程、2 条便签。基准日 " +
      baseDate +
      "。" +
      (existing.length ? "已有：" + existing.join("；") + "。" : "");
    const raw = await chatCompletion({
      system,
      user: "近聊：\n" + chatBits.join("\n"),
      think: false,
      replyKind: "chat",
    });
    const parsedBody = parseThinkBody(raw.content, false);
    const text = String((parsedBody && parsedBody.body) || raw.content || "").trim();
    let { proposals, noteProposals } = parseProposePayload(text, baseDate);
    proposals = (proposals || []).slice(0, 4).map((p) => ({
      ...p,
      from_scan: true,
    }));
    noteProposals = (noteProposals || []).slice(0, 2).map((p) => ({
      ...p,
      from_scan: true,
    }));
    let source = "llm";
    let message;
    if (!proposals.length && !noteProposals.length) {
      proposals = heuristicChatProposals(chatBits, baseDate);
      noteProposals = [];
      source = "mock_fallback";
      message = "模型未抽出事项，已用启发式";
    }
    let used = (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0);
    if (used <= 0) used = 400;
    addCalTokensUsed(used);
    return { ok: true, source, proposals, noteProposals, message };
  } catch (e) {
    if (e && e.code === "llm_not_configured") {
      return {
        ok: true,
        source: "mock",
        proposals: heuristicChatProposals(chatBits, baseDate),
        noteProposals: [],
        message: "未配置 LLM，已用近聊启发式",
      };
    }
    return {
      ok: true,
      source: "mock_fallback",
      proposals: heuristicChatProposals(chatBits, baseDate),
      noteProposals: [],
      message: (e && e.message) || "扫聊失败，已用启发式",
    };
  }
}

const MOCK_IDEAS = [
  "傍晚散步半小时",
  "一起买点菜做饭",
  "窝着看一部轻松片",
  "给房间通通风扫一扫",
  "下午茶歇会儿",
  "写两行今天的小事",
  "听一张新专辑",
  "早点睡补觉",
];

/** 无 Key / 解析失败：本地瞎编几条，不拆用户输入 */
function mockProposals(baseDate) {
  const base = normalizeDate(baseDate || localDateISO(new Date()));
  const pool = MOCK_IDEAS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  return pool.slice(0, 3).map((title, i) => ({
    id: randomUUID(),
    kind: "event",
    title,
    date: addDaysISO(base, i),
    status: "proposed",
  }));
}

function parseProposalJson(raw, baseDate) {
  return parseProposePayload(raw, baseDate).proposals;
}

function parseProposePayload(raw, baseDate) {
  const base = normalizeDate(baseDate || localDateISO(new Date()));
  const s = String(raw || "").trim();
  let data;
  const objMatch = s.match(/\{[\s\S]*\}/);
  const arrMatch = s.match(/\[[\s\S]*\]/);
  try {
    if (objMatch && objMatch[0].includes('"events"')) {
      data = JSON.parse(objMatch[0]);
    } else if (arrMatch) {
      data = { events: JSON.parse(arrMatch[0]), notes: [] };
    } else {
      return { proposals: [], noteProposals: [] };
    }
  } catch {
    return { proposals: [], noteProposals: [] };
  }
  const events = Array.isArray(data.events) ? data.events : Array.isArray(data) ? data : [];
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const proposals = [];
  for (const row of events.slice(0, 5)) {
    if (!row || typeof row !== "object") continue;
    const title = String(row.title || "").trim().slice(0, 120);
    if (!title) continue;
    let date;
    try {
      date = normalizeDate(row.date);
    } catch {
      date = base;
    }
    proposals.push({
      id: randomUUID(),
      kind: "event",
      title,
      date,
      status: "proposed",
    });
  }
  const noteProposals = [];
  for (const row of notes.slice(0, 3)) {
    if (!row || typeof row !== "object") continue;
    const body = String(row.body || row.title || "").trim().slice(0, 500);
    if (!body) continue;
    let date;
    try {
      date = normalizeDate(row.date);
    } catch {
      date = base;
    }
    noteProposals.push({
      id: randomUUID(),
      kind: "note",
      body,
      date,
      status: "proposed",
    });
  }
  return { proposals, noteProposals };
}

function mockNoteProposals(baseDate) {
  const base = normalizeDate(baseDate || localDateISO(new Date()));
  return [
    {
      id: randomUUID(),
      kind: "note",
      body: "今天记得喝水，别一直盯屏幕",
      date: base,
      status: "proposed",
    },
  ];
}

/** 排程上下文：日程 + 近聊 + 共听状态（共读/共看深摘要后补） */
function gatherProposeContext(baseDate) {
  const existing = listEvents({
    from: baseDate,
    to: addDaysISO(baseDate, 14),
  }).events
    .map((e) => e.date + " " + e.title)
    .slice(0, 12);
  const existingNotes = listNotes({}).notes
    .filter((n) => n.date >= baseDate && n.date <= addDaysISO(baseDate, 14))
    .map((n) => n.date + " [" + (n.owner === "companion" ? "家机" : "你") + "] " + n.body)
    .slice(0, 8);
  let chatBits = [];
  try {
    const { listMessages } = require("../../聊天app/gateway/daily-chat");
    const msgs = (listMessages().messages || []).slice(-8);
    chatBits = msgs.map((m) => {
      const who = m.from === "bot" ? "家机" : "你";
      return who + "：" + String(m.body || "").replace(/\s+/g, " ").slice(0, 80);
    });
  } catch (_) {
    /* ignore */
  }
  let listenLabel = "";
  try {
    const { getListenPresence } = require("../../共听app/gateway/listen");
    listenLabel = String((getListenPresence() || {}).label || "").trim();
  } catch (_) {
    /* ignore */
  }
  return { existing, existingNotes, chatBits, listenLabel };
}

/**
 * 家机自主排程：日程 + 可选便签；未配置 / 失败则本地瞎编。
 * 确认写入仍走 createEvent / createNote（不静默落库）。
 */
async function proposeEvents(patch) {
  let baseDate;
  try {
    baseDate = normalizeDate(
      (patch && patch.baseDate) || localDateISO(new Date())
    );
  } catch {
    baseDate = localDateISO(new Date());
  }

  const forceMock = !!(patch && patch.mock);
  if (forceMock) {
    return {
      ok: true,
      source: "mock",
      proposals: mockProposals(baseDate),
      noteProposals: mockNoteProposals(baseDate),
    };
  }

  const ctx = gatherProposeContext(baseDate);
  const ctxLines = [];
  if (ctx.existing.length) ctxLines.push("已有日程：" + ctx.existing.join("；"));
  if (ctx.existingNotes.length) ctxLines.push("已有便签：" + ctx.existingNotes.join("；"));
  if (ctx.chatBits.length) ctxLines.push("近聊：" + ctx.chatBits.join(" / "));
  if (ctx.listenLabel) ctxLines.push("共听：" + ctx.listenLabel);

  try {
    const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
    const system =
      "你是同居小家机，只认现实日期（本机本地日）。" +
      "今天是 " +
      baseDate +
      "。" +
      "请结合上下文，自己主动想 2～4 条日程，并可另想 0～2 条绑日便签（生活向、轻松、具体）。" +
      "不要向用户索取输入；勿与已有日程/便签重复。" +
      (ctxLines.length ? "上下文：" + ctxLines.join(" ") + "。" : "") +
      "只输出一个 JSON 对象，不要其它说明、不要 markdown 代码块。" +
      '格式严格为：{"events":[{"title":"短标题","date":"YYYY-MM-DD"}],"notes":[{"body":"便签正文","date":"YYYY-MM-DD"}]}' +
      "。date 落在今天起两周内；title≤40字；body≤80字；notes 可空数组。";
    const raw = await chatCompletion({
      system,
      user: "轮到你排日程、也可贴便签，想几件吧。",
      think: false,
      replyKind: "chat",
    });
    const parsed = parseThinkBody(raw.content, false);
    const body = String(parsed.body || raw.content || "").trim();
    let { proposals, noteProposals } = parseProposePayload(body, baseDate);
    let source = "llm";
    let message;
    if (!proposals.length && !noteProposals.length) {
      proposals = mockProposals(baseDate);
      noteProposals = mockNoteProposals(baseDate);
      source = "mock_fallback";
      message = "模型格式不对，已用本地兜底";
    }
    let used = (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0);
    if (used <= 0) used = 500;
    addCalTokensUsed(used);
    return { ok: true, source, proposals, noteProposals, message };
  } catch (e) {
    if (e && e.code === "llm_not_configured") {
      return {
        ok: true,
        source: "mock",
        proposals: mockProposals(baseDate),
        noteProposals: mockNoteProposals(baseDate),
        message: "未配置 LLM，已用本地瞎编",
      };
    }
    return {
      ok: true,
      source: "mock_fallback",
      proposals: mockProposals(baseDate),
      noteProposals: mockNoteProposals(baseDate),
      message: (e && e.message) || "家机暂时接不上，已用本地兜底",
    };
  }
}

if (require.main === module) {
  (async () => {
    const stamp = "selfcheck-" + Date.now();
    const created = createEvent({ title: stamp, date: "2026-10-02" });
    console.assert(created.event && created.event.title === stamp);
    console.assert(created.event.owner === "you");
    const timed = createEvent({
      title: "S8 timed " + stamp,
      date: created.event.date,
      time: "14:05",
    });
    console.assert(timed.event.time === "14:05" && timed.event.allDay === false);
    deleteEvent(timed.event.id);
    const fromBot = createEvent({
      title: stamp + "-aji",
      date: "2026-10-02",
      owner: "companion",
    });
    console.assert(fromBot.event.owner === "companion");
    deleteEvent(fromBot.event.id);
    const listed = listEvents({ date: "2026-10-02" });
    console.assert(listed.events.some((e) => e.id === created.event.id));
    updateEvent(created.event.id, { title: stamp + "-u" });
    console.assert(
      listEvents({ date: "2026-10-02" }).events
        .find((e) => e.id === created.event.id)
        .title.endsWith("-u")
    );
    deleteEvent(created.event.id);
    console.assert(
      !listEvents({ date: "2026-10-02" }).events.some((e) => e.id === created.event.id)
    );
    try {
      createEvent({ title: "x", date: "2026-13-01" });
      throw new Error("expected bad_cal_date");
    } catch (e) {
      if (e.code !== "bad_cal_date") throw e;
    }
    const mocked = mockProposals("2026-10-10");
    console.assert(mocked.length >= 2 && mocked[0].date === "2026-10-10");
    const parsed = parseProposalJson(
      '[{"title":"散步","date":"2026-10-11"}]',
      "2026-10-10"
    );
    console.assert(parsed.length === 1 && parsed[0].title === "散步");
    const prop = await proposeEvents({
      baseDate: "2026-10-10",
      mock: true,
    });
    console.assert(prop.ok && prop.source === "mock" && prop.proposals.length >= 1);
    console.assert(prop.noteProposals && prop.noteProposals.length >= 1);
    const noteDay = "2026-10-03";
    const linkEv = createEvent({
      title: "挂笺-" + stamp,
      date: noteDay,
      owner: "companion",
    });
    const yours = createNote({ date: noteDay, body: "便签-" + stamp, owner: "you" });
    const bots = createNote({
      date: noteDay,
      body: "家机便签-" + stamp,
      owner: "companion",
      event_id: linkEv.event.id,
    });
    console.assert(yours.note.owner === "you" && bots.note.owner === "companion");
    console.assert(bots.note.event_id === linkEv.event.id);
    console.assert(bots.note.event_title === linkEv.event.title);
    console.assert(yours.note.liked === false);
    const liked = updateNote(yours.note.id, { liked: true });
    console.assert(liked.note && liked.note.liked === true);
    console.assert(updateNote(yours.note.id, { liked: false }).note.liked === false);
    console.assert(listNotes({ date: noteDay }).notes.length >= 2);
    deleteNote(yours.note.id);
    deleteNote(bots.note.id);
    deleteEvent(linkEv.event.id);
    console.assert(listNotes({ date: noteDay }).notes.length === 0);
    const packed = parseProposePayload(
      '{"events":[{"title":"散步","date":"2026-10-11"}],"notes":[{"body":"带伞","date":"2026-10-11"}]}',
      "2026-10-10"
    );
    console.assert(packed.proposals.length === 1 && packed.noteProposals.length === 1);
    const stamp2 = "newchk-" + Date.now();
    const nEv = createEvent({ title: stamp2, date: "2026-10-04" });
    console.assert(buildNewPrompt().includes("[NEW]") && buildNewPrompt().includes(stamp2));
    deleteEvent(nEv.event.id);
    const synced = syncAutoEvents({ from: "2026-01-01", to: "2026-01-05" });
    console.assert(synced.ok && synced.added >= 1);
    const again = syncAutoEvents({ from: "2026-01-01", to: "2026-01-05" });
    console.assert(again.added === 0);
    const hol = listEvents({ date: "2026-01-01" }).events.find(
      (e) => e.source === "auto" && e.title === "元旦"
    );
    console.assert(hol && hol.id.startsWith("auto-"));
    deleteEvent(hol.id);
    console.assert(readAll().auto_dismissed.includes(hol.id));
    const heu = heuristicChatProposals(
      ["你：明天一起吃饭吧"],
      "2026-10-10"
    );
    console.assert(heu.length >= 1 && heu[0].date === "2026-10-11");
    const scanned = await scanChatPropose({ mock: true, baseDate: "2026-10-10" });
    console.assert(scanned.ok && scanned.source === "mock");
    console.log("calendar ok");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  upsertNote,
  readAll,
  normalizeDate,
  localDateISO,
  proposeEvents,
  mockProposals,
  parseProposalJson,
  parseProposePayload,
  addCalTokensUsed,
  markCalendarChanged,
  buildNewPrompt,
  syncAutoEvents,
  scanChatPropose,
  heuristicChatProposals,
  listAutoCandidates,
  FIXED_HOLIDAYS,
  CAL_PATH,
};
