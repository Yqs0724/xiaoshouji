/**
 * V1 Sentinel/Core：定时截主屏 → 轻量模型 JSON 是否唤醒 → Core 写一条家机主动话。
 * H5 Presence 骰子：同循环掷骰 → 动态 → 日程便笺 → 开口（不依赖截屏）。
 * 默认关；截图失败则纯文本态仍可跑哨兵。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_PATH = path.join(DATA_DIR, "presence-state.json");

const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_COOLDOWN_MIN = 30;
const DEFAULT_MAX_WAKE_DAY = 8;
const DEFAULT_DICE_CHANCE = 0.35;
/** 自动发动态最短间隔（毫秒） */
const MOMENTS_GAP_MS = 4 * 60 * 60 * 1000;
const CAPTURE_MAX_W = 1280;

const DICE_MOMENT_LINES = [
  "今天也想你了一下。",
  "窗外光很好，随便记一笔。",
  "在忙什么呢，我先贴一句。",
  "路过日历，想起你。",
  "浅浅冒个泡～",
];

let loopTimer = null;
let tickBusy = false;
let firstKickTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyState() {
  return {
    last_tick_at: 0,
    last_wake_at: 0,
    wake_day: "",
    wake_count: 0,
    last_reason: "",
    last_error: "",
    last_capture_ok: false,
    running: false,
    last_dice_kind: "",
    last_dice_at: 0,
    last_moments_at: 0,
  };
}

function clampChance(n, fallback = DEFAULT_DICE_CHANCE) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0.05, Math.min(1, x));
}

function markWake(patch = {}) {
  const day = localDateISO();
  const prev = readState();
  const wake_count = prev.wake_day === day ? (prev.wake_count || 0) + 1 : 1;
  return writeState({
    last_wake_at: Date.now(),
    wake_day: day,
    wake_count,
    ...patch,
  });
}

/** 今日 + 明日行程（有标题的） */
function listNearbyEvents(now = new Date()) {
  const { listEvents, localDateISO: calDay } = require(
    "../../日历app/gateway/calendar"
  );
  const today = calDay(now);
  const tomorrow = calDay(new Date(now.getTime() + 86400000));
  const a = (listEvents({ date: today }).events || []).map((e) => ({
    ...e,
    _day: today,
  }));
  const b = (listEvents({ date: tomorrow }).events || []).map((e) => ({
    ...e,
    _day: tomorrow,
  }));
  return a.concat(b).filter((e) => e && String(e.title || "").trim());
}

/**
 * H5：掷骰后的优先级链。
 * @param {{ force?: boolean, forceKind?: 'moments'|'cal_sticky'|'poke', roll?: number }} opts
 */
