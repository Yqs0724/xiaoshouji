/**
 * DeepSeek 价卡（元 / 百万 tokens）。
 * 默认值对齐官网；可改写到 data/rates.json。官方无价表 API，改价靠人手对照。
 * 真源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * 峰谷：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰。
 * ponytail: 法定节假日全天空闲 — 未接节假日表。
 */

const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const RATES_PATH = path.join(__dirname, "data", "rates.json");

/** 历史总量无入/出拆分时：按常见对话粗拆（偏输入） */
const BLEND_IN = 0.75;
const BLEND_OUT = 0.25;

const DEFAULT_MODELS = {
  "deepseek-flash": {
    label: "DeepSeek-V4.1-Flash",
    version: "DeepSeek-V4.1-Flash-1017",
    vision: true,
    aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-chat"],
    peak_auto: true,
    off: { in_hit: 0.02, in_miss: 1, out: 4 },
    peak: { in_hit: 0.04, in_miss: 2, out: 8 },
  },
  "deepseek-v4-pro": {
    label: "DeepSeek-V4-Pro",
    version: "DeepSeek-V4-Pro-0813",
    vision: false,
    aliases: ["deepseek-v4-pro"],
    peak_auto: true,
    /** 对齐官网中文表量级；改价请在额度页改卡 */
    off: { in_hit: 0.15, in_miss: 4.5, out: 13.5 },
    peak: { in_hit: 0.3, in_miss: 9, out: 27 },
  },
};

const FLASH = DEFAULT_MODELS["deepseek-flash"];

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fb;
}

function normalizeBand(raw, fb) {
  const f = fb || { in_hit: 0, in_miss: 0, out: 0 };
  return {
    in_hit: num(raw && raw.in_hit, f.in_hit),
    in_miss: num(raw && raw.in_miss, f.in_miss),
    out: num(raw && raw.out, f.out),
  };
}

function doubleBand(off) {
  return {
    in_hit: Math.round(off.in_hit * 2 * 1000) / 1000,
    in_miss: Math.round(off.in_miss * 2 * 1000) / 1000,
    out: Math.round(off.out * 2 * 1000) / 1000,
  };
}

function normalizeModel(id, raw, fallback) {
  const fb = fallback || FLASH;
  const off = normalizeBand(raw && raw.off, fb.off);
  const peakAuto = raw && raw.peak_auto === false ? false : true;
  const peak = peakAuto
    ? doubleBand(off)
    : normalizeBand(raw && raw.peak, fb.peak || doubleBand(off));
  return {
    id: String(id || fb.id || "deepseek-flash"),
    label: String((raw && raw.label) || fb.label || id),
    version: String((raw && raw.version) || fb.version || ""),
    vision: !!(raw && Object.prototype.hasOwnProperty.call(raw, "vision")
      ? raw.vision
      : fb.vision),
    aliases: Array.isArray(raw && raw.aliases)
      ? raw.aliases.map((a) => String(a || "").trim()).filter(Boolean)
      : Array.isArray(fb.aliases)
        ? fb.aliases.slice()
        : [],
    peak_auto: peakAuto,
    off,
    peak,
  };
}

