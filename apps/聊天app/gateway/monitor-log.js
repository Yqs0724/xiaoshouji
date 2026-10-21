/**
 * V3 监控日志：对照 AionsHome monitor_logs/*.jsonl（按日、3 天清理）。
 * 广播：内存订阅（SSE 兼容）+ 同端口 WebSocket `/ws`（monitor_log）。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const LOG_DIR = path.join(DATA_DIR, "monitor_logs");
const KEEP_DAYS = 3;

/** @type {Set<(entry: object) => void>} */
const listeners = new Set();

function ensureLogDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function localDateISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localTimeHM(d = new Date()) {
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${mi}`;
}

function logPathForDate(dateStr) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))
    ? String(dateStr)
    : localDateISO();
  return path.join(LOG_DIR, day + ".jsonl");
}

/** 删掉超过 KEEP_DAYS 的 jsonl */
function cleanupOldLogs(now = new Date()) {
  ensureLogDir();
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (KEEP_DAYS - 1));
  let removed = 0;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const day = name.slice(0, 10);
    const t = Date.parse(day + "T00:00:00");
    if (!Number.isFinite(t) || t >= cutoff.getTime()) continue;
    try {
      fs.unlinkSync(path.join(LOG_DIR, name));
      removed += 1;
    } catch (_) {}
  }
  return removed;
}

/**
 * @param {object} partial
 * @returns {object} 写入的完整条目
 */
function appendMonitorLog(partial) {
  ensureLogDir();
  cleanupOldLogs();
  const now = new Date();
  const entry = {
    ts: Date.now(),
    time: localTimeHM(now),
    date: localDateISO(now),
    kind: String((partial && partial.kind) || "sentinel").slice(0, 32),
    monitoringlog: String((partial && partial.monitoringlog) || "").trim().slice(0, 500),
    call_core: !!(partial && partial.call_core),
    core_reason: String((partial && partial.core_reason) || "").trim().slice(0, 200),
    capture_ok:
      partial && Object.prototype.hasOwnProperty.call(partial, "capture_ok")
        ? !!partial.capture_ok
        : null,
    woke: !!(partial && partial.woke),
  };
  if (partial && partial.extra && typeof partial.extra === "object") {
    entry.extra = partial.extra;
  }
  const file = logPathForDate(entry.date);
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (_) {}
  }
  try {
    require("../../共读app/gateway/ws-hub").broadcastMonitorLog(entry);
  } catch (_) {
    /* ws 未挂载时忽略 */
  }
  return entry;
}

function readMonitorLogs(dateStr) {
  ensureLogDir();
  const file = logPathForDate(dateStr || localDateISO());
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") out.push(o);
    } catch (_) {}
  }
  return out;
}

function listMonitorLogDates() {
  ensureLogDir();
  return fs
    .readdirSync(LOG_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort()
    .reverse();
}

function subscribeMonitorLogs(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function selfCheck() {
  const stamp = "v3-self-" + Date.now();
  const e = appendMonitorLog({
    kind: "selfcheck",
    monitoringlog: stamp,
    call_core: false,
    capture_ok: true,
  });
  console.assert(e.monitoringlog === stamp);
  const day = e.date;
  const list = readMonitorLogs(day);
  console.assert(list.some((x) => x.monitoringlog === stamp));
  const dates = listMonitorLogDates();
  console.assert(dates.includes(day));
  /* 清掉自检行：重写当日文件去掉 stamp */
  const kept = list.filter((x) => x.monitoringlog !== stamp);
  const file = logPathForDate(day);
  fs.writeFileSync(
    file,
    kept.map((x) => JSON.stringify(x)).join("\n") + (kept.length ? "\n" : ""),
    "utf8"
  );
  let got = null;
  const unsub = subscribeMonitorLogs((x) => {
    got = x;
  });
  appendMonitorLog({ kind: "selfcheck", monitoringlog: "ping", call_core: false });
  unsub();
  console.assert(got && got.monitoringlog === "ping");
  const after = readMonitorLogs(day).filter((x) => x.monitoringlog !== "ping");
  fs.writeFileSync(
    file,
    after.map((x) => JSON.stringify(x)).join("\n") + (after.length ? "\n" : ""),
    "utf8"
  );
  console.log("monitor-log self-check ok");
}

if (require.main === module) {
  try {
    selfCheck();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

module.exports = {
  KEEP_DAYS,
  LOG_DIR,
  appendMonitorLog,
  readMonitorLogs,
  listMonitorLogDates,
  cleanupOldLogs,
  subscribeMonitorLogs,
  localDateISO,
  selfCheck,
};