function runPresenceDiceTick(opts = {}) {
  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const force = !!opts.force;
  if (!force && !settings.presence_dice_enabled) {
    return { ok: true, skipped: "disabled" };
  }
  const state = readState();
  const gate = gateAllowsWake(settings, state, force);
  if (!gate.ok) {
    writeState({ last_tick_at: Date.now(), last_error: "" });
    return { ok: true, skipped: gate.skip };
  }

  const chance = clampChance(settings.presence_dice_chance);
  const roll =
    opts.roll != null && Number.isFinite(Number(opts.roll))
      ? Number(opts.roll)
      : Math.random();
  if (!force && roll >= chance) {
    writeState({ last_tick_at: Date.now(), last_error: "" });
    return { ok: true, rolled: false, chance, roll };
  }

  const forceKind = String(opts.forceKind || "").trim();

  try {
    const { appendMonitorLog } = require("./monitor-log");

    /* 1) 社交圈动态 */
    if (
      (!forceKind || forceKind === "moments") &&
      settings.presence_dice_moments !== false
    ) {
      const gapOk =
        force ||
        !state.last_moments_at ||
        Date.now() - state.last_moments_at >= MOMENTS_GAP_MS;
      if (gapOk) {
        const { createPost } = require("./moments");
        const line =
          DICE_MOMENT_LINES[
            Math.floor(Math.random() * DICE_MOMENT_LINES.length)
          ];
        const posted = createPost({
          text: line,
          author: "bot",
          name: "家机",
          scope: "public",
        });
        markWake({
          last_tick_at: Date.now(),
          last_dice_at: Date.now(),
          last_dice_kind: "moments",
          last_moments_at: Date.now(),
          last_reason: "dice:moments",
          last_error: "",
        });
        appendMonitorLog({
          kind: "presence_dice",
          monitoringlog: "骰子·发动态：" + line.slice(0, 40),
          call_core: false,
          woke: true,
          dice_kind: "moments",
        });
        return {
          ok: true,
          rolled: true,
          kind: "moments",
          post: posted.post,
          chance,
          roll,
        };
      }
      if (forceKind === "moments") {
        return { ok: true, skipped: "moments_gap", chance, roll };
      }
    }

    /* 2) 临近日程 + 留笺 + 开口提醒 */
    if (!forceKind || forceKind === "cal_sticky") {
      const near = listNearbyEvents();
      if (near.length) {
        const ev = near[0];
        const { createNote } = require("../../日历app/gateway/calendar");
        const body =
          "记得「" + String(ev.title).trim().slice(0, 24) + "」哦";
        const note = createNote({
          body,
          date: ev._day || ev.date,
          owner: "companion",
          event_id: ev.id,
        }).note;
        const {
          appendMessage,
          withPeer,
          DEFAULT_PEER_ID,
          unreadCount,
        } = require("./daily-chat");
        const tip =
          "提醒你一下：" +
          (ev._day || ev.date) +
          " 有「" +
          String(ev.title).trim().slice(0, 24) +
          "」，我贴便签了。";
        const message = withPeer(DEFAULT_PEER_ID, () =>
          appendMessage("bot", tip, "text", { source: "presence_dice" })
        );
        markWake({
          last_tick_at: Date.now(),
          last_dice_at: Date.now(),
          last_dice_kind: "cal_sticky",
          last_reason: "dice:cal_sticky",
          last_error: "",
        });
        appendMonitorLog({
          kind: "presence_dice",
          monitoringlog: "骰子·日程便笺：" + String(ev.title).slice(0, 40),
          call_core: false,
          woke: true,
          dice_kind: "cal_sticky",
        });
        return {
          ok: true,
          rolled: true,
          kind: "cal_sticky",
          note,
          event: { id: ev.id, title: ev.title, date: ev._day || ev.date },
          message,
          count: withPeer(DEFAULT_PEER_ID, () => unreadCount().count),
          chance,
          roll,
        };
      }
      if (forceKind === "cal_sticky") {
        return { ok: true, skipped: "no_nearby_events", chance, roll };
      }
    }

    /* 3) 主动开口（复用 poke） */
    if (!forceKind || forceKind === "poke") {
      const { pokeDaily, withPeer, DEFAULT_PEER_ID, unreadCount } = require(
        "./daily-chat"
      );
      const poked = withPeer(DEFAULT_PEER_ID, () => pokeDaily({}));
      if (!poked.poked) {
        writeState({ last_tick_at: Date.now() });
        return { ok: true, skipped: "poke_cap", chance, roll };
      }
      markWake({
        last_tick_at: Date.now(),
        last_dice_at: Date.now(),
        last_dice_kind: "poke",
        last_reason: "dice:poke",
        last_error: "",
      });
      appendMonitorLog({
        kind: "presence_dice",
        monitoringlog:
          "骰子·开口：" +
          String((poked.message && poked.message.body) || "").slice(0, 40),
        call_core: false,
        woke: true,
        dice_kind: "poke",
      });
      return {
        ok: true,
        rolled: true,
        kind: "poke",
        message: poked.message,
        count: withPeer(DEFAULT_PEER_ID, () => unreadCount().count),
        chance,
        roll,
      };
    }

    writeState({ last_tick_at: Date.now() });
    return { ok: true, skipped: "no_action", chance, roll };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    writeState({ last_tick_at: Date.now(), last_error: msg });
    return { ok: false, error: "dice_failed", message: msg };
  }
}

