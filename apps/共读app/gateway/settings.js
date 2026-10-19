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
  name_bot: "熊",
  avatar_user: "/assets/cafe/avatar-you.png",
  avatar_bot: "/assets/cafe/avatar-bot.png",
  /** 共读顶栏是否显示时钟 */
  show_clock: true,
  /** @deprecated 已并入 annivs；读盘时迁入后清空 */
  meet_date: "",
  /** 纪念日列表（含原相识日）；桌面钉 pin_anniv_id 从中选一条 */
  annivs: [],
  pin_anniv_id: "",
  /** 桌面隐藏的 App id 列表；显隐不删业务数据 */
  app_hidden: [],
  /** 日常聊天是否允许调用工具（日历等；网关内执行） */
  chat_tools_enabled: true,
  /** 工具显示名：{ function.name: "中文名" }；空则用内置默认 */
  chat_tool_labels: {},
  /** 外接 MCP（客户端）：开且填了 URL 后，以后可并入工具表 */
  mcp_enabled: false,
  mcp_url: "",
  mcp_token: "",
  /** H1.24：关掉的 MCP 远端工具名（remote name），不进 LLM 工具表 */
  mcp_tool_hidden: [],
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

/** DEMO 咖啡屋头像预设（仅允许这些路径） */
const AVATAR_PRESETS = [
  "/assets/cafe/avatar-you.png",
  "/assets/cafe/avatar-bot.png",
  "/assets/cafe/decor-bear.png",
];

function normalizeAvatar(src, fallback) {
  const s = String(src || "").trim();
  if (AVATAR_PRESETS.includes(s)) return s;
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
  "ledger",
  "album",
  "eat",
  "map",
  "settings",
];
const APP_ALWAYS_VISIBLE = new Set(["settings"]);

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

function normalizeFollowMode(m) {
  const s = String(m || "").trim();
  return FOLLOW_MODES.includes(s) ? s : "immersive";
}

function normalizeFollowTone(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s || s === "default") return "";
  return FOLLOW_TONES.includes(s) ? s : "";
}

/** Flash 闲时粗算：约 2.5 元 / 百万 token（与 PWA 额度档一致） */
const RMB_PER_M_TOKEN = 2.5;

function tokensFromBudgetRmb(rmb) {
  const n = Number(rmb) || 0;
  if (n <= 0) return 0;
  return Math.round((n / RMB_PER_M_TOKEN) * 1e6);
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
    name_bot: String(file.name_bot || DEFAULTS.name_bot).trim() || DEFAULTS.name_bot,
    avatar_user: normalizeAvatar(file.avatar_user, DEFAULTS.avatar_user),
    avatar_bot: normalizeAvatar(file.avatar_bot, DEFAULTS.avatar_bot),
    show_clock: file.show_clock !== false,
    ...(() => {
      const a = resolveAnnivState(file);
      return {
        annivs: a.annivs,
        pin_anniv_id: a.pin_anniv_id,
        meet_date: "", /* 已并入 annivs */
      };
    })(),
    app_hidden: normalizeAppHidden(file.app_hidden),
    chat_tools_enabled: file.chat_tools_enabled !== false,
    chat_tool_labels: normalizeChatToolLabels(file.chat_tool_labels),
    mcp_enabled: !!file.mcp_enabled,
    mcp_url: String(file.mcp_url || "").trim(),
    mcp_token: String(file.mcp_token || "").trim(),
    mcp_tool_hidden: normalizeMcpToolHidden(file.mcp_tool_hidden),
  };
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
    "persona",
    "persona_card",
    "lore_summary",
    "gate_hash",
    "gate_salt",
    "name_user",
    "name_bot",
    "mcp_url",
    "mcp_token",
  ];
  let mcpTouched = false;
  for (const key of stringKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] === "string") {
      if (key === "mcp_url" || key === "mcp_token") mcpTouched = true;
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
    apple_music_dev_token: _amd,
    apple_music_user_token: _amu,
    ...rest
  } = s;
  return {
    ...rest,
    weread_key: weread_key || "",
    llm_key: llm_key || "",
    /* token 回填给设定页编辑；与 llm_key 同级本机可信 */
    mcp_token: mcp_token || "",
    gate_enabled: !!(s.gate_hash && s.gate_salt) || !!String(process.env.CABIN_GATE || "").trim(),
    gate_has_password: !!(s.gate_hash && s.gate_salt),
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
  healthFlags,
  publicSettings,
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
  normalizeChatToolLabels,
  APP_IDS,
  APP_ALWAYS_VISIBLE,
  AVATAR_PRESETS,
  FOLLOW_MODES,
  FOLLOW_TONES,
  RMB_PER_M_TOKEN,
  SETTINGS_PATH,
  DEFAULTS,
};
