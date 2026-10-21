/**
 * 定时监控（对齐教程 [Monitor:]）：预约到点看护 → 观察 → 家机主动短讯。
 * 不是闹钟；不依赖哨兵开关。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_PATH = path.join(DATA_DIR, "monitor-jobs.json");
const MAX_PENDING = 12;
const MAX_MINUTES = 720;
const POLL_MS = 30_000;
const ALERT_DELAY_SEC = 3;

let loopTimer = null;
let fireBusy = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJobs() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
    const jobs = Array.isArray(raw && raw.jobs) ? raw.jobs : [];
    return { jobs };
  } catch {
    return { jobs: [] };
  }
}

function writeJobs(jobs) {
  ensureDataDir();
  fs.writeFileSync(
    JOBS_PATH,
    JSON.stringify({ jobs: jobs || [] }, null, 2),
    "utf8"
  );
}

function newId() {
  return "m" + crypto.randomBytes(4).toString("hex");
}

function fmtLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
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

/** HH:MM → 下一发生时刻（今日未过用今日，否则明日）；失败 null */
function resolveAtToMs(at, now = Date.now()) {
  const m = String(at || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(h, min, 0, 0);
  let t = d.getTime();
  if (t <= now + 15_000) t += 24 * 60 * 60 * 1000;
  const max = now + MAX_MINUTES * 60 * 1000;
  if (t > max) return null;
  return t;
}

function resolveFireAt(args, now = Date.now()) {
  const a = args && typeof args === "object" ? args : {};
  if (a.at != null && String(a.at).trim()) {
    const t = resolveAtToMs(a.at, now);
    if (t == null) {
      return {
        ok: false,
        error: "bad_at",
        message: "at 要 HH:MM，且须在约 " + MAX_MINUTES + " 分钟内",
      };
    }
    return { ok: true, fire_at: t };
  }
  let minutes = Number(a.minutes);
  if (!Number.isFinite(minutes) && a.in_minutes != null) {
    minutes = Number(a.in_minutes);
  }
  if (!Number.isFinite(minutes)) {
    return {
      ok: false,
      error: "need_when",
      message: "请给 minutes（1～" + MAX_MINUTES + "）或 at（HH:MM）",
    };
  }
  minutes = Math.max(1, Math.min(MAX_MINUTES, Math.floor(minutes)));
  return { ok: true, fire_at: now + minutes * 60 * 1000, minutes };
}

function pendingJobs(jobs) {
  return (jobs || []).filter((j) => j && j.status === "pending");
}

function publicJob(j) {
  if (!j) return null;
  return {
    id: j.id,
    fire_at: j.fire_at,
    fire_local: fmtLocal(j.fire_at),
    why: j.why || "",
    status: j.status,
  };
}

/**
 * @param {{ minutes?: number, at?: string, why?: string }} args
 */
function scheduleMonitor(args = {}) {
  const when = resolveFireAt(args);
  if (!when.ok) {
    return {
      ok: false,
      error: when.error,
      message: when.message,
    };
  }
  const store = readJobs();
  const pending = pendingJobs(store.jobs);
  if (pending.length >= MAX_PENDING) {
    return {
      ok: false,
      error: "too_many",
      message: "待执行预约已满（最多 " + MAX_PENDING + " 条），先取消一条",
      pending: pending.map(publicJob),
    };
  }
  const why = String(args.why || "").trim().slice(0, 120);
  const job = {
    id: newId(),
    fire_at: when.fire_at,
    why,
    status: "pending",
    created_at: Date.now(),
  };
  store.jobs.push(job);
  writeJobs(store.jobs);
  try {
    require("./monitor-log").appendMonitorLog({
      kind: "schedule_monitor",
      monitoringlog:
        "预约看护 @" + fmtLocal(job.fire_at) + (why ? "：" + why : ""),
      call_core: false,
      woke: false,
    });
  } catch (_) {}
  return {
    ok: true,
    job: publicJob(job),
    message:
      "已约 " +
      fmtLocal(job.fire_at) +
      " 看护一次" +
      (why ? "（" + why + "）" : "") +
      "；到点会主动发一条，不是闹钟。",
  };
}

function listMonitors() {
  const pending = pendingJobs(readJobs().jobs).sort(
    (a, b) => a.fire_at - b.fire_at
  );
  return {
    ok: true,
    pending: pending.map(publicJob),
    count: pending.length,
    message: pending.length
      ? "待执行 " + pending.length + " 条"
      : "没有待执行的预约看护",
  };
}

function cancelMonitor(id) {
  const want = String(id || "").trim();
  if (!want) {
    return { ok: false, error: "need_id", message: "取消要给 id" };
  }
  const store = readJobs();
  const job = store.jobs.find((j) => j && j.id === want);
  if (!job) {
    return { ok: false, error: "not_found", message: "找不到这条预约" };
  }
  if (job.status !== "pending") {
    return {
      ok: false,
      error: "not_pending",
      message: "这条已经是 " + job.status,
      job: publicJob(job),
    };
  }
  job.status = "cancelled";
  job.cancelled_at = Date.now();
  writeJobs(store.jobs);
  try {
    require("./monitor-log").appendMonitorLog({
      kind: "schedule_monitor",
      monitoringlog: "取消预约 " + job.id,
      call_core: false,
      woke: false,
    });
  } catch (_) {}
  return {
    ok: true,
    job: publicJob(job),
    message: "已取消 " + fmtLocal(job.fire_at) + " 那次看护",
  };
}

async function gatherObservation(why, opts = {}) {
  let observation = "";
  let via = "none";
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    if (readSettings().activity_enabled) {
      const { summarizeActivity } = require("./activity");
      const sum = summarizeActivity(30, 6);
      const t = String(sum.text || "").trim();
      if (t && sum.samples > 0) {
        observation = t;
        via = "activity";
      }
    }
  } catch (_) {}
  if (!observation && !opts.skipCapture) {
    try {
      const { runCamCheck } = require("./chat-tools");
      const cam = await runCamCheck({
        why: why || "预约看护到点",
        skipCapture: false,
        chatCompletion: opts.chatCompletion,
      });
      if (cam.ok) {
        const o = JSON.parse(cam.result);
        if (o && o.scene) {
          observation = String(o.scene).trim();
          via = "cam";
        }
      }
    } catch (_) {}
  }
  return { observation, via };
}