function readState() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

function writeState(patch) {
  ensureDataDir();
  const next = { ...readState(), ...patch };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function localDateISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  }
  return !!v;
}

function clampInt(n, lo, hi, fallback) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 从模型输出里抠决策。
 * 对齐 AionsHome：call_core / monitoringlog / core_reason；并兼容 wake / reason / hint。
 */
function parseWakeDecision(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return { wake: false, reason: "empty", hint: "", monitoringlog: "" };
  }
  let s = text;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) s = brace[0];
  try {
    const j = JSON.parse(s);
    const wake = !!(j.wake || j.call_core);
    const reason = String(
      j.core_reason || j.reason || ""
    )
      .trim()
      .slice(0, 200);
    const hint = String(j.hint || j.say || j.core_reason || "").trim().slice(0, 300);
    const monitoringlog = String(
      j.monitoringlog || j.summary || reason || ""
    )
      .trim()
      .slice(0, 500);
    return { wake, reason, hint, monitoringlog };
  } catch {
    const wake =
      /\b"(?:wake|call_core)"\s*:\s*true\b/i.test(text) ||
      /\b(?:wake|call_core)\s*[:=]\s*true\b/i.test(text);
    return {
      wake,
      reason: "parse_fallback",
      hint: text.slice(0, 120),
      monitoringlog: text.slice(0, 200),
    };
  }
}

/**
 * 截主屏 → jpeg base64。失败不抛，返回 { ok:false }。
 * ponytail: Win 用 Forms.CopyFromScreen；非 Win / 无桌面则走文本态。要跨平台再加 mac screencapture。
 */
function capturePrimaryScreen() {
  if (process.platform !== "win32") {
    return {
      ok: false,
      error: "unsupported_platform",
      platform: process.platform,
    };
  }
  const stamp = Date.now();
  /* 出图写到项目 data（ASCII 路径），避免 %TEMP% 中文用户名经 stdout 编码烂掉 */
  ensureDataDir();
  const outPath = path.join(DATA_DIR, `sentinel-cap-${stamp}.png`);
  const ps1 = path.join(DATA_DIR, `sentinel-cap-${stamp}.ps1`);
  const outLit = outPath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$outPath = '${outLit}'
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$maxW = ${CAPTURE_MAX_W}
if ($bmp.Width -gt $maxW) {
  $nh = [int]($bmp.Height * ($maxW / [double]$bmp.Width))
  $scaled = New-Object System.Drawing.Bitmap $bmp, $maxW, $nh
  $bmp.Dispose()
  $bmp = $scaled
}
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
  try {
    fs.writeFileSync(ps1, "\uFEFF" + script, "utf8");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      { timeout: 20000, windowsHide: true }
    );
    if (!fs.existsSync(outPath)) {
      return { ok: false, error: "capture_missing_file" };
    }
    const buf = fs.readFileSync(outPath);
    if (!buf.length) return { ok: false, error: "capture_empty" };
    return {
      ok: true,
      mime: "image/png",
      base64: buf.toString("base64"),
      bytes: buf.length,
    };
  } catch (e) {
    return {
      ok: false,
      error: "capture_failed",
      message: String((e && e.message) || e).slice(0, 200),
    };
  } finally {
    try {
      fs.unlinkSync(ps1);
    } catch (_) {}
    try {
      fs.unlinkSync(outPath);
    } catch (_) {}
  }
}