function defaultStore() {
  const models = {};
  for (const [id, m] of Object.entries(DEFAULT_MODELS)) {
    models[id] = normalizeModel(id, m, m);
  }
  return {
    source: SOURCE_URL,
    updated_at: "",
    models,
  };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return defaultStore();
    const base = defaultStore();
    const models = { ...base.models };
    const incoming = raw.models && typeof raw.models === "object" ? raw.models : {};
    for (const [id, m] of Object.entries(incoming)) {
      const key = String(id || "").trim();
      if (!key) continue;
      models[key] = normalizeModel(key, m, models[key] || FLASH);
    }
    return {
      source: String(raw.source || SOURCE_URL),
      updated_at: String(raw.updated_at || ""),
      models,
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  const dir = path.dirname(RATES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    source: store.source || SOURCE_URL,
    updated_at: new Date().toISOString(),
    models: {},
  };
  for (const [id, m] of Object.entries(store.models || {})) {
    out.models[id] = {
      label: m.label,
      version: m.version,
      vision: !!m.vision,
      aliases: m.aliases || [],
      peak_auto: m.peak_auto !== false,
      off: m.off,
      peak: m.peak,
    };
  }
  fs.writeFileSync(RATES_PATH, JSON.stringify(out, null, 2), "utf8");
  return readStore();
}

function resolveModelId(modelId, store) {
  const s = store || readStore();
  const want = String(modelId || "").trim().toLowerCase();
  if (!want) return "deepseek-flash";
  if (s.models[want]) return want;
  for (const [id, m] of Object.entries(s.models)) {
    if ((m.aliases || []).some((a) => String(a).toLowerCase() === want)) return id;
  }
  // 未知模型：挂到 flash 卡，调用方看 fallback 标记
  return "deepseek-flash";
}

function getModelCard(modelId) {
  const store = readStore();
  const want = String(modelId || "").trim();
  const id = resolveModelId(want, store);
  const card = store.models[id] || normalizeModel(id, FLASH, FLASH);
  const exact =
    !!want &&
    (want.toLowerCase() === id ||
      (card.aliases || []).some((a) => String(a).toLowerCase() === want.toLowerCase()));
  return {
    ...card,
    id,
    requested: want || id,
    fallback: want ? !exact : false,
    source: store.source || SOURCE_URL,
    updated_at: store.updated_at || "",
  };
}

function listModelCards() {
  const store = readStore();
  return Object.keys(store.models).map((id) => getModelCard(id));
}

function beijingParts(at) {
  const d = new Date(Number(at) || Date.now());
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  let weekday = "";
  let hour = 0;
  for (const p of parts) {
    if (p.type === "weekday") weekday = p.value;
    if (p.type === "hour") hour = Number(p.value) || 0;
  }
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

function isPeakBeijing(at) {
  const { weekday, hour } = beijingParts(at);
  const work = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!work) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

function ratesAt(at, modelId) {
  const card = getModelCard(modelId);
  return isPeakBeijing(at) ? card.peak : card.off;
}

function blendRmbPerM(rates) {
  return Math.round((BLEND_IN * rates.in_miss + BLEND_OUT * rates.out) * 1000) / 1000;
}

function blendRmbPerMOffFor(modelId) {
  return blendRmbPerM(getModelCard(modelId).off);
}

function blendRmbPerMPeakFor(modelId) {
  return blendRmbPerM(getModelCard(modelId).peak);
}

/**
 * @param {{ tokens_in?: number, tokens_out?: number, cache_hit_in?: number }} usage
 * @param {number} [at]
 * @param {string} [modelId]
 */
function rmbFromUsage(usage, at, modelId) {
  const rates = ratesAt(at, modelId);
  const tin = Math.max(0, Number(usage && usage.tokens_in) || 0);
  const tout = Math.max(0, Number(usage && usage.tokens_out) || 0);
  const hit = Math.min(tin, Math.max(0, Number(usage && usage.cache_hit_in) || 0));
  const miss = Math.max(0, tin - hit);
  const rmb =
    (miss / 1e6) * rates.in_miss + (hit / 1e6) * rates.in_hit + (tout / 1e6) * rates.out;
  return Math.round(rmb * 100) / 100;
}

function rmbFromTokensTotal(tokens, at, modelId) {
  const n = Math.max(0, Number(tokens) || 0);
  return rmbFromUsage(
    { tokens_in: n * BLEND_IN, tokens_out: n * BLEND_OUT, cache_hit_in: 0 },
    at,
    modelId
  );
}

function pricingPublic(at, modelId) {
  const now = Number(at) || Date.now();
  const peak = isPeakBeijing(now);
  const card = getModelCard(modelId);
  const offBlend = blendRmbPerM(card.off);
  const peakBlend = blendRmbPerM(card.peak);
  return {
    source: card.source || SOURCE_URL,
    model: card.id,
    requested: card.requested,
    fallback: card.fallback,
    label: card.label,
    version: card.version,
    vision: card.vision,
    peak_auto: card.peak_auto,
    updated_at: card.updated_at,
    period: peak ? "peak" : "off",
    period_lab: peak ? "高峰" : "闲时",
    off: card.off,
    peak: card.peak,
    blend: {
      in_ratio: BLEND_IN,
      out_ratio: BLEND_OUT,
      cache_hit_ratio: 0,
      rmb_per_m_off: offBlend,
      rmb_per_m_peak: peakBlend,
      note: "历史总量无入出拆分时，按入75%/出25%、缓存未命中估算",
    },
  };
}

/**
 * 更新某模型价卡。body: { model, off?, peak?, peak_auto?, label? }
 */
function patchModelRates(body) {
  const model = String((body && body.model) || "").trim();
  if (!model) {
    const err = new Error("缺少 model");
    err.code = "bad_rates";
    throw err;
  }
  const store = readStore();
  const prev = store.models[model] || getModelCard(model);
  const next = normalizeModel(
    model,
    {
      ...prev,
      label: body.label != null ? body.label : prev.label,
      peak_auto: body.peak_auto != null ? !!body.peak_auto : prev.peak_auto,
      off: body.off != null ? { ...prev.off, ...body.off } : prev.off,
      peak: body.peak != null ? { ...prev.peak, ...body.peak } : prev.peak,
      aliases: prev.aliases,
      version: prev.version,
      vision: prev.vision,
    },
    prev
  );
  store.models[model] = next;
  writeStore(store);
  return getModelCard(model);
}

const BLEND_RMB_PER_M_OFF = blendRmbPerM(FLASH.off);
const BLEND_RMB_PER_M_PEAK = blendRmbPerM(FLASH.peak);

if (require.main === module) {
  console.assert(
    rmbFromUsage({ tokens_in: 1e6, tokens_out: 0 }, Date.parse("2026-10-25T02:00:00+08:00")) === 1
  );
  console.assert(
    rmbFromUsage({ tokens_in: 0, tokens_out: 1e6 }, Date.parse("2026-10-25T02:00:00+08:00")) === 4
  );
  console.assert(!isPeakBeijing(Date.parse("2026-10-25T10:00:00+08:00")));
  console.assert(isPeakBeijing(Date.parse("2026-10-26T10:00:00+08:00")));
  console.assert(resolveModelId("deepseek-v4-flash-vision-exp") === "deepseek-flash");
  console.assert(resolveModelId("deepseek-chat") === "deepseek-flash");
  console.assert(BLEND_RMB_PER_M_OFF === 1.75);
  const pro = getModelCard("deepseek-v4-pro");
  console.assert(pro.off.in_miss === 4.5);
  console.log("deepseek-pricing ok", {
    BLEND_RMB_PER_M_OFF,
    BLEND_RMB_PER_M_PEAK,
    pro_blend_off: blendRmbPerMOffFor("deepseek-v4-pro"),
  });
}

module.exports = {
  FLASH,
  SOURCE_URL,
  RATES_PATH,
  isPeakBeijing,
  ratesAt,
  rmbFromUsage,
  rmbFromTokensTotal,
  pricingPublic,
  getModelCard,
  listModelCards,
  resolveModelId,
  patchModelRates,
  blendRmbPerMOffFor,
  blendRmbPerMPeakFor,
  BLEND_RMB_PER_M_OFF,
  BLEND_RMB_PER_M_PEAK,
  BLEND_IN,
  BLEND_OUT,
};
