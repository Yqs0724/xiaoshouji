/**
 * 开局经济档：手选确认后重置剧场摘要 + 零花种子（含可选默认储蓄卡）。
 * 不要求已有人设；有 persona 时仅关键词建议，仍须确认。
 */
const { randomUUID } = require("node:crypto");
const { readWallet, writeWallet, spendable } = require("./wallet");
const { readWealth, writeWealth } = require("./wealth");

/** 与 NAV 同量级的轻量矩阵，避免开局档后仍钻取 DEMO 天文数 */
function liteMatrix(tierId, nav) {
  const n = Math.max(0, Number(nav) || 0);
  if (tierId === "poor") {
    return {
      matrix: "lite",
      tierId: "poor",
      categories: {
        cash: {
          en: "01 LIQUID",
          cn: "流动性",
          subs: {
            bank: {
              en: "Bank",
              cn: "银行存款",
              items: [
                { en: "Checking", cn: "活期", code: "CHK", cost: 1, qty: Math.round(n * 0.45), pnl: 0, custodian: "Local Bank", pledged: "No", lastTrade: "今天", risk: "Low" },
                { en: "Time Deposit", cn: "定期", code: "TD", cost: 1, qty: Math.round(n * 0.25), pnl: 0.1, custodian: "Local Bank", pledged: "No", lastTrade: "本月", risk: "Low" },
              ],
            },
            daily: {
              en: "Daily Buffer",
              cn: "日常备用",
              items: [
                { en: "Emergency Cash", cn: "应急现金", code: "EMG", cost: 1, qty: Math.round(n * 0.3), pnl: 0, custodian: "Cash", pledged: "No", lastTrade: "—", risk: "Ops" },
              ],
            },
          },
        },
      },
      coreHoldings: [
        { en: "Checking", cn: "活期", code: "CHK", cost: 1, qty: Math.round(n * 0.45), pnl: 0, custodian: "Local Bank", pledged: "No", lastTrade: "今天", risk: "Low" },
        { en: "Time Deposit", cn: "定期", code: "TD", cost: 1, qty: Math.round(n * 0.25), pnl: 0.1, custodian: "Local Bank", pledged: "No", lastTrade: "本月", risk: "Low" },
        { en: "Emergency Cash", cn: "应急现金", code: "EMG", cost: 1, qty: Math.round(n * 0.3), pnl: 0, custodian: "Cash", pledged: "No", lastTrade: "—", risk: "Ops" },
      ],
      feedPool: [
        ["银行", "利息入账", "+$1.20"],
        ["日常", "水电", "−$48.00"],
        ["工资", "半月结", "+$620.00"],
      ],
    };
  }
  if (tierId === "rich") {
    return {
      matrix: "lite",
      tierId: "rich",
      categories: {
        book: {
          en: "01 BOOK",
          cn: "账面",
          subs: {
            eq: {
              en: "Equity",
              cn: "权益",
              items: [
                { en: "Index Sleeve", cn: "指数袖", code: "IDX", cost: 1, qty: Math.round(n * 0.35), pnl: 8.2, custodian: "Broker", pledged: "No", lastTrade: "本周", risk: "Market" },
                { en: "Private Note", cn: "私募票据", code: "PN", cost: 1, qty: Math.round(n * 0.4), pnl: 12.0, custodian: "FO", pledged: "No", lastTrade: "本季", risk: "Illiquid" },
              ],
            },
            cash: {
              en: "Cash",
              cn: "现金",
              items: [
                { en: "Operating USD", cn: "美元运营", code: "USD", cost: 1, qty: Math.round(n * 0.25), pnl: 0, custodian: "PB", pledged: "No", lastTrade: "今天", risk: "Low" },
              ],
            },
          },
        },
      },
      coreHoldings: [
        { en: "Index Sleeve", cn: "指数袖", code: "IDX", cost: 1, qty: Math.round(n * 0.35), pnl: 8.2, custodian: "Broker", pledged: "No", lastTrade: "本周", risk: "Market" },
        { en: "Private Note", cn: "私募票据", code: "PN", cost: 1, qty: Math.round(n * 0.4), pnl: 12.0, custodian: "FO", pledged: "No", lastTrade: "本季", risk: "Illiquid" },
        { en: "Operating USD", cn: "美元运营", code: "USD", cost: 1, qty: Math.round(n * 0.25), pnl: 0, custodian: "PB", pledged: "No", lastTrade: "今天", risk: "Low" },
      ],
      feedPool: [
        ["经纪", "分红到账", "+$42,000"],
        ["私募", "Call 通知", "−$180,000"],
        ["现金", "Sweep", "+$12,500"],
      ],
    };
  }
  // normal
  return {
    matrix: "lite",
    tierId: "normal",
    categories: {
      book: {
        en: "01 HOUSEHOLD",
        cn: "家庭账本",
        subs: {
          invest: {
            en: "Invest",
            cn: "理财",
            items: [
              { en: "Index Fund", cn: "指数基金", code: "ETF", cost: 1, qty: Math.round(n * 0.4), pnl: 4.2, custodian: "Broker", pledged: "No", lastTrade: "本月", risk: "Market" },
              { en: "Money Market", cn: "货基", code: "MMF", cost: 1, qty: Math.round(n * 0.25), pnl: 0.3, custodian: "Fund", pledged: "No", lastTrade: "今天", risk: "Low" },
            ],
          },
          cash: {
            en: "Cash",
            cn: "现金",
            items: [
              { en: "Salary Account", cn: "工资户", code: "SAL", cost: 1, qty: Math.round(n * 0.35), pnl: 0, custodian: "Bank", pledged: "No", lastTrade: "发薪日", risk: "Low" },
            ],
          },
        },
      },
    },
    coreHoldings: [
      { en: "Index Fund", cn: "指数基金", code: "ETF", cost: 1, qty: Math.round(n * 0.4), pnl: 4.2, custodian: "Broker", pledged: "No", lastTrade: "本月", risk: "Market" },
      { en: "Money Market", cn: "货基", code: "MMF", cost: 1, qty: Math.round(n * 0.25), pnl: 0.3, custodian: "Fund", pledged: "No", lastTrade: "今天", risk: "Low" },
      { en: "Salary Account", cn: "工资户", code: "SAL", cost: 1, qty: Math.round(n * 0.35), pnl: 0, custodian: "Bank", pledged: "No", lastTrade: "发薪日", risk: "Low" },
    ],
    feedPool: [
      ["基金", "定投扣款", "−$800"],
      ["工资", "入账", "+$8,200"],
      ["货基", "收益", "+$12.40"],
    ],
  };
}

