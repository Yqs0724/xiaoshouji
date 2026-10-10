const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("./load-env");

loadEnv();

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  weread_key: "",
  llm_base: "",
  llm_key: "",
  llm_model: "",
  persona: "",
  persona_card: "",
  persona_card_in_follow: false,
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
  /** 相识日 YYYY-MM-DD；空=未设（桌面不显示相遇天数） */
  meet_date: "",
  /** 桌面隐藏的 App id 列表；显隐不删业务数据 */
  app_hidden: [],
};

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
    meet_date: (() => {
      try {
        return normalizeMeetDate(file.meet_date || "");
      } catch {
        return "";
      }
    })(),
    app_hidden: normalizeAppHidden(file.app_hidden),
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
  ];
  for (const key of stringKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] === "string") {
      file[key] = patch[key];
    }
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
  if (Object.prototype.hasOwnProperty.call(patch, "show_clock")) {
    const v = patch.show_clock;
    if (typeof v === "boolean") file.show_clock = v;
    else if (typeof v === "string") {
      file.show_clock = ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    } else {
      file.show_clock = !!v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "meet_date")) {
    file.meet_date = normalizeMeetDate(patch.meet_date);
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
 * 合并小屋默认 + 本场 dialogue 覆盖。
 * 本场字段为空/未设 → 用小屋；长卡仍只来自小屋设定。
 */
function effectiveDialogue(open) {
  const s = readSettings();
  const d = open && open.dialogue && typeof open.dialogue === "object" ? open.dialogue : {};
  const pick = (key, hut) => {
    if (!Object.prototype.hasOwnProperty.call(d, key)) return hut;
    const v = d[key];
    if (v == null) return hut;
    const t = String(v).trim();
    return t === "" ? hut : t;
  };
  const persona = pick("persona", s.persona || "");
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
    persona,
    name_user,
    name_bot,
    avatar_user,
    avatar_bot,
    persona_card: s.persona_card || "",
    persona_card_in_follow: !!s.persona_card_in_follow,
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
  const p = String(dlg.persona || "").trim();
  if (p) out += "\n人设（请遵守语气与关系）：" + p;
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
    apple_music_dev_token: _amd,
    apple_music_user_token: _amu,
    ...rest
  } = s;
  return {
    ...rest,
    weread_key: weread_key || "",
    llm_key: llm_key || "",
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
  patchSettings({ meet_date: "2024-01-15" });
  console.assert(readSettings().meet_date === "2024-01-15");
  patchSettings({ meet_date: "" });
  console.assert(readSettings().meet_date === "");
  try {
    patchSettings({ meet_date: "2024-13-01" });
    throw new Error("expected bad_meet_date");
  } catch (e) {
    if (e.code !== "bad_meet_date") throw e;
  }
  patchSettings({ app_hidden: ["chat", "settings", "nope", "chat"] });
  console.assert(
    JSON.stringify(readSettings().app_hidden) === JSON.stringify(["chat"]),
    readSettings().app_hidden
  );
  patchSettings({ app_hidden: [] });
  console.assert(readSettings().app_hidden.length === 0);
  patchSettings({ default_follow_tone: "short" });
  console.assert(readSettings().default_follow_tone === "short");
  patchSettings({ default_follow_tone: "" });
  console.assert(readSettings().default_follow_tone === "");
  console.log("models ok", { default: d || "(empty)", n: models.length });
}

module.exports = {
  readSettings,
  patchSettings,
  healthFlags,
  publicSettings,
  listLlmModels,
  shortModelLabel,
  normalizeFollowMode,
  normalizeFollowTone,
  tokensFromBudgetRmb,
  isDoorLocked,
  assertDoorOpen,
  effectiveDialogue,
  appendDialogueHints,
  appendLoreToSystem,
  formatSessionLoreBlock,
  appendSessionToLore,
  LORE_SUMMARY_MAX,
  LORE_STORE_MAX,
  normalizeAvatar,
  normalizeMeetDate,
  normalizeAppHidden,
  APP_IDS,
  APP_ALWAYS_VISIBLE,
  AVATAR_PRESETS,
  FOLLOW_MODES,
  FOLLOW_TONES,
  RMB_PER_M_TOKEN,
  SETTINGS_PATH,
  DEFAULTS,
};
