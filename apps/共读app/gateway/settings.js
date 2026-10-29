const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadEnv } = require("./load-env");

loadEnv();

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  weread_key: "",
  llm_base: "",
  llm_key: "",
  llm_model: "",
  /** 记忆向量模型（OpenAI 兼容 /embeddings）；空则只用关键词召回 */
  embed_model: "",
  /** 语音转写模型；空则 whisper-1 */
  asr_model: "",
  /** Fish Audio TTS（通话朗读）；空则前端用浏览器语音 */
  fish_api_key: "",
  fish_voice_id: "",
  /** 默认免费档模型；可改 s2.1-pro 等 */
  fish_tts_model: "s2.1-pro-free",
  /**
   * M3 语音条朗读语言：空=关；zh|en|ja|ko。
   * 气泡仍显示中文，条点播对应语言（非 zh 先译再 TTS）。
   */
  voice_bar_lang: "",
  /** M4 通话心跳：静默后 TA 主动开口；默认开 */
  call_heartbeat_enabled: true,
  /** 心跳基准秒 30–120；实际再随机 +0～30s */
  call_heartbeat_sec: 45,
  /** M4 主动来电：回复里 [[call:voice|video]] 可打来；骰子/poke 更易来电；默认关 */
  call_proactive_enabled: false,
  /** M5 视频通话仪式礼物；默认开（可关）；无支付 */
  call_gift_enabled: true,
  /**
   * 小屋底稿人设 = persona_card（一份长文）。
   * persona 仅兼容旧数据：卡空时回落；新写入请只写 persona_card。
   */
  persona: "",
  persona_card: "",
  /** 共读跟批是否注入人设卡（只影响共读，在共读「对话设置」里改） */
  persona_card_in_follow: false,
  /** 各 App 是否沿用小屋人设；缺省 true */
  persona_use_hut: { chat: true, coread: true },
  /** App 自有人设（对应开关关掉时用；真源是 persona_card） */
  persona_apps: {
    chat: { persona: "", persona_card: "" },
    coread: { persona: "", persona_card: "" },
  },
  /** 世界书总开关（默认关）；开后聊天按酒馆式扫描启用中的书 */
  worldbook_enabled: false,
  /** 扫描最近几条消息；0=只常驻 */
  worldbook_scan_depth: 4,
  /** 注入字预算；整条放不下则跳过，不截断条目 */
  worldbook_budget_chars: 6000,
  /** 跟批用短剧情摘要（一层文本；分层编辑器另开） */
  lore_summary: "",
  default_follow_mode: "immersive",
  default_follow_tone: "",
  default_budget_rmb: 0,
  door_locked: false,
  /** 访问门禁：scrypt 哈希；空=不启用（仍可用环境变量 CABIN_GATE） */
  gate_hash: "",
  gate_salt: "",
  name_user: "你",
  /** 网名（我/朋友圈展示；空则回落 name_user） */
  nick_user: "",
  name_bot: "熊",
  avatar_user: "/assets/cafe/avatar-you.png",
  avatar_bot: "/assets/cafe/avatar-bot.png",
  /** 共读顶栏是否显示时钟 */
  show_clock: true,
  /** 共读时间线消息滤镜：both | marks | follows */
  timeline_msg_filter: "both",
  /** 离开共读界面时自动暂停计时（跟批不停） */
  auto_pause_timer: true,
  /** @deprecated 已并入 annivs；读盘时迁入后清空 */
  meet_date: "",
  /** 纪念日列表（含原相识日）；桌面钉 pin_anniv_id 从中选一条 */
  annivs: [],
  pin_anniv_id: "",
  /** 桌面隐藏的 App id 列表；显隐不删业务数据 */
  app_hidden: [],
  /** M1 Desk 挂件：Token 环 / 便笺块（默认开） */
  desk_widget_token: true,
  desk_widget_sticky: true,
  /** 装饰摆件已撤；字段保留兼容旧备份 */
  desk_deco_enabled: false,
  /** @deprecated 摆件 UI 已撤；读盘仍归一化 */
  desk_decos: [],
  /** 自由桌面：[{ id, x, y, w? }]；空=出厂排布 */
  desk_layout: [],
  /** 日常聊天是否允许调用工具（日历等；网关内执行） */
  chat_tools_enabled: true,
  /** 工具显示名：{ function.name: "中文名" }；空则用内置默认 */
  chat_tool_labels: {},
  /** 外接 MCP（客户端）：开且填了 URL 后，以后可并入工具表 */
  mcp_enabled: false,
  mcp_url: "",
  mcp_token: "",
  /** 备用 MCP endpoint（主失败时试） */
  mcp_url_2: "",
  mcp_token_2: "",
  /** 保活心跳：约 5 分钟探测一次（仅启用 MCP 时） */
  mcp_heartbeat: false,
  /** H1.24：关掉的 MCP 远端工具名（remote name），不进 LLM 工具表 */
  mcp_tool_hidden: [],
  /** V1 Sentinel/Core：默认关；开后定时截主屏轻量判断是否主动找你 */
  sentinel_enabled: false,
  sentinel_interval_min: 15,
  sentinel_cooldown_min: 30,
  sentinel_max_wake_day: 8,
  /** 空=用 llm_model；可填更便宜的 flash 级 */
  sentinel_model: "",
  /** 安静时段：不截屏、不唤醒（可跨午夜） */
  sentinel_quiet_enabled: false,
  sentinel_quiet_start: "23:00",
  sentinel_quiet_end: "08:00",
  /** H5：定时推送骰子（动态→日程便笺→开口）；默认关；可与哨兵共用间隔/安静/日上限 */
  presence_dice_enabled: false,
  /** 每次检查掷中概率 0.05～1，默认 0.35 */
  presence_dice_chance: 0.35,
  /** 优先级链是否允许发朋友圈（仍受间隔约束） */
  presence_dice_moments: true,
  /** V4：PC 前台窗采样；默认关，仅本机 Win */
  activity_enabled: false,
  /** P0：查虚拟小手机壳（App/会话）；默认开，关则工具不进表 */
  peek_phone_enabled: true,
  /** P0：peek 是否带当前会话最近几条（L1）；默认关 */
  peek_phone_l1_enabled: false,
  /** P0：手机设备态（电量等）；默认开 */
  phone_device_enabled: true,
  /** H6 Auto Memory：「你对 TA 的了解」档案；默认关 */
  auto_memory_enabled: false,
  /** 静默：不注入档案，仍可工具写入（对方明确要求时） */
  auto_memory_mute: false,
  /** 注入字数预算 300–6000 */
  auto_memory_budget: 2000,
  /** H9：授权 TA 用工具参与朋友圈；默认关 */
  moments_ai_enabled: false,
  /** H9：auto=直接发；confirm=需你点同意 */
  moments_ai_mode: "confirm",
  /** H10：定位工具；默认关（隐私） */
  geo_tool_enabled: false,
  /** H10：天气工具；默认关 */
  weather_tool_enabled: false,
  /** H10：定位不可用时的手动城市兜底 */
  weather_city: "",
  /** IB D1：DIY 外部 HTTP 工具总开关 */
  diy_http_enabled: true,
  /** IB D1：自定义 HTTP 工具列表（name/url/method/params/confirm） */
  diy_http_tools: [],
  /** Cove 网易云：兼容 API 根地址（如 NeteaseCloudMusicApi :3000） */
  netease_api_base_url: "http://127.0.0.1:3000",
  /** 可选 Cookie / MUSIC_U=…；只存服务端，勿进 Git */
  netease_cookie: "",
  /** 音质偏好：exhigh / higher / standard … */
  netease_music_quality: "exhigh",
  /** 播放音量 0～1（共听 / 聊天卡） */
  music_volume: 0.8,
  /** 点歌优先：netease | apple | auto（有网易 API 则 netease） */
  music_provider: "netease",
};

