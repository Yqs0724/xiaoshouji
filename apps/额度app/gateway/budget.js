/**
 * 额度汇总（只读）：聚合各 App 已记 tokens_used，粗算 ¥。
 * 本 App 自身本刀不计费；统一账本流水以后再接。
 */
const path = require("node:path");
const { listSessions, getOpenSession } = require("../../共读app/gateway/sessions");
const { readSettings, tokensFromBudgetRmb } = require("../../共读app/gateway/settings");
const { readAll: readChat } = require("../../聊天app/gateway/daily-chat");
const { readAll: readWatch } = require("../../共看app/gateway/watch");
const { readAll: readListen } = require("../../共听app/gateway/listen");
const { readAll: readCal } = require("../../日历app/gateway/calendar");

/** 与 settings.js 一致：约 2.5 元 / 百万 token */
const RMB_PER_M_TOKEN = 2.5;

function rmbFromTokens(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  return Math.round((n / 1e6) * RMB_PER_M_TOKEN * 100) / 100;
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

function line(id, lab, tokens, note) {
  const tokens_used = Math.max(0, Math.floor(Number(tokens) || 0));
  return {
    id,
    lab,
    tokens_used,
    rmb: rmbFromTokens(tokens_used),
    note: note || "",
  };
}

/** GET /api/v1/budget/summary */
function getBudgetSummary() {
  const settings = readSettings();
  const default_budget_rmb = Math.max(0, Number(settings.default_budget_rmb) || 0);
  const default_budget_tokens = tokensFromBudgetRmb(default_budget_rmb);

  const apps = [
    line("coread", "共读", sumCoreadTokens(), "场次 + 进行中"),
    line("chat", "聊天", readChat().tokens_used, "日常短讯线程"),
    line("cowatch", "共看", sumPassTokens(readWatch().passes), "各场吐槽累计"),
    line("colisten", "共听", sumPassTokens(readListen().passes), "各场吐槽累计"),
    line("cal", "日历", readCal().tokens_used, "让家机排累计"),
    line("budget", "额度", 0, "本 App 暂不计费"),
  ];

  const tokens_used = apps.reduce((a, x) => a + x.tokens_used, 0);
  const rmb = rmbFromTokens(tokens_used);

  return {
    ok: true,
    rate: { rmb_per_m_token: RMB_PER_M_TOKEN },
    default_budget_rmb,
    default_budget_tokens,
    tokens_used,
    rmb,
    apps,
  };
}

if (require.main === module) {
  const s = getBudgetSummary();
  console.assert(s.ok && Array.isArray(s.apps) && s.apps.length >= 4);
  console.assert(typeof s.rmb === "number");
  console.assert(s.apps.some((a) => a.id === "budget" && a.tokens_used === 0));
  console.log("budget ok", {
    tokens: s.tokens_used,
    rmb: s.rmb,
    apps: s.apps.map((a) => a.id + ":" + a.tokens_used).join(" "),
  });
}

module.exports = {
  getBudgetSummary,
  rmbFromTokens,
  RMB_PER_M_TOKEN,
};