/**
 * @param {object} job
 * @param {{ skipCapture?: boolean, chatCompletion?: Function, skipAlertDelay?: boolean }} [opts]
 */
async function fireMonitorJob(job, opts = {}) {
  const why = String((job && job.why) || "").trim() || "预约看护到点";
  if (!opts.skipCapture) {
    try {
      require("../../共读app/gateway/ws-hub").broadcastMonitorAlert(
        "预约看护到点了",
        { kind: "schedule_monitor", seconds: ALERT_DELAY_SEC }
      );
    } catch (_) {}
    if (!opts.skipAlertDelay) {
      await new Promise((r) => setTimeout(r, ALERT_DELAY_SEC * 1000));
    }
  }
  const { observation, via } = await gatherObservation(why, opts);
  const { askCore, sanitizeCoreReply } = require("./presence");
  const chatCompletion =
    opts.chatCompletion ||
    require("../../共读app/gateway/llm").chatCompletion;
  let text = "";
  try {
    text = await askCore({
      decision: {
        reason: why,
        hint: observation
          ? "观察（" + via + "）：" + observation.slice(0, 280)
          : "到点打个招呼，问问在干嘛",
      },
      chatCompletion,
    });
  } catch (e) {
    text = "";
    try {
      require("./monitor-log").appendMonitorLog({
        kind: "schedule_monitor",
        monitoringlog:
          "预约看护 Core 失败：" +
          String((e && e.message) || e).slice(0, 120),
        call_core: true,
        woke: false,
      });
    } catch (_) {}
    return { ok: false, error: "core_failed", job_id: job.id };
  }
  text = sanitizeCoreReply(text, { reason: why });
  if (!text) text = "到点啦，在干嘛呢？";

  const { appendMessage, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
  const message = withPeer(DEFAULT_PEER_ID, () =>
    appendMessage("bot", text, "text", { source: "schedule_monitor" })
  );
  try {
    require("./monitor-log").appendMonitorLog({
      kind: "schedule_monitor",
      monitoringlog:
        "预约看护已发：" + text.slice(0, 80) + (via !== "none" ? " [" + via + "]" : ""),
      call_core: true,
      core_reason: why,
      woke: true,
    });
  } catch (_) {}
  return { ok: true, woke: true, message, via, job_id: job.id };
}

async function tickDueMonitors(opts = {}) {
  if (fireBusy) return { ok: true, skipped: "busy", fired: 0 };
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const store = readJobs();
  const due = pendingJobs(store.jobs)
    .filter((j) => j.fire_at <= now)
    .sort((a, b) => a.fire_at - b.fire_at);
  if (!due.length) return { ok: true, fired: 0 };
  fireBusy = true;
  const results = [];
  try {
    for (const job of due) {
      job.status = "running";
      writeJobs(store.jobs);
      let out;
      try {
        out = await fireMonitorJob(job, opts);
      } catch (e) {
        out = {
          ok: false,
          error: String((e && e.message) || e).slice(0, 120),
        };
      }
      job.status = out && out.ok ? "done" : "failed";
      job.finished_at = Date.now();
      if (out && out.error) job.error = out.error;
      writeJobs(store.jobs);
      results.push(out);
    }
  } finally {
    fireBusy = false;
  }
  /* ponytail: 只留近 40 条记录，防文件胀 */
  const trimmed = store.jobs.slice(-40);
  if (trimmed.length !== store.jobs.length) writeJobs(trimmed);
  return { ok: true, fired: results.length, results };
}

function startMonitorLoop() {
  stopMonitorLoop();
  loopTimer = setInterval(() => {
    tickDueMonitors({}).catch(() => {});
  }, POLL_MS);
  tickDueMonitors({}).catch(() => {});
  return { ok: true, running: true, poll_ms: POLL_MS };
}

function stopMonitorLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  return { ok: true, running: false };
}