/** 工具显示名 map；只留合法 name → 短文案 */
function normalizeChatToolLabels(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k || "").trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(name)) continue;
    const label = String(v == null ? "" : v).trim().slice(0, 32);
    if (label) out[name] = label;
  }
  return out;
}

const PERSONA_APPS = ["chat", "coread"];

function normalizePersonaUseHut(raw) {
  const out = { chat: true, coread: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const app of PERSONA_APPS) {
    if (Object.prototype.hasOwnProperty.call(raw, app)) out[app] = raw[app] !== false;
  }
  return out;
}

/** 卡优先；旧短人设仅在卡空时回落 */
function coalescePersonaCard(persona, card) {
  const c = String(card == null ? "" : card).trim();
  if (c) return c;
  return String(persona == null ? "" : persona).trim();
}

function normalizePersonaApps(raw) {
  const empty = () => ({ persona: "", persona_card: "" });
  const out = { chat: empty(), coread: empty() };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const app of PERSONA_APPS) {
    const src = raw[app];
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const card = coalescePersonaCard(src.persona, src.persona_card);
    out[app] = { persona: "", persona_card: card };
  }
  return out;
}

/** 解析某 App 当前该用的人设：沿用小屋 or App 自有（真源 persona_card） */
function resolveAppPersona(app, s) {
  const settings = s || readSettings();
  const key = PERSONA_APPS.includes(app) ? app : "chat";
  const use = normalizePersonaUseHut(settings.persona_use_hut);
  if (use[key] !== false) {
    const card = coalescePersonaCard(settings.persona, settings.persona_card);
    return { app: key, inherit: true, persona: "", persona_card: card };
  }
  const local = normalizePersonaApps(settings.persona_apps)[key] || {
    persona: "",
    persona_card: "",
  };
  return {
    app: key,
    inherit: false,
    persona: "",
    persona_card: String(local.persona_card || "").trim(),
  };
}

/** MCP 远端工具名列表；去重、截断 */
function normalizeMcpToolHidden(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item == null ? "" : item).trim().slice(0, 128);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 64) break;
  }
  return out;
}

/** DEMO 咖啡屋头像预设；另允许聊天上传 media / 静态 / http(s) */
const AVATAR_PRESETS = [
  "/assets/cafe/avatar-you.png",
  "/assets/cafe/avatar-bot.png",
  "/assets/cafe/decor-bear.png",
];

function normalizeAvatar(src, fallback) {
  const s = String(src || "").trim();
  if (AVATAR_PRESETS.includes(s)) return s;
  if (s.length > 512) return fallback || DEFAULTS.avatar_user;
  if (
    s.startsWith("/api/v1/chat/media/") ||
    s.startsWith("/assets/") ||
    /^https?:\/\//i.test(s)
  ) {
    return s;
  }
  return fallback || DEFAULTS.avatar_user;
}

/** 相识日：空或合法 YYYY-MM-DD */
function normalizeMeetDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error("相识日须为 YYYY-MM-DD");
    err.code = "bad_meet_date";
    throw err;
  }
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    const err = new Error("相识日不是有效日期");
    err.code = "bad_meet_date";
    throw err;
  }
  return s;
}

const ANNIV_MAX = 30; /* ponytail: 单页列表够用；升级=分页/独立库 */

function normalizeAnniv(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || "").trim().slice(0, 20);
  let date = "";
  try {
    date = normalizeMeetDate(raw.date || "");
  } catch {
    return null;
  }
  if (!title || !date) return null;
  const id = String(raw.id || "").trim() || randomUUID();
  return { id, title, date };
}

function normalizeAnnivs(v) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const a = normalizeAnniv(raw);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
    if (out.length >= ANNIV_MAX) break;
  }
  return out;
}

/** 读盘时整理纪念日；兼容旧 pin_day / meet_date */
function resolveAnnivState(file) {
  let annivs = normalizeAnnivs(file && file.annivs);
  let pin_anniv_id = String((file && file.pin_anniv_id) || "").trim();
  const legacy = file && file.pin_day;
  if (!annivs.length && legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const title = String(legacy.title || "").trim().slice(0, 20);
    let date = "";
    try {
      date = normalizeMeetDate(legacy.date || "");
    } catch {
      date = "";
    }
    if (title && date) {
      const id = randomUUID();
      annivs = [{ id, title, date }];
      pin_anniv_id = id;
    }
  }
  let meet = "";
  try {
    meet = normalizeMeetDate((file && file.meet_date) || "");
  } catch {
    meet = "";
  }
  if (meet && !annivs.some((a) => a.date === meet)) {
    annivs = [{ id: randomUUID(), title: "相识日", date: meet }, ...annivs];
  }
  if (pin_anniv_id && !annivs.some((a) => a.id === pin_anniv_id)) {
    pin_anniv_id = "";
  }
  return { annivs, pin_anniv_id, clear_meet_date: !!meet };
}

/** 可注册的桌面 App；settings 不可藏（否则改不回注册表） */
const APP_IDS = [
  "coread",
  "chat",
  "cal",
  "cowatch",
  "colisten",
  "comic",
  "cabin",
  "pet",
  "todo",
  "shop",
  "budget",
  "wallet",
  "memo",
  "ledger",
  "album",
  "eat",
  "map",
  "settings",
];
const APP_ALWAYS_VISIBLE = new Set(["settings"]);

const DESK_DECO_IDS = new Set([
  "bear",
  "croissant",
  "cupcake",
  "donut",
  "macaron",
  "flower",
  "stamp",
  "paw",
]);

/** 自由桌面布局；id=wid-*|app-* ；col/row 网格格点；page=0–2 */
function normalizeDeskLayout(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim().slice(0, 40);
    if (!id || seen.has(id)) continue;
    if (!/^(wid|app)-[a-z0-9_-]+$/i.test(id)) continue;
    let col = Number(item.col);
    let row = Number(item.row);
    /* 兼容旧版百分比 x/y */
    if (!Number.isFinite(col) && Number.isFinite(Number(item.x))) {
      col = Math.floor((Number(item.x) / 100) * 4);
    }
    if (!Number.isFinite(row) && Number.isFinite(Number(item.y))) {
      row = Math.floor((Number(item.y) / 100) * 6);
    }
    if (!Number.isFinite(col)) col = 0;
    if (!Number.isFinite(row)) row = 0;
    col = Math.max(0, Math.min(3, Math.floor(col)));
    row = Math.max(0, Math.min(11, Math.floor(row)));
    let page = Number(item.page);
    if (!Number.isFinite(page)) page = 0;
    page = Math.max(0, Math.min(2, Math.floor(page)));
    seen.add(id);
    out.push({ id, col, row, page });
    if (out.length >= 48) break;
  }
  return out;
}

