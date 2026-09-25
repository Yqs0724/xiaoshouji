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
};

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
  const allowed = Object.keys(DEFAULTS);
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] === "string") {
      file[key] = patch[key];
    }
  }
  writeSettings(file);
  return readSettings();
}

function healthFlags(s = readSettings()) {
  return {
    weread_key: s.weread_key ? "configured" : "missing",
    llm: s.llm_base && s.llm_key && s.llm_model ? "configured" : "missing",
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
  console.log("models ok", { default: d || "(empty)", n: models.length });
}

module.exports = {
  readSettings,
  patchSettings,
  healthFlags,
  listLlmModels,
  shortModelLabel,
  SETTINGS_PATH,
};