if (require.main === module) {
  (async () => {
    const when = resolveFireAt({ minutes: 5 }, 1_000_000);
    console.assert(when.ok && when.fire_at === 1_000_000 + 5 * 60 * 1000);
    console.assert(resolveFireAt({}).ok === false);
    const at = resolveAtToMs("23:59", new Date(2026, 0, 1, 12, 0).getTime());
    console.assert(at != null);

    const made = scheduleMonitor({ minutes: 60, why: "自检预约" });
    console.assert(made.ok && made.job && made.job.id, made);
    const listed = listMonitors();
    console.assert(listed.count >= 1);
    const cancelled = cancelMonitor(made.job.id);
    console.assert(cancelled.ok && cancelled.job.status === "cancelled");

    const due = scheduleMonitor({ minutes: 1, why: "自检到点" });
    console.assert(due.ok);
    const store = readJobs();
    const job = store.jobs.find((j) => j.id === due.job.id);
    job.fire_at = Date.now() - 1000;
    writeJobs(store.jobs);

    let calls = 0;
    const fakeLlm = async () => {
      calls += 1;
      return { content: "自检：到点啦？" };
    };
    const tick = await tickDueMonitors({
      skipCapture: true,
      skipAlertDelay: true,
      chatCompletion: fakeLlm,
      now: Date.now(),
    });
    console.assert(tick.fired >= 1 && tick.results[0].ok, tick);
    console.assert(calls >= 1);

    try {
      const { readAll, writeAll, withPeer, DEFAULT_PEER_ID } = require(
        "./daily-chat"
      );
      const mid = tick.results[0].message && tick.results[0].message.id;
      if (mid) {
        withPeer(DEFAULT_PEER_ID, () => {
          const all = readAll();
          all.messages = (all.messages || []).filter((m) => m && m.id !== mid);
          writeAll(all);
        });
      }
    } catch (_) {}

    /* 清掉自检残留 pending */
    const leftover = readJobs();
    leftover.jobs = leftover.jobs.filter(
      (j) =>
        !(
          j &&
          (j.why === "自检预约" || j.why === "自检到点") &&
          j.status !== "pending"
        )
    );
    writeJobs(leftover.jobs);
    console.log("schedule-monitor ok");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  scheduleMonitor,
  listMonitors,
  cancelMonitor,
  tickDueMonitors,
  fireMonitorJob,
  startMonitorLoop,
  stopMonitorLoop,
  resolveFireAt,
  resolveAtToMs,
  MAX_MINUTES,
  MAX_PENDING,
  ALERT_DELAY_SEC,
};