/** M2：桌面摆件列表；最多 6；坐标 0–100 百分比 */
function normalizeDeskDecos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    if (!DESK_DECO_IDS.has(id) || seen.has(id)) continue;
    let x = Number(item.x);
    let y = Number(item.y);
    if (!Number.isFinite(x)) x = 50;
    if (!Number.isFinite(y)) y = 50;
    x = Math.max(0, Math.min(100, Math.round(x * 10) / 10));
    y = Math.max(0, Math.min(100, Math.round(y * 10) / 10));
    seen.add(id);
    out.push({ id, x, y });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeAppHidden(v) {
  const raw = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    const s = String(id || "").trim();
    if (!s || !APP_IDS.includes(s) || APP_ALWAYS_VISIBLE.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const FOLLOW_MODES = ["immersive", "ideas", "silent"];
/** 跟批语气：空=默认；short/ask/empathy */
const FOLLOW_TONES = ["", "short", "ask", "empathy"];

/** M3：语音条语言；空=关 */
function normalizeVoiceBarLang(raw) {
  const s = String(raw == null ? "" : raw)
    .trim()
    .toLowerCase();
  if (!s || s === "off" || s === "0" || s === "false") return "";
  if (s === "zh" || s === "zh-cn" || s === "cn") return "zh";
  if (s === "en" || s === "en-us" || s === "en-gb") return "en";
  if (s === "ja" || s === "jp" || s === "ja-jp") return "ja";
  if (s === "ko" || s === "kr" || s === "ko-kr") return "ko";
  return "";
}

function normalizeFollowMode(m) {
  const s = String(m || "").trim();
  return FOLLOW_MODES.includes(s) ? s : "immersive";
}

function normalizeFollowTone(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s || s === "default") return "";
  return FOLLOW_TONES.includes(s) ? s : "";
}

/** 场预算 ¥→token：跟当前 llm_model 价卡闲时混合单价（额度app deepseek-pricing） */
function tokensFromBudgetRmb(rmb) {
  const n = Number(rmb) || 0;
  if (n <= 0) return 0;
  const { blendRmbPerMOffFor } = require("../../额度app/gateway/deepseek-pricing");
  const model = String(readSettings().llm_model || "").trim() || "deepseek-flash";
  const perM = blendRmbPerMOffFor(model) || 1.75;
  return Math.round((n / perM) * 1e6);
}

function envSettings() {
  return {
    weread_key: process.env.WEREAD_API_KEY || process.env.WEREAD_KEY || "",
    llm_base: process.env.LLM_BASE || process.env.DEEPSEEK_BASE_URL || "",
    llm_key:
      process.env.LLM_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
    llm_model:
      process.env.LLM_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      "",
    persona: process.env.PERSONA || process.env.COREAD_PERSONA || "",
    persona_card: process.env.PERSONA_CARD || process.env.COREAD_PERSONA_CARD || "",
  };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULTS, null, 2), "utf8");
  }
}

/** 环境变量优先；未设的项再读 data/settings.json / 设定页 */
function readSettings() {
  ensureFile();
  let file = { ...DEFAULTS };
  try {
    file = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    /* keep defaults */
  }
  const env = envSettings();
  return {
    weread_key: (env.weread_key || file.weread_key || "").trim(),
    llm_base: (env.llm_base || file.llm_base || "").trim(),
    llm_key: (env.llm_key || file.llm_key || "").trim(),
    llm_model: (env.llm_model || file.llm_model || "").trim(),
    embed_model: String(
      file.embed_model || process.env.EMBED_MODEL || ""
    ).trim(),
    asr_model: String(file.asr_model || process.env.ASR_MODEL || "").trim(),
    fish_api_key: String(
      file.fish_api_key || process.env.FISH_API_KEY || ""
    ).trim(),
    fish_voice_id: String(
      file.fish_voice_id || process.env.FISH_VOICE_ID || ""
    ).trim(),
    fish_tts_model: String(
      file.fish_tts_model || process.env.FISH_TTS_MODEL || "s2.1-pro-free"
    ).trim() || "s2.1-pro-free",
    voice_bar_lang: normalizeVoiceBarLang(file.voice_bar_lang),
    call_heartbeat_enabled: file.call_heartbeat_enabled !== false,
    call_heartbeat_sec: (() => {
      const n = Math.floor(
        Number(
          file.call_heartbeat_sec != null
            ? file.call_heartbeat_sec
            : DEFAULTS.call_heartbeat_sec
        )
      );
      if (!Number.isFinite(n)) return 45;
      return Math.max(30, Math.min(120, n));
    })(),
    call_proactive_enabled: !!file.call_proactive_enabled,
    call_gift_enabled:
      file.call_gift_enabled === undefined || file.call_gift_enabled === null
        ? true
        : !!file.call_gift_enabled,
    persona: (env.persona || file.persona || "").trim(),
    persona_card: (env.persona_card || file.persona_card || "").trim(),
    persona_card_in_follow: !!file.persona_card_in_follow,
    persona_use_hut: normalizePersonaUseHut(file.persona_use_hut),
    persona_apps: normalizePersonaApps(file.persona_apps),
    worldbook_enabled: !!file.worldbook_enabled,
    worldbook_scan_depth: Math.max(
      0,
      Math.min(50, Number(file.worldbook_scan_depth) || 4)
    ),
    worldbook_budget_chars: Math.max(
      200,
      Math.min(50000, Number(file.worldbook_budget_chars) || 6000)
    ),
    lore_summary: String(file.lore_summary || "").trim(),
    default_follow_mode: normalizeFollowMode(file.default_follow_mode),
    default_follow_tone: normalizeFollowTone(file.default_follow_tone),
    default_budget_rmb: Math.max(0, Number(file.default_budget_rmb) || 0),
    door_locked: !!file.door_locked,
    gate_hash: String(file.gate_hash || "").trim(),
    gate_salt: String(file.gate_salt || "").trim(),
    name_user: String(file.name_user || DEFAULTS.name_user).trim() || DEFAULTS.name_user,
    nick_user: String(file.nick_user || "").trim().slice(0, 32),
    name_bot: String(file.name_bot || DEFAULTS.name_bot).trim() || DEFAULTS.name_bot,
    avatar_user: normalizeAvatar(file.avatar_user, DEFAULTS.avatar_user),
    avatar_bot: normalizeAvatar(file.avatar_bot, DEFAULTS.avatar_bot),
    show_clock: file.show_clock !== false,
    timeline_msg_filter: (() => {
      const v = String(file.timeline_msg_filter || "both").trim();
      return v === "marks" || v === "follows" ? v : "both";
    })(),
    auto_pause_timer: file.auto_pause_timer !== false,
    ...(() => {
      const a = resolveAnnivState(file);
      return {
        annivs: a.annivs,
        pin_anniv_id: a.pin_anniv_id,
        meet_date: "", /* 已并入 annivs */
      };
    })(),
    app_hidden: normalizeAppHidden(file.app_hidden),
    desk_widget_token: file.desk_widget_token !== false,
    desk_widget_sticky: file.desk_widget_sticky !== false,
    desk_deco_enabled: file.desk_deco_enabled === true,
    desk_decos: normalizeDeskDecos(file.desk_decos),
    desk_layout: normalizeDeskLayout(file.desk_layout),
    chat_tools_enabled: file.chat_tools_enabled !== false,
    chat_tool_labels: normalizeChatToolLabels(file.chat_tool_labels),
    mcp_enabled: !!file.mcp_enabled,
    mcp_url: String(file.mcp_url || "").trim(),
    mcp_token: String(file.mcp_token || "").trim(),
    mcp_url_2: String(file.mcp_url_2 || "").trim(),
    mcp_token_2: String(file.mcp_token_2 || "").trim(),
    mcp_heartbeat: !!file.mcp_heartbeat,
    mcp_tool_hidden: normalizeMcpToolHidden(file.mcp_tool_hidden),
    sentinel_enabled: !!file.sentinel_enabled,
    sentinel_interval_min: Math.max(
      5,
      Math.min(120, Math.floor(Number(file.sentinel_interval_min) || 15))
    ),
    sentinel_cooldown_min: Math.max(
      5,
      Math.min(240, Math.floor(Number(file.sentinel_cooldown_min) || 30))
    ),
    sentinel_max_wake_day: Math.max(
      1,
      Math.min(40, Math.floor(Number(file.sentinel_max_wake_day) || 8))
    ),
    sentinel_model: String(file.sentinel_model || "").trim(),
    sentinel_quiet_enabled: !!file.sentinel_quiet_enabled,
    sentinel_quiet_start: normalizeHm(
      file.sentinel_quiet_start,
      DEFAULTS.sentinel_quiet_start
    ),
    sentinel_quiet_end: normalizeHm(
      file.sentinel_quiet_end,
      DEFAULTS.sentinel_quiet_end
    ),
    presence_dice_enabled: !!file.presence_dice_enabled,
    presence_dice_chance: Math.max(
      0.05,
      Math.min(
        1,
        Number(file.presence_dice_chance) > 0
          ? Number(file.presence_dice_chance)
          : DEFAULTS.presence_dice_chance
      )
    ),
    presence_dice_moments: file.presence_dice_moments !== false,
    activity_enabled: !!file.activity_enabled,
    peek_phone_enabled: file.peek_phone_enabled !== false,
    peek_phone_l1_enabled: !!file.peek_phone_l1_enabled,
    phone_device_enabled: file.phone_device_enabled !== false,
    auto_memory_enabled: !!file.auto_memory_enabled,
    auto_memory_mute: !!file.auto_memory_mute,
    auto_memory_budget: Math.max(
      300,
      Math.min(
        6000,
        Math.floor(Number(file.auto_memory_budget) || 2000)
      )
    ),
    moments_ai_enabled: !!file.moments_ai_enabled,
    moments_ai_mode:
      String(file.moments_ai_mode || "confirm").toLowerCase() === "auto"
        ? "auto"
        : "confirm",
    geo_tool_enabled: !!file.geo_tool_enabled,
    weather_tool_enabled: !!file.weather_tool_enabled,
    weather_city: String(file.weather_city || "")
      .trim()
      .slice(0, 48),
    diy_http_enabled: file.diy_http_enabled !== false,
    diy_http_tools: (() => {
      try {
        const { normalizeDiyHttpTools } = require("../../聊天app/gateway/diy-http");
        return normalizeDiyHttpTools(file.diy_http_tools);
      } catch (_) {
        return [];
      }
    })(),
    netease_api_base_url: String(
      file.netease_api_base_url != null
        ? file.netease_api_base_url
        : DEFAULTS.netease_api_base_url
    )
      .trim()
      .replace(/\/+$/, ""),
    netease_cookie: sanitizeNeteaseCookie(file.netease_cookie || ""),
    netease_music_quality: String(
      file.netease_music_quality || DEFAULTS.netease_music_quality
    )
      .trim()
      .slice(0, 24),
    music_volume: (() => {
      const n = Number(file.music_volume);
      if (!Number.isFinite(n)) return DEFAULTS.music_volume;
      return Math.max(0, Math.min(1, n));
    })(),
    music_provider: ["netease", "apple", "auto"].includes(
      String(file.music_provider || "").trim()
    )
      ? String(file.music_provider).trim()
      : DEFAULTS.music_provider,
  };
}