function withLiteWealth(base, tierId) {
  const lite = liteMatrix(tierId, base.totalNetWorth);
  return { ...base, ...lite };
}

const TIERS = [
  {
    id: "poor",
    label: "穷",
    blurb: "量入为出；剧场小几万级，零花三位数。",
    wealth: withLiteWealth(
      {
        owner: "ARIA",
        currency: "USD",
        totalNetWorth: 12800,
        change24h: -0.012,
        allocation: [
          { en: "Cash & Deposit", cn: "现金存款", pct: 55, color: "#9ec9bc" },
          { en: "Daily Spend", cn: "日常开支备用", pct: 30, color: "#6fa896" },
          { en: "Other", cn: "其它", pct: 15, color: "#c4a574" },
        ],
      },
      "poor"
    ),
    you_balance: 86.5,
    bot_balance: 42,
    cards: [
      { owner: "you", kind: "debit", label: "工资卡储蓄", bal: 1200, tier: "" },
      { owner: "bot", kind: "debit", label: "零钱卡", bal: 380, tier: "" },
    ],
  },
  {
    id: "normal",
    label: "普通",
    blurb: "工薪小康；剧场十来万，零花四位数。",
    wealth: withLiteWealth(
      {
        owner: "ARIA",
        currency: "USD",
        totalNetWorth: 186000,
        change24h: 0.004,
        allocation: [
          { en: "Equity", cn: "权益", pct: 40, color: "#9ec9bc" },
          { en: "Cash", cn: "现金", pct: 35, color: "#6fa896" },
          { en: "Other", cn: "其它", pct: 25, color: "#c4a574" },
        ],
      },
      "normal"
    ),
    you_balance: 1000,
    bot_balance: 1000,
    cards: [
      { owner: "you", kind: "debit", label: "招行储蓄 ****8876", bal: 18600, tier: "" },
      { owner: "bot", kind: "debit", label: "工行储蓄 ****1024", bal: 9200, tier: "" },
    ],
  },
  {
    id: "rich",
    label: "富",
    blurb: "高净值叙事；剧场百万～千万，零花充裕。",
    wealth: withLiteWealth(
      {
        owner: "ARIA",
        currency: "USD",
        totalNetWorth: 12800000,
        change24h: 0.008,
        allocation: [
          { en: "Public Equity", cn: "公开市场", pct: 35, color: "#9ec9bc" },
          { en: "Private", cn: "另类", pct: 40, color: "#6fa896" },
          { en: "Cash", cn: "现金", pct: 25, color: "#c4a574" },
        ],
      },
      "rich"
    ),
    you_balance: 5200,
    bot_balance: 3800,
    cards: [
      { owner: "you", kind: "debit", label: "私行储蓄", bal: 280000, tier: "gold" },
      { owner: "you", kind: "credit", label: "金卡", bal: 0, limit: 200000, due: 12600, tier: "gold" },
      { owner: "bot", kind: "debit", label: "日常卡", bal: 48000, tier: "" },
    ],
  },
];

