/**
 * V4 设备活动：Win 前台窗口采样 → JSONL → 摘要喂哨兵。
 * 对齐 AionsHome activity 意图（仅 PC；无手机 App）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const LOG_DIR = path.join(DATA_DIR, "activity_logs");
const KEEP_HOURS = 3;
const SAMPLE_SEC = 60;
const TITLE_MAX = 80;

let loopTimer = null;
let lastSampleKey = "";

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
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function logPathForDate(dateStr) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))
    ? String(dateStr)
    : localDateISO();
  return path.join(LOG_DIR, day + ".jsonl");
}

function scrubTitle(raw) {
  let t = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  /* 粗滤：密码/验证码类标题不进日志 */
  if (/密码|验证码|payment|password|otp|银行.*转账/i.test(t)) {
    return "[隐私窗口]";
  }
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX) + "…";
  return t;
}

/**
 * @returns {{ ok: boolean, title?: string, app?: string, error?: string }}
 */
function sampleForeground() {
  if (process.platform !== "win32") {
    return { ok: false, error: "unsupported_platform" };
  }
  ensureLogDir();
  const stamp = Date.now();
  const ps1 = path.join(DATA_DIR, `activity-fg-${stamp}.ps1`);
  const outFile = path.join(DATA_DIR, `activity-fg-${stamp}.out.txt`);
  /* 写 UTF-8 文件，避免控制台代码页把中文标题弄乱 */
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AriadneFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [AriadneFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][AriadneFg]::GetWindowText($h, $sb, $sb.Capacity)
$title = $sb.ToString()
$pidOut = [uint32]0
[void][AriadneFg]::GetWindowThreadProcessId($h, [ref]$pidOut)
$app = ""
try {
  if ($pidOut -gt 0) {
    $p = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
    if ($p) { $app = [string]$p.ProcessName }
  }
} catch {}
$line = $app + [char]9 + $title
[System.IO.File]::WriteAllText(${JSON.stringify(outFile)}, $line, (New-Object System.Text.UTF8Encoding $false))
`;
  try {
    fs.writeFileSync(ps1, "\uFEFF" + script, "utf8");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      { timeout: 8000, windowsHide: true, encoding: "utf8" }
    );
    if (!fs.existsSync(outFile)) return { ok: false, error: "empty" };
    const line = fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (!line) return { ok: false, error: "empty" };
    const tab = line.indexOf("\t");
    const app = tab >= 0 ? line.slice(0, tab).trim() : "";
    const title = scrubTitle(tab >= 0 ? line.slice(tab + 1) : line);
    if (!title && !app) return { ok: false, error: "blank" };
    return { ok: true, app: app || "unknown", title: title || "(无标题)" };
  } catch (e) {
    return {
      ok: false,
      error: "sample_failed",
      message: String((e && e.message) || e).slice(0, 160),
    };
  } finally {
    try {
      fs.unlinkSync(ps1);
    } catch (_) {}
    try {
      fs.unlinkSync(outFile);
    } catch (_) {}
  }
}

function cleanupOldActivity(now = Date.now()) {
  ensureLogDir();
  const cutoff = now - KEEP_HOURS * 3600 * 1000;
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const file = path.join(LOG_DIR, name);
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    const kept = [];
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        if ((Number(o.ts) || 0) >= cutoff) kept.push(line);
      } catch (_) {}
    }
    if (!kept.length) {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
    } else if (kept.length !== lines.length) {
      fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
    }
  }
}

function appendActivityLog(partial) {
  ensureLogDir();
  cleanupOldActivity();
  const now = new Date();
  const entry = {
    ts: Date.now(),
    time: localTimeHM(now),
    date: localDateISO(now),
    app: String((partial && partial.app) || "unknown").slice(0, 64),
    title: scrubTitle((partial && partial.title) || ""),
    source: "pc",
  };
  fs.appendFileSync(
    logPathForDate(entry.date),
    JSON.stringify(entry) + "\n",
    "utf8"
  );
  return entry;
}

function readRecentActivity(hours = KEEP_HOURS) {
  ensureLogDir();
  const cutoff = Date.now() - Math.max(0.1, Number(hours) || KEEP_HOURS) * 3600 * 1000;
  const out = [];
  for (const name of fs.readdirSync(LOG_DIR).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    let lines;
    try {
      lines = fs.readFileSync(path.join(LOG_DIR, name), "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if ((Number(o.ts) || 0) >= cutoff) out.push(o);
      } catch (_) {}
    }
  }
  out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return out;
}

/**
 * 近 windowMin 分钟摘要，最多 maxLines 条（按时长权重）。
 */
function summarizeActivity(windowMin = 60, maxLines = 6) {
  const win = Math.max(5, Math.min(180, Math.floor(Number(windowMin) || 60)));
  const cap = Math.max(1, Math.min(20, Math.floor(Number(maxLines) || 6)));
  const since = Date.now() - win * 60 * 1000;
  const rows = readRecentActivity(win / 60 + 0.1).filter(
    (e) => (Number(e.ts) || 0) >= since
  );
  if (!rows.length) {
    return { ok: true, lines: [], text: "", window_min: win, samples: 0 };
  }
  /** @type {Map<string, { app: string, title: string, n: number, last: number }>} */
  const map = new Map();
  for (const e of rows) {
    const app = String(e.app || "unknown");
    const title = String(e.title || "");
    const key = app + "\0" + title;
    const cur = map.get(key) || { app, title, n: 0, last: 0 };
    cur.n += 1;
    cur.last = Math.max(cur.last, Number(e.ts) || 0);
    map.set(key, cur);
  }
  const ranked = Array.from(map.values()).sort(
    (a, b) => b.n - a.n || b.last - a.last
  );
  const lines = ranked.slice(0, cap).map((r) => {
    const mins = Math.max(1, Math.round((r.n * SAMPLE_SEC) / 60));
    const lab = r.title ? r.app + " · " + r.title : r.app;
    return `约${mins}分 ${lab}`;
  });
  return {
    ok: true,
    lines,
    text: lines.join("\n"),
    window_min: win,
    samples: rows.length,
  };
}

function tickSample() {
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    if (!readSettings().activity_enabled) return null;
  } catch {
    return null;
  }
  const s = sampleForeground();
  if (!s.ok) return null;
  const key = s.app + "\0" + s.title;
  if (key === lastSampleKey) {
    /* 同一前台也记一条，方便算时长；也可跳过——教程是持续采样 */
  }
  lastSampleKey = key;
  return appendActivityLog({ app: s.app, title: s.title });
}

function stopActivityLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

function restartActivityLoop() {
  stopActivityLoop();
  let enabled = false;
  try {
    const { readSettings } = require("../../共读app/gateway/settings");
    enabled = !!readSettings().activity_enabled;
  } catch {
    enabled = false;
  }
  if (!enabled || process.platform !== "win32") {
    return { ok: true, running: false };
  }
  tickSample();
  loopTimer = setInterval(() => {
    try {
      tickSample();
    } catch (_) {}
  }, SAMPLE_SEC * 1000);
  return { ok: true, running: true, interval_sec: SAMPLE_SEC };
}

function getActivityStatus() {
  let enabled = false;
  try {
    enabled = !!require("../../共读app/gateway/settings").readSettings()
      .activity_enabled;
  } catch (_) {}
  const sum = summarizeActivity(60, 6);
  return {
    ok: true,
    enabled,
    running: !!loopTimer,
    platform: process.platform,
    keep_hours: KEEP_HOURS,
    sample_sec: SAMPLE_SEC,
    recent_summary: sum.text,
    samples_60m: sum.samples,
  };
}

function selfCheck() {
  console.assert(scrubTitle("a".repeat(100)).endsWith("…"));
  console.assert(scrubTitle("请输入密码").includes("隐私"));
  ensureLogDir();
  const day = localDateISO();
  const file = logPathForDate(day);
  const marker = "v4-self-" + Date.now();
  fs.appendFileSync(
    file,
    JSON.stringify({
      ts: Date.now(),
      time: localTimeHM(),
      date: day,
      app: "selfcheck",
      title: marker,
      source: "pc",
    }) + "\n",
    "utf8"
  );
  const recent = readRecentActivity(1);
  console.assert(recent.some((e) => e.title === marker));
  const sum = summarizeActivity(60, 6);
  console.assert(sum.ok && sum.samples >= 1);
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const kept = lines.filter((l) => !l.includes(marker));
    fs.writeFileSync(
      file,
      kept.length ? kept.join("\n") + "\n" : "",
      "utf8"
    );
  } catch (_) {}
  console.log("activity self-check ok");
}

if (require.main === module) {
  selfCheck();
  const s = sampleForeground();
  console.log("sample", s);
}

module.exports = {
  SAMPLE_SEC,
  KEEP_HOURS,
  sampleForeground,
  scrubTitle,
  appendActivityLog,
  readRecentActivity,
  summarizeActivity,
  tickSample,
  restartActivityLoop,
  stopActivityLoop,
  getActivityStatus,
  selfCheck,
};