function recentChatLines(limit = 8) {
  try {
    const { listMessages, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
    const msgs = withPeer(DEFAULT_PEER_ID, () => listMessages().messages) || [];
    return msgs
      .slice(-limit)
      .map((m) => {
        const who = m.from === "bot" ? "家机" : "对方";
        const body = String(m.body || "").replace(/\s+/g, " ").trim().slice(0, 80);
        return `${who}: ${body || "[" + (m.kind || "msg") + "]"}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function askSentinel({ capture, model, chatCompletion }) {
  const system =
    "你是陪伴 AI 的哨兵（轻量观察者）。根据屏幕/状态判断是否值得唤醒主脑去主动找用户说话。" +
    "只输出一个 JSON 对象，不要 markdown。字段对齐：" +
    "call_core(boolean)、monitoringlog(string 客观观察)、core_reason(string 若唤醒)、hint(string 给主脑的短提示)。" +
    "也接受 wake/reason 作别名。" +
    "规则：对方正在和你聊天、在开会/打字输入框、看隐私内容、锁屏/空桌面无聊场景 → call_core=false；" +
    "对方明显在摸鱼发呆、卡住报错、深夜还亮着无聊页面、或画面里有可关心的小事件 → 才可 call_core=true。" +
    "monitoringlog 只写客观所见，禁止胡编；hint 不要写成对用户的成品消息。";
  const statusText = capture.ok
    ? "已附主屏截图（可能含隐私，只做是否唤醒判断）。"
    : `无截图（${capture.error || "unknown"}）。仅根据时间与近期对话判断；没有强信号就 wake=false。`;
  let activityBlock = "";
  try {
    const { summarizeActivity } = require("./activity");
    const sum = summarizeActivity(60, 6);
    activityBlock = sum.text
      ? `\n近${sum.window_min}分钟 PC 前台（约每分钟采样）：\n${sum.text}`
      : "\n近60分钟 PC 前台：暂无采样。";
  } catch (_) {
    activityBlock = "";
  }
  const recent = recentChatLines();
  const textBlock =
    statusText +
    "\n当前时间：" +
    new Date().toISOString() +
    activityBlock +
    "\n近期对话：\n" +
    (recent || "（无）");

  const userContent = capture.ok
    ? [
        { type: "text", text: textBlock },
        {
          type: "image_url",
          image_url: {
            url: `data:${capture.mime};base64,${capture.base64}`,
          },
        },
      ]
    : textBlock;

  const out = await chatCompletion({
    system,
    messages: [{ role: "user", content: userContent }],
    think: false,
    replyKind: "chat",
    model: model || undefined,
  });
  return parseWakeDecision(out && out.content);
}

/** 主脑若把哨兵 JSON 当回复，换成口语短讯 */
function sanitizeCoreReply(raw, decision) {
  let t = String(raw || "").trim();
  if (!t) return "";
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const looksJson =
    /^\s*\{/.test(t) &&
    /"(?:wake|call_core|monitoringlog|core_reason|reason|hint)"\s*:/.test(t);
  if (looksJson) {
    return "在干嘛呢？";
  }
  /* 去掉误贴在开头的整段 JSON */
  if (t[0] === "{") {
    const end = t.indexOf("}");
    if (end > 0 && end < 400) {
      const rest = t.slice(end + 1).trim();
      if (rest) return rest.slice(0, 400);
      return "在干嘛呢？";
    }
  }
  return t.slice(0, 400);
}

async function askCore({ decision, model, chatCompletion }) {
  const { readSettings, resolveAppPersona } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const resolved = resolveAppPersona("chat", settings);
  const card = String((resolved && resolved.persona_card) || "").trim();
  let system =
    "你是同居室友「家机」。现在是你主动找对方说话（对方没有新发消息）。" +
    "语气像室友短信：一两句口语，短、轻松。不要提监控、截图或系统字样。不要长篇。" +
    "禁止输出 JSON、代码块或 wake/call_core 字段；只输出要发给对方的一句人话。";
  if (card) system += "\n人设（请遵守，勿整段复述）：\n" + card.slice(0, 2000);
  const nameBot = String(settings.name_bot || "").trim();
  if (nameBot) system += "\n你的显示名：" + nameBot + "。";
  try {
    const { maybeSilentPrefetch } = require("./phone-presence");
    const silent = maybeSilentPrefetch(settings);
    if (silent) system += "\n" + silent;
  } catch (_) {
    /* 查岗可选 */
  }
  const recent = recentChatLines(6);
  const user =
    "（以下仅供你了解情况，不要复述、不要输出 JSON）\n观察原因：" +
    (decision.reason || "（无）") +
    "\n可聊提示：" +
    (decision.hint || "随便关心一下对方在干嘛") +
    "\n近期对话：\n" +
    (recent || "（无）") +
    "\n请直接输出要发给对方的一条短讯正文（纯中文口语）。";
  const out = await chatCompletion({
    system,
    user,
    think: false,
    replyKind: "chat",
    model: model || undefined,
  });
  const { parseThinkBody } = require("../../共读app/gateway/llm");
  const parsed = parseThinkBody((out && out.content) || "", false);
  return sanitizeCoreReply(
    (parsed && parsed.body) || (out && out.content) || "",
    decision
  );
}

/** 解析 HH:MM → 当日分钟数；失败用 fallbackMin */
function hmToMinutes(raw, fallbackMin) {
  const m = String(raw == null ? "" : raw)
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMin;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return h * 60 + min;
}

/**
 * 安静时段内不截屏、不唤醒（可跨午夜；起止相同视为未启用窗口）。
 * @param {object} settings
 * @param {Date} [now]
 */
function inQuietHours(settings, now = new Date()) {
  if (!settings || !settings.sentinel_quiet_enabled) return false;
  const start = hmToMinutes(settings.sentinel_quiet_start, 23 * 60);
  const end = hmToMinutes(settings.sentinel_quiet_end, 8 * 60);
  if (start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function gateAllowsWake(settings, state, force, now) {
  if (force) return { ok: true };
  if (inQuietHours(settings, now || new Date())) {
    return { ok: false, skip: "quiet_hours" };
  }
  const day = localDateISO();
  const count = state.wake_day === day ? state.wake_count || 0 : 0;
  const max = clampInt(
    settings.sentinel_max_wake_day,
    1,
    40,
    DEFAULT_MAX_WAKE_DAY
  );
  if (count >= max) return { ok: false, skip: "day_cap" };
  const coolMin = clampInt(
    settings.sentinel_cooldown_min,
    5,
    240,
    DEFAULT_COOLDOWN_MIN
  );
  if (state.last_wake_at && Date.now() - state.last_wake_at < coolMin * 60 * 1000) {
    return { ok: false, skip: "cooldown" };
  }
  try {
    const { unreadCount, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
    const n = withPeer(DEFAULT_PEER_ID, () => unreadCount().count);
    if (n > 0) return { ok: false, skip: "unread_pending" };
  } catch (_) {}
  return { ok: true };
}

/**
 * @param {{ force?: boolean, skipCapture?: boolean, chatCompletion?: Function }} opts
 */
async function runSentinelTick(opts = {}) {
  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const force = !!opts.force;
  if (!force && !settings.sentinel_enabled) {
    return { ok: true, skipped: "disabled" };
  }
  if (tickBusy) return { ok: true, skipped: "busy" };
  tickBusy = true;
  const state = readState();
  try {
    const gate = gateAllowsWake(settings, state, force);
    if (!gate.ok) {
      writeState({ last_tick_at: Date.now(), last_error: "" });
      return { ok: true, skipped: gate.skip };
    }

    if (!opts.skipCapture) {
      try {
        require("../../共读app/gateway/ws-hub").broadcastMonitorAlert(
          "哨兵即将查看屏幕",
          { kind: "sentinel" }
        );
      } catch (_) {}
    }
    const capture = opts.skipCapture
      ? { ok: false, error: "skip_capture" }
      : capturePrimaryScreen();

    const { chatCompletion } =
      opts.chatCompletion
        ? { chatCompletion: opts.chatCompletion }
        : require("../../共读app/gateway/llm");
    const model =
      String(settings.sentinel_model || "").trim() || undefined;

    let decision;
    try {
      decision = await askSentinel({ capture, model, chatCompletion });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      writeState({
        last_tick_at: Date.now(),
        last_capture_ok: !!capture.ok,
        last_error: msg,
      });
      return { ok: false, error: "sentinel_llm", message: msg, capture_ok: !!capture.ok };
    }

    writeState({
      last_tick_at: Date.now(),
      last_capture_ok: !!capture.ok,
      last_reason: decision.reason || "",
      last_error: "",
    });

    const { appendMonitorLog } = require("./monitor-log");
    appendMonitorLog({
      kind: "sentinel",
      monitoringlog:
        decision.monitoringlog ||
        decision.reason ||
        (capture.ok ? "已观察主屏" : "无截图·文本态"),
      call_core: !!decision.wake,
      core_reason: decision.reason || "",
      capture_ok: !!capture.ok,
      woke: false,
    });

    if (!decision.wake) {
      return {
        ok: true,
        woke: false,
        decision,
        capture_ok: !!capture.ok,
      };
    }

    let text;
    try {
      text = await askCore({ decision, model, chatCompletion });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      writeState({ last_error: msg });
      appendMonitorLog({
        kind: "core_fail",
        monitoringlog: "Core 唤醒失败：" + msg,
        call_core: true,
        core_reason: decision.reason || "",
        capture_ok: !!capture.ok,
        woke: false,
      });
      return { ok: false, error: "core_llm", message: msg, decision };
    }
    if (!text) {
      return { ok: true, woke: false, decision, reason: "core_empty" };
    }

    const { appendMessage, withPeer, DEFAULT_PEER_ID, unreadCount } = require(
      "./daily-chat"
    );
    const message = withPeer(DEFAULT_PEER_ID, () =>
      appendMessage("bot", text, "text", { source: "sentinel" })
    );
    markWake({ last_reason: decision.reason || "" });
    appendMonitorLog({
      kind: "core_wake",
      monitoringlog: "Core 已唤醒并回复：" + text.slice(0, 80),
      call_core: true,
      core_reason: decision.reason || "",
      capture_ok: !!capture.ok,
      woke: true,
    });
    return {
      ok: true,
      woke: true,
      decision,
      message,
      capture_ok: !!capture.ok,
      count: withPeer(DEFAULT_PEER_ID, () => unreadCount().count),
    };
  } finally {
    tickBusy = false;
  }
}

function getPresenceStatus() {
  const { readSettings } = require("../../共读app/gateway/settings");
  const s = readSettings();
  const st = readState();
  return {
    ok: true,
    enabled: !!s.sentinel_enabled,
    dice_enabled: !!s.presence_dice_enabled,
    dice_chance: clampChance(s.presence_dice_chance),
    dice_moments: s.presence_dice_moments !== false,
    interval_min: clampInt(
      s.sentinel_interval_min,
      5,
      120,
      DEFAULT_INTERVAL_MIN
    ),
    cooldown_min: clampInt(
      s.sentinel_cooldown_min,
      5,
      240,
      DEFAULT_COOLDOWN_MIN
    ),
    max_wake_day: clampInt(
      s.sentinel_max_wake_day,
      1,
      40,
      DEFAULT_MAX_WAKE_DAY
    ),
    model: String(s.sentinel_model || "").trim(),
    loop: !!loopTimer,
    activity_enabled: !!s.activity_enabled,
    quiet_enabled: !!s.sentinel_quiet_enabled,
    quiet_start: String(s.sentinel_quiet_start || ""),
    quiet_end: String(s.sentinel_quiet_end || ""),
    in_quiet: inQuietHours(s),
    ...st,
  };
}

/** 间隔心跳：骰子优先；未掷中或未开骰子再跑哨兵 */
async function runPresenceHeartbeat(opts = {}) {
  const { readSettings } = require("../../共读app/gateway/settings");
  const settings = readSettings();
  const force = !!opts.force;
  let dice = null;
  if (force || settings.presence_dice_enabled) {
    dice = runPresenceDiceTick(opts);
    /* 掷中并落地 → 本拍不再截屏 */
    if (dice && dice.kind) return { ok: true, path: "dice", dice };
  }
  if (force || settings.sentinel_enabled) {
    const sentinel = await runSentinelTick(opts);
    return { ok: true, path: "sentinel", dice, sentinel };
  }
  return {
    ok: true,
    path: "idle",
    dice: dice || { ok: true, skipped: "disabled" },
  };
}

function stopPresenceLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (firstKickTimer) {
    clearTimeout(firstKickTimer);
    firstKickTimer = null;
  }
  writeState({ running: false });
}

function restartPresenceLoop() {
  stopPresenceLoop();
  const { readSettings } = require("../../共读app/gateway/settings");
  const s = readSettings();
  if (!s.sentinel_enabled && !s.presence_dice_enabled) {
    return { ok: true, running: false };
  }
  const min = clampInt(s.sentinel_interval_min, 5, 120, DEFAULT_INTERVAL_MIN);
  const ms = min * 60 * 1000;
  loopTimer = setInterval(() => {
    runPresenceHeartbeat({}).catch((e) => {
      writeState({
        last_error: String((e && e.message) || e).slice(0, 200),
      });
    });
  }, ms);
  /* 启动后约 45s 先踢一脚，免得干等一整格间隔 */
  firstKickTimer = setTimeout(() => {
    firstKickTimer = null;
    runPresenceHeartbeat({}).catch(() => {});
  }, 45_000);
  writeState({ running: true });
  return {
    ok: true,
    running: true,
    interval_min: min,
    dice: !!s.presence_dice_enabled,
    sentinel: !!s.sentinel_enabled,
  };
}

async function selfCheck() {
  const d1 = parseWakeDecision('{"wake":true,"reason":"发呆","hint":"问问"}');
  console.assert(d1.wake === true && d1.reason === "发呆");
  const d2 = parseWakeDecision("```json\n{\"wake\":false,\"reason\":\"开会\"}\n```");
  console.assert(d2.wake === false);
  const dAion = parseWakeDecision(
    '{"call_core":true,"monitoringlog":"在摸鱼","core_reason":"该问问","hint":"问问"}'
  );
  console.assert(dAion.wake === true && dAion.monitoringlog === "在摸鱼");
  const d3 = parseWakeDecision("not json wake: true maybe");
  console.assert(typeof d3.wake === "boolean");
  console.assert(clampInt(3, 5, 10, 7) === 5);
  console.assert(clampInt(99, 5, 10, 7) === 10);
  console.assert(parseBool("on") === true && parseBool(false) === false);
  const qOn = {
    sentinel_quiet_enabled: true,
    sentinel_quiet_start: "23:00",
    sentinel_quiet_end: "08:00",
  };
  console.assert(inQuietHours(qOn, new Date(2026, 0, 1, 23, 30)) === true);
  console.assert(inQuietHours(qOn, new Date(2026, 0, 1, 3, 0)) === true);
  console.assert(inQuietHours(qOn, new Date(2026, 0, 1, 12, 0)) === false);
  console.assert(
    inQuietHours({ ...qOn, sentinel_quiet_enabled: false }, new Date(2026, 0, 1, 23, 30)) ===
      false
  );
  console.assert(
    gateAllowsWake(qOn, {}, false, new Date(2026, 0, 1, 23, 30)).skip ===
      "quiet_hours"
  );
  console.assert(
    gateAllowsWake(qOn, {}, true, new Date(2026, 0, 1, 23, 30)).ok === true
  );

  let calls = 0;
  const fakeLlm = async ({ system }) => {
    calls += 1;
    /* 哨兵 system 含「轻量观察者」；勿用「哨兵」二字匹配（主脑提示也可能提到） */
    if (String(system || "").includes("轻量观察者")) {
      return {
        content: JSON.stringify({
          wake: true,
          reason: "自检发呆",
          hint: "问一句在干嘛",
        }),
      };
    }
    return { content: "自检：在干嘛呢？" };
  };
  const out = await runSentinelTick({
    force: true,
    skipCapture: true,
    chatCompletion: fakeLlm,
  });
  console.assert(out.ok === true && out.woke === true && out.message, out);
  console.assert(calls === 2, "sentinel+core");
  console.assert(String(out.message.body || "").includes("自检"));
  console.assert(
    sanitizeCoreReply('{"wake":true,"reason":"发呆"}', {}).includes("在干嘛")
  );
  console.assert(sanitizeCoreReply("嗨，忙啥呢", {}) === "嗨，忙啥呢");
  try {
    const { readAll, writeAll, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
    const mid = out.message.id;
    withPeer(DEFAULT_PEER_ID, () => {
      const all = readAll();
      all.messages = (all.messages || []).filter((m) => m && m.id !== mid);
      writeAll(all);
    });
  } catch (_) {}

  console.assert(clampChance(0, 0.35) === 0.05);
  console.assert(clampChance(2) === 1);
  const miss = runPresenceDiceTick({ force: false, roll: 0.99 });
  console.assert(miss.skipped === "disabled" || miss.rolled === false || miss.ok);
  const pokeDice = runPresenceDiceTick({
    force: true,
    forceKind: "poke",
    roll: 0,
  });
  console.assert(pokeDice.ok && pokeDice.kind === "poke" && pokeDice.message, pokeDice);
  try {
    const { readAll, writeAll, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
    const mid = pokeDice.message && pokeDice.message.id;
    if (mid) {
      withPeer(DEFAULT_PEER_ID, () => {
        const all = readAll();
        all.messages = (all.messages || []).filter((m) => m && m.id !== mid);
        writeAll(all);
      });
    }
  } catch (_) {}
  const { createEvent, deleteEvent, deleteNote, localDateISO: calDay } = require(
    "../../日历app/gateway/calendar"
  );
  const day = calDay(new Date());
  const ev = createEvent({
    title: "H5骰子自检",
    date: day,
    owner: "companion",
  });
  /* 拉开动态间隔，强制走日程链 */
  writeState({ last_moments_at: Date.now() });
  const calDice = runPresenceDiceTick({
    force: true,
    forceKind: "cal_sticky",
    roll: 0,
  });
  console.assert(calDice.ok && calDice.kind === "cal_sticky" && calDice.note, calDice);
  if (calDice.note && calDice.note.id) deleteNote(calDice.note.id);
  if (ev.event && ev.event.id) deleteEvent(ev.event.id);
  try {
    const { readAll, writeAll, withPeer, DEFAULT_PEER_ID } = require("./daily-chat");
    const mid = calDice.message && calDice.message.id;
    if (mid) {
      withPeer(DEFAULT_PEER_ID, () => {
        const all = readAll();
        all.messages = (all.messages || []).filter((m) => m && m.id !== mid);
        writeAll(all);
      });
    }
  } catch (_) {}
  console.log("presence self-check ok");
}

if (require.main === module) {
  selfCheck()
    .then(() => {
      const cap = capturePrimaryScreen();
      console.log("capture", {
        ok: cap.ok,
        error: cap.error,
        bytes: cap.bytes,
        platform: process.platform,
      });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  capturePrimaryScreen,
  parseWakeDecision,
  sanitizeCoreReply,
  askCore,
  runSentinelTick,
  runPresenceDiceTick,
  runPresenceHeartbeat,
  listNearbyEvents,
  getPresenceStatus,
  restartPresenceLoop,
  stopPresenceLoop,
  inQuietHours,
  gateAllowsWake,
  selfCheck,
  parseBool,
  clampInt,
  clampChance,
  DEFAULT_INTERVAL_MIN,
  DEFAULT_COOLDOWN_MIN,
  DEFAULT_MAX_WAKE_DAY,
  DEFAULT_DICE_CHANCE,
  MOMENTS_GAP_MS,
};