const SUGGEST_RULES = [
  { id: "poor", re: /穷|赤贫|吃土|月光|欠债|低保|打工渡日|身无分文|经济困难/i },
  {
    id: "rich",
    re: /富豪|亿万|财阀|豪门|信托|家族办公室|高净值|首富|资本|总裁|董事长|豪车|别墅|多套房|房产|有钱|富二代|私企老板|继承.{0,20}遗产|私人飞机|游艇/i,
  },
  { id: "normal", re: /工薪|上班|普通|小康|打工人|白领/i },
];

function listTiers() {
  return TIERS.map((t) => ({
    id: t.id,
    label: t.label,
    blurb: t.blurb,
    wealth_nav: t.wealth.totalNetWorth,
    you_balance: t.you_balance,
    bot_balance: t.bot_balance,
  }));
}

function getTier(id) {
  return TIERS.find((t) => t.id === String(id || "").trim()) || null;
}

/** 无人设 / 无命中 → suggested null（不影响手选） */
function suggestFromPersona(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { suggested: null, reason: "no_persona" };
  }
  for (const rule of SUGGEST_RULES) {
    if (rule.re.test(raw)) {
      return { suggested: rule.id, reason: "keyword", snippet: raw.slice(0, 80) };
    }
  }
  return { suggested: null, reason: "no_match" };
}

function applyTier(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (!o.confirm) {
    const err = new Error("须 confirm:true 才重置开局档");
    err.code = "confirm_required";
    throw err;
  }
  const tier = getTier(o.tier);
  if (!tier) {
    const err = new Error("未知开局档");
    err.code = "bad_tier";
    throw err;
  }

  const wealth = writeWealth({
    ...tier.wealth,
    lastAdjustNote: "开局档 · " + tier.label,
    lastAdjustAt: Date.now(),
  });

  const before = readWallet();
  const cards = (tier.cards || []).map((c) => ({
    ...c,
    id: randomUUID(),
  }));
  const note = "开局档 · " + tier.label;
  const ledger = Array.isArray(before.ledger) ? before.ledger.slice() : [];
  ledger.push({
    id: randomUUID(),
    ts: Date.now(),
    kind: "adjust",
    from: "system",
    to: "you",
    amount: tier.you_balance,
    note,
  });
  ledger.push({
    id: randomUUID(),
    ts: Date.now(),
    kind: "adjust",
    from: "system",
    to: "bot",
    amount: tier.bot_balance,
    note,
  });
  const saved = writeWallet({
    you_balance: tier.you_balance,
    bot_balance: tier.bot_balance,
    cards,
    ledger,
  });

  return {
    ok: true,
    tier: tier.id,
    wealth,
    you_balance: saved.you_balance,
    bot_balance: saved.bot_balance,
    you_total: spendable(saved, "you"),
    bot_total: spendable(saved, "bot"),
    cards: saved.cards,
  };
}

if (require.main === module) {
  const w0 = readWallet();
  const h0 = readWealth();
  const s = suggestFromPersona("");
  console.assert(s.suggested == null && s.reason === "no_persona");
  const s2 = suggestFromPersona("他是个吃土的打工人");
  console.assert(s2.suggested === "poor");
  try {
    applyTier({ tier: "poor" });
    throw new Error("expected confirm_required");
  } catch (e) {
    if (e.code !== "confirm_required") throw e;
  }
  const out = applyTier({ tier: "poor", confirm: true });
  console.assert(out.ok && out.wealth.totalNetWorth === 12800);
  console.assert(out.you_balance === 86.5);
  console.assert(out.wealth.matrix === "lite" && out.wealth.categories);
  console.assert(Array.isArray(out.wealth.coreHoldings) && out.wealth.coreHoldings.length >= 1);
  const maxQty = Math.max.apply(
    null,
    out.wealth.coreHoldings.map(function (h) {
      return Number(h.qty) || 0;
    })
  );
  console.assert(maxQty < 100000);
  writeWallet(w0);
  if (h0) writeWealth(h0);
  console.log("economy-tiers ok");
}

module.exports = {
  listTiers,
  getTier,
  suggestFromPersona,
  applyTier,
  TIERS,
};
