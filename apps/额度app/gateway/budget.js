/**
 * 额度汇总（只读）：聚合各 App tokens_used，按当前 llm_model 价卡估 ¥。
 * 价卡：./deepseek-pricing.js（可改 data/rates.json）
 * 余额：./deepseek-balance.js ← GET /user/balance
 */
const { listSessions, getOpenSession } = require("../../共读app/gateway/sessions");
const { readSettings, tokensFromBudgetRmb } = require("../../共读app/gateway/settings");
const { readAll: readChat } = require("../../聊天app/gateway/daily-chat");
const { readAll: readWatch } = require("../../共看app/gateway/watch");
const { readAll: readListen } = require("../../共听app/gateway/listen");
const { readAll: readCal } = require("../../日历app/gateway/calendar");
const {
  rmbFromTokensTotal,
  pricingPublic,
  listModelCards,
  patchModelRates,
  blendRmbPerMOffFor,
  blendRmbPerMPeakFor,
  BLEND_RMB_PER_M_OFF,
} = require("./deepseek-pricing");
const { fetchUserBalance } = require("./deepseek-balance");

function activeModelId(settings) {
  return String((settings && settings.llm_model) || "").trim() || "deepseek-flash";
}

function rmbFromTokens(tokens, at, modelId) {
  return rmbFromTokensTotal(tokens, at, modelId);
}

function sumPassTokens(passes) {
  let t = 0;
  for (const p of passes || []) t += Math.max(0, Number(p && p.tokens_used) || 0);
  return t;
}

function sumCoreadTokens() {
  let t = 0;
  const { sessions } = listSessions();
  for (const s of sessions || []) t += Math.max(0, Number(s && s.tokens_used) || 0);
  const open = getOpenSession();
  if (open) t += Math.max(0, Number(open.tokens_used) || 0);
  return t;
}

function line(id, lab, tokens, note, at, modelId) {
  const tokens_used = Math.max(0, Math.floor(Number(tokens) || 0));
  return {
    id,
    lab,
    tokens_used,
    rmb: rmbFromTokens(tokens_used, at, modelId),
    note: note || "",
  };
}

/** GET /api/v1/budget/summary */
async function getBudgetSummary() {
  const now = Date.now();
  const settings = readSettings();
  const modelId = activeModelId(settings);
  const default_budget_rmb = Math.max(0, Number(settings.default_budget_rmb) || 0);
  const default_budget_tokens = tokensFromBudgetRmb(default_budget_rmb);
  const pricing = pricingPublic(now, modelId);
  const offBlend = blendRmbPerMOffFor(modelId);
  const peakBlend = blendRmbPerMPeakFor(modelId);
  const rmb_per_m = pricing.period === "peak" ? peakBlend : offBlend;

  const apps = [
    line("coread", "共读", sumCoreadTokens(), "场次 + 进行中", now, modelId),
    line("chat", "聊天", readChat().tokens_used, "日常短讯线程", now, modelId),
    line("cowatch", "共看", sumPassTokens(readWatch().passes), "各场吐槽累计", now, modelId),
    line("colisten", "共听", sumPassTokens(readListen().passes), "各场吐槽累计", now, modelId),
    line("cal", "日历", readCal().tokens_used, "让家机排累计", now, modelId),
    line("budget", "额度", 0, "本 App 暂不计费", now, modelId),
  ];

  const tokens_used = apps.reduce((a, x) => a + x.tokens_used, 0);
  /* 合计 = 各行已四舍五入之和，避免总分与分项对不上 */
  const rmb = Math.round(apps.reduce((a, x) => a + (Number(x.rmb) || 0), 0) * 100) / 100;
  const balance = await fetchUserBalance(settings);

  return {
    ok: true,
    llm_model: modelId,
    rate: {
      rmb_per_m_token: rmb_per_m,
      rmb_per_m_off: offBlend,
      rmb_per_m_peak: peakBlend,
      model: pricing.model,
      requested: pricing.requested,
      fallback: pricing.fallback,
      label: pricing.label,
      period: pricing.period,
      period_lab: pricing.period_lab,
      source: pricing.source,
      off: pricing.off,
      peak: pricing.peak,
      peak_auto: pricing.peak_auto,
      updated_at: pricing.updated_at,
      blend: pricing.blend,
    },
    pricing,
    cards: listModelCards().map((c) => ({
      id: c.id,
      label: c.label,
      off: c.off,
      peak: c.peak,
      peak_auto: c.peak_auto,
    })),
    balance,
    default_budget_rmb,
    default_budget_tokens,
    tokens_used,
    rmb,
    apps,
  };
}

if (require.main === module) {
  getBudgetSummary()
    .then((s) => {
      console.assert(s.ok && Array.isArray(s.apps) && s.apps.length >= 4);
      console.assert(typeof s.rmb === "number");
      console.assert(s.apps.some((a) => a.id === "budget" && a.tokens_used === 0));
      console.assert(s.rate && s.rate.model);
      console.assert(s.balance && typeof s.balance.ok === "boolean");
      console.log("budget ok", {
        model: s.llm_model,
        tokens: s.tokens_used,
        rmb: s.rmb,
        period: s.rate.period_lab,
        rate: s.rate.rmb_per_m_token,
        balance: s.balance.ok
          ? s.balance.currency + " " + s.balance.total_balance
          : s.balance.message,
        apps: s.apps.map((a) => a.id + ":" + a.tokens_used).join(" "),
      });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  getBudgetSummary,
  rmbFromTokens,
  patchModelRates,
  RMB_PER_M_TOKEN: BLEND_RMB_PER_M_OFF,
};