/** @returns {string} HH:MM */
/**
 * 扫码/粘贴 Cookie 常混入 Set-Cookie 的 Expires/Path 等属性，既污染鉴权又占长度。
 * 只保留 name=value；同名后者覆盖。
 */
function sanitizeNeteaseCookie(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  const skip = new Set([
    "expires",
    "max-age",
    "path",
    "domain",
    "secure",
    "httponly",
    "samesite",
    "priority",
  ]);
  const map = new Map();
  for (const part of s.split(";")) {
    const p = part.trim();
    if (!p || !p.includes("=")) continue;
    const i = p.indexOf("=");
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (!k || skip.has(k.toLowerCase())) continue;
    map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

function normalizeHm(raw, fallback) {
  const fb = String(fallback || "00:00");
  const m = String(raw == null ? "" : raw)
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fb;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return (
    String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0")
  );
}

function writeSettings(next) {
  ensureFile();
  const merged = { ...DEFAULTS, ...next };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function patchSettings(patch) {
  ensureFile();
  let file = { ...DEFAULTS };
  try {
    file = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    /* keep */
  }
  const stringKeys = [
    "weread_key",
    "llm_base",
    "llm_key",
    "llm_model",
    "embed_model",
    "asr_model",
    "fish_api_key",
    "fish_voice_id",
    "fish_tts_model",
    "persona",
    "persona_card",
    "lore_summary",
    "gate_hash",
    "gate_salt",
    "name_user",
    "name_bot",
    "mcp_url",
    "mcp_token",
    "mcp_url_2",
    "mcp_token_2",
    "sentinel_model",
  ];
  let mcpTouched = false;
  for (const key of stringKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] === "string") {
      if (
        key === "mcp_url" ||
        key === "mcp_token" ||
        key === "mcp_url_2" ||
        key === "mcp_token_2"
      ) {
        mcpTouched = true;
      }
      file[key] = patch[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "chat_tools_enabled")) {
    const v = patch.chat_tools_enabled;
    if (typeof v === "boolean") file.chat_tools_enabled = v;
    else if (typeof v === "string") {
      file.chat_tools_enabled = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else file.chat_tools_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "chat_tool_labels")) {
    file.chat_tool_labels = normalizeChatToolLabels(patch.chat_tool_labels);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mcp_tool_hidden")) {
    file.mcp_tool_hidden = normalizeMcpToolHidden(patch.mcp_tool_hidden);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mcp_enabled")) {
    mcpTouched = true;
    const v = patch.mcp_enabled;
    if (typeof v === "boolean") file.mcp_enabled = v;
    else if (typeof v === "string") {
      file.mcp_enabled = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else file.mcp_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mcp_heartbeat")) {
    mcpTouched = true;
    const v = patch.mcp_heartbeat;
    if (typeof v === "boolean") file.mcp_heartbeat = v;
    else if (typeof v === "string") {
      file.mcp_heartbeat = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else file.mcp_heartbeat = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "nick_user")) {
    file.nick_user = String(patch.nick_user || "").trim().slice(0, 32);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "avatar_user")) {
    file.avatar_user = normalizeAvatar(patch.avatar_user, file.avatar_user || DEFAULTS.avatar_user);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "avatar_bot")) {
    file.avatar_bot = normalizeAvatar(patch.avatar_bot, file.avatar_bot || DEFAULTS.avatar_bot);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "persona_card_in_follow")) {
    const v = patch.persona_card_in_follow;
    if (typeof v === "boolean") file.persona_card_in_follow = v;
    else if (typeof v === "string") {
      file.persona_card_in_follow = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "worldbook_enabled")) {
    const v = patch.worldbook_enabled;
    if (typeof v === "boolean") file.worldbook_enabled = v;
    else if (typeof v === "string") {
      file.worldbook_enabled = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else file.worldbook_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "worldbook_scan_depth")) {
    const n = Number(patch.worldbook_scan_depth);
    if (Number.isFinite(n)) {
      file.worldbook_scan_depth = Math.max(0, Math.min(50, Math.floor(n)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "worldbook_budget_chars")) {
    const n = Number(patch.worldbook_budget_chars);
    if (Number.isFinite(n)) {
      file.worldbook_budget_chars = Math.max(200, Math.min(50000, Math.floor(n)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "persona_use_hut")) {
    const cur = normalizePersonaUseHut(file.persona_use_hut);
    const next = patch.persona_use_hut;
    if (next && typeof next === "object" && !Array.isArray(next)) {
      for (const app of PERSONA_APPS) {
        if (Object.prototype.hasOwnProperty.call(next, app)) cur[app] = next[app] !== false;
      }
    }
    file.persona_use_hut = cur;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "persona_apps")) {
    const cur = normalizePersonaApps(file.persona_apps);
    const next = patch.persona_apps;
    if (next && typeof next === "object" && !Array.isArray(next)) {
      for (const app of PERSONA_APPS) {
        if (!next[app] || typeof next[app] !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(next[app], "persona")) {
          cur[app].persona = String(next[app].persona || "").trim();
        }
        if (Object.prototype.hasOwnProperty.call(next[app], "persona_card")) {
          cur[app].persona_card = String(next[app].persona_card || "").trim();
        }
      }
    }
    file.persona_apps = cur;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "show_clock")) {
    const v = patch.show_clock;
    if (typeof v === "boolean") file.show_clock = v;
    else if (typeof v === "string") {
      file.show_clock = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else {
      file.show_clock = !!v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "timeline_msg_filter")) {
    const v = String(patch.timeline_msg_filter || "both").trim();
    file.timeline_msg_filter = v === "marks" || v === "follows" ? v : "both";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "auto_pause_timer")) {
    const v = patch.auto_pause_timer;
    if (typeof v === "boolean") file.auto_pause_timer = v;
    else if (typeof v === "string") {
      file.auto_pause_timer = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else {
      file.auto_pause_timer = !!v;
    }
  }
  /* 旧 PATCH meet_date → 并入纪念日「相识日」 */
  if (Object.prototype.hasOwnProperty.call(patch, "meet_date")) {
    const meet = normalizeMeetDate(patch.meet_date);
    file.meet_date = meet;
    if (meet) {
      const cur = normalizeAnnivs(file.annivs);
      if (!cur.some((a) => a.date === meet)) {
        file.annivs = [{ id: randomUUID(), title: "相识日", date: meet }, ...cur];
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "annivs")) {
    file.annivs = normalizeAnnivs(patch.annivs);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "pin_anniv_id")) {
    file.pin_anniv_id = String(patch.pin_anniv_id || "").trim();
  }
  /* 旧客户端若仍 PATCH pin_day：收成列表一条并钉上 */
  if (Object.prototype.hasOwnProperty.call(patch, "pin_day")) {
    const legacy = patch.pin_day;
    const title =
      legacy && typeof legacy === "object" ? String(legacy.title || "").trim().slice(0, 20) : "";
    let date = "";
    try {
      date =
        legacy && typeof legacy === "object" ? normalizeMeetDate(legacy.date || "") : "";
    } catch {
      const err = new Error("纪念日日期须为 YYYY-MM-DD");
      err.code = "bad_anniv";
      throw err;
    }
    if (!title && !date) {
      file.annivs = [];
      file.pin_anniv_id = "";
    } else if (!title || !date) {
      const err = new Error("纪念日须同时填标题和日期，或都清空");
      err.code = "bad_anniv";
      throw err;
    } else {
      const id = randomUUID();
      file.annivs = [{ id, title, date }];
      file.pin_anniv_id = id;
    }
  }
  {
    const a = resolveAnnivState(file);
    file.annivs = a.annivs;
    file.pin_anniv_id = a.pin_anniv_id;
    file.meet_date = "";
    delete file.pin_day;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "app_hidden")) {
    file.app_hidden = normalizeAppHidden(patch.app_hidden);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "desk_widget_token")) {
    const v = patch.desk_widget_token;
    if (typeof v === "boolean") file.desk_widget_token = v;
    else if (typeof v === "string") {
      file.desk_widget_token = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.desk_widget_token = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "desk_widget_sticky")) {
    const v = patch.desk_widget_sticky;
    if (typeof v === "boolean") file.desk_widget_sticky = v;
    else if (typeof v === "string") {
      file.desk_widget_sticky = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.desk_widget_sticky = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "desk_deco_enabled")) {
    const v = patch.desk_deco_enabled;
    if (typeof v === "boolean") file.desk_deco_enabled = v;
    else if (typeof v === "string") {
      file.desk_deco_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.desk_deco_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "desk_decos")) {
    file.desk_decos = normalizeDeskDecos(patch.desk_decos);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "desk_layout")) {
    file.desk_layout = normalizeDeskLayout(patch.desk_layout);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "default_follow_mode")) {
    file.default_follow_mode = normalizeFollowMode(patch.default_follow_mode);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "default_follow_tone")) {
    file.default_follow_tone = normalizeFollowTone(patch.default_follow_tone);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "default_budget_rmb")) {
    const n = Number(patch.default_budget_rmb);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error("默认额度须为 ≥0 的数字（0=不限）");
      err.code = "bad_budget";
      throw err;
    }
    file.default_budget_rmb = n;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "door_locked")) {
    const v = patch.door_locked;
    if (typeof v === "boolean") file.door_locked = v;
    else if (typeof v === "string") {
      file.door_locked = ["1", "true", "yes", "on", "locked"].includes(v.trim().toLowerCase());
    } else {
      file.door_locked = !!v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_enabled")) {
    const v = patch.sentinel_enabled;
    if (typeof v === "boolean") file.sentinel_enabled = v;
    else if (typeof v === "string") {
      file.sentinel_enabled = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else file.sentinel_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_interval_min")) {
    const n = Number(patch.sentinel_interval_min);
    if (Number.isFinite(n)) {
      file.sentinel_interval_min = Math.max(5, Math.min(120, Math.floor(n)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_cooldown_min")) {
    const n = Number(patch.sentinel_cooldown_min);
    if (Number.isFinite(n)) {
      file.sentinel_cooldown_min = Math.max(5, Math.min(240, Math.floor(n)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_max_wake_day")) {
    const n = Number(patch.sentinel_max_wake_day);
    if (Number.isFinite(n)) {
      file.sentinel_max_wake_day = Math.max(1, Math.min(40, Math.floor(n)));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "activity_enabled")) {
    const v = patch.activity_enabled;
    if (typeof v === "boolean") file.activity_enabled = v;
    else if (typeof v === "string") {
      file.activity_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.activity_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "peek_phone_enabled")) {
    const v = patch.peek_phone_enabled;
    if (typeof v === "boolean") file.peek_phone_enabled = v;
    else if (typeof v === "string") {
      file.peek_phone_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.peek_phone_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "peek_phone_l1_enabled")) {
    const v = patch.peek_phone_l1_enabled;
    if (typeof v === "boolean") file.peek_phone_l1_enabled = v;
    else if (typeof v === "string") {
      file.peek_phone_l1_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.peek_phone_l1_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "phone_device_enabled")) {
    const v = patch.phone_device_enabled;
    if (typeof v === "boolean") file.phone_device_enabled = v;
    else if (typeof v === "string") {
      file.phone_device_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.phone_device_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "auto_memory_enabled")) {
    const v = patch.auto_memory_enabled;
    if (typeof v === "boolean") file.auto_memory_enabled = v;
    else if (typeof v === "string") {
      file.auto_memory_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.auto_memory_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "auto_memory_mute")) {
    const v = patch.auto_memory_mute;
    if (typeof v === "boolean") file.auto_memory_mute = v;
    else if (typeof v === "string") {
      file.auto_memory_mute = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.auto_memory_mute = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "auto_memory_budget")) {
    const n = Math.floor(Number(patch.auto_memory_budget));
    if (Number.isFinite(n) && n > 0) {
      file.auto_memory_budget = Math.max(300, Math.min(6000, n));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "moments_ai_enabled")) {
    const v = patch.moments_ai_enabled;
    if (typeof v === "boolean") file.moments_ai_enabled = v;
    else if (typeof v === "string") {
      file.moments_ai_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.moments_ai_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "moments_ai_mode")) {
    file.moments_ai_mode =
      String(patch.moments_ai_mode || "confirm").toLowerCase() === "auto"
        ? "auto"
        : "confirm";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "geo_tool_enabled")) {
    const v = patch.geo_tool_enabled;
    if (typeof v === "boolean") file.geo_tool_enabled = v;
    else if (typeof v === "string") {
      file.geo_tool_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.geo_tool_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "weather_tool_enabled")) {
    const v = patch.weather_tool_enabled;
    if (typeof v === "boolean") file.weather_tool_enabled = v;
    else if (typeof v === "string") {
      file.weather_tool_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.weather_tool_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "weather_city")) {
    file.weather_city = String(patch.weather_city || "")
      .trim()
      .slice(0, 48);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "diy_http_enabled")) {
    const v = patch.diy_http_enabled;
    if (typeof v === "boolean") file.diy_http_enabled = v;
    else if (typeof v === "string") {
      file.diy_http_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.diy_http_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "diy_http_tools")) {
    try {
      const { normalizeDiyHttpTools } = require("../../聊天app/gateway/diy-http");
      file.diy_http_tools = normalizeDiyHttpTools(patch.diy_http_tools);
    } catch (_) {
      file.diy_http_tools = [];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "voice_bar_lang")) {
    file.voice_bar_lang = normalizeVoiceBarLang(patch.voice_bar_lang);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "call_heartbeat_enabled")) {
    const v = patch.call_heartbeat_enabled;
    if (typeof v === "boolean") file.call_heartbeat_enabled = v;
    else if (typeof v === "string") {
      file.call_heartbeat_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.call_heartbeat_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "call_heartbeat_sec")) {
    const n = Math.floor(Number(patch.call_heartbeat_sec));
    file.call_heartbeat_sec = Number.isFinite(n)
      ? Math.max(30, Math.min(120, n))
      : 45;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "call_proactive_enabled")) {
    const v = patch.call_proactive_enabled;
    if (typeof v === "boolean") file.call_proactive_enabled = v;
    else if (typeof v === "string") {
      file.call_proactive_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.call_proactive_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "call_gift_enabled")) {
    const v = patch.call_gift_enabled;
    if (typeof v === "boolean") file.call_gift_enabled = v;
    else if (typeof v === "string") {
      file.call_gift_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.call_gift_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "netease_api_base_url")) {
    file.netease_api_base_url = String(patch.netease_api_base_url || "")
      .trim()
      .replace(/\/+$/, "")
      .slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "netease_cookie")) {
    /* 扫码常带回 Set-Cookie 属性垃圾；且 VIP Cookie 远超 4KB，截断会丢 MUSIC_U */
    file.netease_cookie = sanitizeNeteaseCookie(patch.netease_cookie).slice(
      0,
      24000
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "netease_music_quality")) {
    file.netease_music_quality = String(patch.netease_music_quality || "exhigh")
      .trim()
      .slice(0, 24);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "music_volume")) {
    let n = Number(patch.music_volume);
    if (!Number.isFinite(n)) n = DEFAULTS.music_volume;
    if (n > 1 && n <= 100) n = n / 100;
    file.music_volume = Math.max(0, Math.min(1, n));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "music_provider")) {
    const p = String(patch.music_provider || "").trim();
    if (["netease", "apple", "auto"].includes(p)) file.music_provider = p;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_quiet_enabled")) {
    const v = patch.sentinel_quiet_enabled;
    if (typeof v === "boolean") file.sentinel_quiet_enabled = v;
    else if (typeof v === "string") {
      file.sentinel_quiet_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.sentinel_quiet_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_quiet_start")) {
    file.sentinel_quiet_start = normalizeHm(
      patch.sentinel_quiet_start,
      file.sentinel_quiet_start || DEFAULTS.sentinel_quiet_start
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sentinel_quiet_end")) {
    file.sentinel_quiet_end = normalizeHm(
      patch.sentinel_quiet_end,
      file.sentinel_quiet_end || DEFAULTS.sentinel_quiet_end
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "presence_dice_enabled")) {
    const v = patch.presence_dice_enabled;
    if (typeof v === "boolean") file.presence_dice_enabled = v;
    else if (typeof v === "string") {
      file.presence_dice_enabled = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.presence_dice_enabled = !!v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "presence_dice_chance")) {
    const n = Number(patch.presence_dice_chance);
    if (Number.isFinite(n) && n > 0) {
      file.presence_dice_chance = Math.max(0.05, Math.min(1, n));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "presence_dice_moments")) {
    const v = patch.presence_dice_moments;
    if (typeof v === "boolean") file.presence_dice_moments = v;
    else if (typeof v === "string") {
      file.presence_dice_moments = ["1", "true", "yes", "on"].includes(
        v.trim().toLowerCase()
      );
    } else file.presence_dice_moments = !!v;
  }
  writeSettings(file);
  if (mcpTouched) {
    try {
      require("./mcp-remote").clearMcpToolsCache();
    } catch {
      /* mcp-remote 可选 */
    }
  }
  return readSettings();
}

function isDoorLocked(s = readSettings()) {
  return !!s.door_locked;
}

/** 锁门时拒绝跟批/短聊/MCP 读书类操作 */
function assertDoorOpen() {
  if (isDoorLocked()) {
    const err = new Error("小屋已锁门：停跟批与短聊；划线仍会入库。请先开门。");
    err.code = "door_locked";
    throw err;
  }
}

/**
 * 合并共读有效人设 + 本场 dialogue 覆盖。
 * persona_card = App 有效人设；dialogue.persona = 本场补充（有则另注一句，不替代长卡）。
 */
function effectiveDialogue(open) {
  const s = readSettings();
  const resolved = resolveAppPersona("coread", s);
  const d = open && open.dialogue && typeof open.dialogue === "object" ? open.dialogue : {};
  const pick = (key, hut) => {
    if (!Object.prototype.hasOwnProperty.call(d, key)) return hut;
    const v = d[key];
    if (v == null) return hut;
    const t = String(v).trim();
    return t === "" ? hut : t;
  };
  /* 本场补充：有写才带；空=不另注（底稿只走 persona_card） */
  let sessionHint = "";
  if (Object.prototype.hasOwnProperty.call(d, "persona")) {
    sessionHint = String(d.persona == null ? "" : d.persona).trim();
  }
  const name_user = pick("name_user", s.name_user || DEFAULTS.name_user);
  const name_bot = pick("name_bot", s.name_bot || DEFAULTS.name_bot);
  const avatar_user = normalizeAvatar(
    Object.prototype.hasOwnProperty.call(d, "avatar_user") ? d.avatar_user : s.avatar_user,
    s.avatar_user || DEFAULTS.avatar_user
  );
  const avatar_bot = normalizeAvatar(
    Object.prototype.hasOwnProperty.call(d, "avatar_bot") ? d.avatar_bot : s.avatar_bot,
    s.avatar_bot || DEFAULTS.avatar_bot
  );
  return {
    persona: sessionHint,
    name_user,
    name_bot,
    avatar_user,
    avatar_bot,
    persona_card: resolved.persona_card || "",
    persona_card_in_follow: !!s.persona_card_in_follow,
    persona_inherit: resolved.inherit,
  };
}

function appendDialogueHints(system, dlg) {
  let out = String(system || "");
  out +=
    "\n称呼约定：用户叫「" +
    (dlg.name_user || "你") +
    "」，你叫「" +
    (dlg.name_bot || "熊") +
    "」。对用户用其称呼，自称用你的称呼；不要改成别的名字。";
  /* 仅本场补充；底稿人设由跟批/短聊的长卡开关注入 */
  const p = String(dlg.persona || "").trim();
  if (p) out += "\n本场补充（请遵守）：" + p;
  return out;
}

/** 剧情摘要注入软上限（字） */
const LORE_SUMMARY_MAX = 2000;
/** 落盘长期摘要上限（字）；超出保留末尾 */
const LORE_STORE_MAX = 8000;

function appendLoreToSystem(system, loreSummary) {
  let t = String(loreSummary || "").trim();
  if (!t) return String(system || "");
  if (t.length > LORE_SUMMARY_MAX) {
    t = t.slice(0, LORE_SUMMARY_MAX) + "\n…（剧情摘要已截断）";
  }
  return (
    String(system || "") +
    "\n当前剧情摘要（勿整段复述，跟批时自然照应）：\n" +
    t
  );
}

function formatSessionLoreBlock(session) {
  if (!session || typeof session !== "object") return "";
  const title = String(session.book_title || "未命名").trim() || "未命名";
  const passN = Number(session.pass_ordinal) || 0;
  const passBit = passN > 0 ? " · " + (passN === 1 ? "一刷" : passN === 2 ? "二刷" : passN + "刷") : "";
  const ended = Number(session.ended_at) || Date.now();
  const d = new Date(ended);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const when =
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes());
  const durMin = Math.max(0, Math.round((Number(session.duration_ms) || 0) / 60000));
  const lines = [
    "【本场 " + when + "】《" + title + "》" + passBit,
    "划线 " +
      (Number(session.highlight_count) || 0) +
      " · 跟批 " +
      (Number(session.follow_count) || 0) +
      " · 共读约 " +
      durMin +
      " 分钟",
  ];
  return lines.join("\n");
}

/** 用户确认后：把本场要点追加进长期剧情摘要 */
function appendSessionToLore(session) {
  const block = formatSessionLoreBlock(session);
  if (!block) return readSettings();
  const cur = String(readSettings().lore_summary || "").trim();
  let next = cur ? cur + "\n\n" + block : block;
  if (next.length > LORE_STORE_MAX) {
    next = "…（更早摘要已省略）\n" + next.slice(-(LORE_STORE_MAX - 20));
  }
  return patchSettings({ lore_summary: next });
}

function healthFlags(s = readSettings()) {
  return {
    weread_key: s.weread_key ? "configured" : "missing",
    llm: s.llm_base && s.llm_key && s.llm_model ? "configured" : "missing",
    door_locked: !!s.door_locked,
  };
}

/** 给前端的设定：不含哈希与密钥明文形态以外的敏感门禁字段 */
function publicSettings(s = readSettings()) {
  const {
    gate_hash: _h,
    gate_salt: _salt,
    weread_key,
    llm_key,
    mcp_token,
    mcp_token_2,
    fish_api_key,
    apple_music_dev_token: _amd,
    apple_music_user_token: _amu,
    netease_cookie: _nc,
    ...rest
  } = s;
  return {
    ...rest,
    weread_key: weread_key || "",
    llm_key: llm_key || "",
    fish_api_key: fish_api_key || "",
    /* token 回填给设定页编辑；与 llm_key 同级本机可信 */
    mcp_token: mcp_token || "",
    mcp_token_2: mcp_token_2 || "",
    /* Cookie 不回填明文；只告诉前端有没有 */
    netease_cookie_set: !!String(_nc || "").trim(),
    gate_enabled: !!(s.gate_hash && s.gate_salt) || !!String(process.env.CABIN_GATE || "").trim(),
    gate_has_password: !!(s.gate_hash && s.gate_salt),
    tts_fish: fish_api_key && s.fish_voice_id ? "configured" : "missing",
  };
}

/** 本机可选模型：默认项 + 写死列表（暂不调远端模型目录） */
const BUILTIN_MODELS = ["deepseek-flash", "deepseek-chat"];

function listLlmModels() {
  const def = readSettings().llm_model;
  const models = [...new Set([def, ...BUILTIN_MODELS].filter(Boolean))];
  return { default: def, models };
}

function shortModelLabel(id) {
  const s = String(id || "").trim();
  if (!s) return "Deep…";
  const lower = s.toLowerCase();
  if (lower.includes("flash")) return "flash";
  if (lower.includes("chat")) return "chat";
  if (lower.includes("reasoner")) return "reasoner";
  return s.length > 8 ? s.slice(0, 6) + "…" : s;
}

if (require.main === module) {
  const { default: d, models } = listLlmModels();
  console.assert(models.includes("deepseek-flash") && models.includes("deepseek-chat"));
  console.assert(shortModelLabel("deepseek-flash") === "flash");
  console.assert(shortModelLabel("deepseek-chat") === "chat");
  console.assert(normalizeVoiceBarLang("EN") === "en");
  console.assert(normalizeVoiceBarLang("off") === "");
  console.assert(normalizeVoiceBarLang("ja-JP") === "ja");
  const prev = isDoorLocked();
  patchSettings({ door_locked: true });
  console.assert(isDoorLocked());
  try {
    assertDoorOpen();
    throw new Error("expected door_locked");
  } catch (e) {
    if (e.code !== "door_locked") throw e;
  }
  patchSettings({ door_locked: prev });
  const dlg = effectiveDialogue({
    dialogue: { name_bot: "小熊", avatar_user: "/assets/cafe/avatar-you.png" },
  });
  console.assert(dlg.name_bot === "小熊");
  console.assert(dlg.avatar_user === "/assets/cafe/avatar-you.png");
  console.assert(dlg.name_user === (readSettings().name_user || DEFAULTS.name_user));
  console.assert(appendDialogueHints("base", dlg).includes("小熊"));
  console.assert(appendLoreToSystem("base", "") === "base");
  console.assert(appendLoreToSystem("base", "  主角在找钥匙  ").includes("剧情摘要"));
  console.assert(appendLoreToSystem("base", "  主角在找钥匙  ").includes("找钥匙"));
  const long = "字".repeat(LORE_SUMMARY_MAX + 50);
  console.assert(appendLoreToSystem("base", long).includes("已截断"));
  const block = formatSessionLoreBlock({
    book_title: "测试书",
    pass_ordinal: 1,
    ended_at: Date.now(),
    duration_ms: 12 * 60000,
    highlight_count: 3,
    follow_count: 2,
  });
  console.assert(block.includes("测试书") && block.includes("一刷") && block.includes("划线 3"), block);
  console.assert(readSettings().show_clock !== false);
  patchSettings({ show_clock: false });
  console.assert(readSettings().show_clock === false);
  patchSettings({ show_clock: true });
  console.assert(readSettings().show_clock === true);
  patchSettings({ annivs: [], pin_anniv_id: "" });
  patchSettings({ meet_date: "2024-01-15" });
  console.assert(readSettings().meet_date === "");
  console.assert(
    readSettings().annivs.some((a) => a.title === "相识日" && a.date === "2024-01-15")
  );
  patchSettings({ annivs: [], pin_anniv_id: "" });
  try {
    patchSettings({ meet_date: "2024-13-01" });
    throw new Error("expected bad_meet_date");
  } catch (e) {
    if (e.code !== "bad_meet_date") throw e;
  }
  patchSettings({
    annivs: [
      { id: "a1", title: "生日", date: "2020-06-01" },
      { id: "a2", title: "周年", date: "2024-05-21" },
    ],
    pin_anniv_id: "a2",
  });
  console.assert(readSettings().annivs.length === 2 && readSettings().pin_anniv_id === "a2");
  patchSettings({ pin_anniv_id: "" });
  console.assert(readSettings().pin_anniv_id === "");
  patchSettings({ annivs: [], pin_anniv_id: "" });
  console.assert(readSettings().annivs.length === 0);
  patchSettings({ app_hidden: ["chat", "settings", "nope", "chat"] });
  console.assert(
    JSON.stringify(readSettings().app_hidden) === JSON.stringify(["chat"]),
    readSettings().app_hidden
  );
  patchSettings({ app_hidden: [] });
  console.assert(readSettings().app_hidden.length === 0);
  patchSettings({
    desk_layout: [
      { id: "wid-meet", col: 1, row: 2 },
      { id: "app-chat", col: 9, row: -1 },
      { id: "nope", col: 1, row: 1 },
      { id: "wid-meet", col: 0, row: 0 },
    ],
  });
  {
    const dl = readSettings().desk_layout;
    console.assert(dl.length === 2 && dl[0].id === "wid-meet" && dl[0].col === 1 && dl[0].row === 2);
    console.assert(dl[1].id === "app-chat" && dl[1].col === 3 && dl[1].row === 0);
    console.assert(dl[0].page === 0);
  }
  patchSettings({
    desk_layout: [{ id: "wid-peer", col: 0, row: 0, page: 2 }],
  });
  console.assert(readSettings().desk_layout[0].page === 2);
  patchSettings({ desk_layout: [] });
  console.assert(readSettings().desk_layout.length === 0);
  patchSettings({ chat_tool_labels: { calendar_list_events: "日历", "坏 key": "x", x: "" } });
  console.assert(readSettings().chat_tool_labels.calendar_list_events === "日历");
  console.assert(!Object.prototype.hasOwnProperty.call(readSettings().chat_tool_labels, "坏 key"));
  console.assert(!Object.prototype.hasOwnProperty.call(readSettings().chat_tool_labels, "x"));
  patchSettings({ chat_tool_labels: {} });
  console.assert(Object.keys(readSettings().chat_tool_labels).length === 0);
  patchSettings({ mcp_tool_hidden: ["a", "a", "", "b"] });
  console.assert(
    JSON.stringify(readSettings().mcp_tool_hidden) === JSON.stringify(["a", "b"])
  );
  patchSettings({ mcp_tool_hidden: [] });
  console.assert(readSettings().mcp_tool_hidden.length === 0);
  patchSettings({ default_follow_tone: "short" });
  console.assert(readSettings().default_follow_tone === "short");
  patchSettings({ default_follow_tone: "" });
  console.assert(readSettings().default_follow_tone === "");
  patchSettings({
    persona: "旧短回落",
    persona_card: "",
    persona_use_hut: { chat: true, coread: false },
    persona_apps: { coread: { persona: "", persona_card: "共读卡" } },
  });
  console.assert(resolveAppPersona("chat").persona_card === "旧短回落");
  console.assert(resolveAppPersona("coread").persona_card === "共读卡");
  console.assert(resolveAppPersona("coread").inherit === false);
  patchSettings({
    persona: "",
    persona_card: "小屋卡",
  });
  console.assert(resolveAppPersona("chat").persona_card === "小屋卡");
  patchSettings({
    persona: "",
    persona_card: "",
    persona_use_hut: { chat: true, coread: true },
    persona_apps: { chat: { persona: "", persona_card: "" }, coread: { persona: "", persona_card: "" } },
  });
  console.assert(coalescePersonaCard("短", "") === "短");
  console.assert(coalescePersonaCard("短", "长") === "长");
  console.log("models ok", { default: d || "(empty)", n: models.length });
}

module.exports = {
  readSettings,
  patchSettings,
  sanitizeNeteaseCookie,
  healthFlags,
  publicSettings,
  normalizeVoiceBarLang,
  normalizeMcpToolHidden,
  listLlmModels,
  shortModelLabel,
  normalizeFollowMode,
  normalizeFollowTone,
  tokensFromBudgetRmb,
  isDoorLocked,
  assertDoorOpen,
  effectiveDialogue,
  resolveAppPersona,
  coalescePersonaCard,
  normalizePersonaUseHut,
  normalizePersonaApps,
  appendDialogueHints,
  appendLoreToSystem,
  formatSessionLoreBlock,
  appendSessionToLore,
  LORE_SUMMARY_MAX,
  LORE_STORE_MAX,
  normalizeAvatar,
  normalizeMeetDate,
  normalizeAppHidden,
  normalizeDeskDecos,
  normalizeDeskLayout,
  DESK_DECO_IDS,
  normalizeChatToolLabels,
  APP_IDS,
  APP_ALWAYS_VISIBLE,
  AVATAR_PRESETS,
  FOLLOW_MODES,
  FOLLOW_TONES,
  get RMB_PER_M_TOKEN() {
    const { blendRmbPerMOffFor } = require("../../额度app/gateway/deepseek-pricing");
    const model = String(readSettings().llm_model || "").trim() || "deepseek-flash";
    return blendRmbPerMOffFor(model) || 1.75;
  },
  SETTINGS_PATH,
  DEFAULTS,
};
