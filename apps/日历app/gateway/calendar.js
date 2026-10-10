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
  return {
    id,
    title: title.slice(0, 120),
    date,
    allDay: raw.allDay !== false,
    owner: "you",
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(CAL_PATH, "utf8"));
    const events = Array.isArray(raw.events)
      ? raw.events.map(normalizeEvent).filter(Boolean)
      : [];
    return { events };
  } catch {
    return { events: [] };
  }
}

function writeAll(data) {
  ensureFile();
  const events = (data.events || []).map(normalizeEvent).filter(Boolean);
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.created_at - b.created_at));
  fs.writeFileSync(CAL_PATH, JSON.stringify({ events }, null, 2), "utf8");
  return { events };
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

function createEvent(patch) {
  const title = String(patch && patch.title != null ? patch.title : "").trim();
  if (!title) {
    const err = new Error("标题不能为空");
    err.code = "bad_cal_title";
    throw err;
  }
  const date = normalizeDate(patch && patch.date);
  const now = Date.now();
  const ev = normalizeEvent({
    id: randomUUID(),
    title,
    date,
    allDay: true,
    owner: "you",
    created_at: now,
    updated_at: now,
  });
  const all = readAll();
  all.events.push(ev);
  writeAll(all);
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
    updated_at: Date.now(),
  };
  if (!next.title) {
    const err = new Error("标题不能为空");
    err.code = "bad_cal_title";
    throw err;
  }
  all.events[i] = normalizeEvent(next);
  writeAll(all);
  return { ok: true, event: all.events.find((e) => e.id === eid) };
}

function deleteEvent(id) {
  const eid = String(id || "").trim();
  const all = readAll();
  const next = all.events.filter((e) => e.id !== eid);
  if (next.length === all.events.length) {
    const err = new Error("找不到该日程");
    err.code = "cal_not_found";
    throw err;
  }
  writeAll({ events: next });
  return { ok: true, deleted: eid };
}

if (require.main === module) {
  const stamp = "selfcheck-" + Date.now();
  const created = createEvent({ title: stamp, date: "2026-10-02" });
  console.assert(created.event && created.event.title === stamp);
  const listed = listEvents({ date: "2026-10-02" });
  console.assert(listed.events.some((e) => e.id === created.event.id));
  updateEvent(created.event.id, { title: stamp + "-u" });
  console.assert(listEvents({ date: "2026-10-02" }).events.find((e) => e.id === created.event.id).title.endsWith("-u"));
  deleteEvent(created.event.id);
  console.assert(!listEvents({ date: "2026-10-02" }).events.some((e) => e.id === created.event.id));
  try {
    createEvent({ title: "x", date: "2026-13-01" });
    throw new Error("expected bad_cal_date");
  } catch (e) {
    if (e.code !== "bad_cal_date") throw e;
  }
  console.log("calendar ok");
}

module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  readAll,
  normalizeDate,
  CAL_PATH,
};
