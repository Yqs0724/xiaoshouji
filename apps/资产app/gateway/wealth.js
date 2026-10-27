/**
 * 剧场资本落盘（≠ 聊天零花 wallet.json）。
 * 摘要 + 可选轻量矩阵（开局档）；无矩阵时前端仍用 DEMO 种子。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const WEALTH_PATH = path.join(DATA_DIR, "wealth.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function sanitizeHolding(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    en: String(raw.en || "").slice(0, 80),
    cn: String(raw.cn || "").slice(0, 80),
    code: String(raw.code || "").slice(0, 24),
    cost: Number(raw.cost) || 0,
    qty: Number(raw.qty) || 0,
    pnl: Number(raw.pnl) || 0,
    custodian: String(raw.custodian || "").slice(0, 40),
    pledged: String(raw.pledged || "No").slice(0, 24),
    lastTrade: String(raw.lastTrade || "—").slice(0, 24),
    risk: String(raw.risk || "—").slice(0, 40),
  };
}

function sanitizeCategories(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let catN = 0;
  for (const [ck, cat] of Object.entries(raw)) {
    if (catN >= 4 || !cat || typeof cat !== "object") continue;
    const subsIn = cat.subs && typeof cat.subs === "object" ? cat.subs : {};
    const subs = {};
    let subN = 0;
    for (const [sk, sub] of Object.entries(subsIn)) {
      if (subN >= 4 || !sub || typeof sub !== "object") continue;
      const items = Array.isArray(sub.items)
        ? sub.items.map(sanitizeHolding).filter(Boolean).slice(0, 8)
        : [];
      subs[String(sk).slice(0, 32)] = {
        en: String(sub.en || "").slice(0, 80),
        cn: String(sub.cn || "").slice(0, 80),
        items,
      };
      subN += 1;
    }
    out[String(ck).slice(0, 32)] = {
      en: String(cat.en || "").slice(0, 80),
      cn: String(cat.cn || "").slice(0, 80),
      subs,
    };
    catN += 1;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const allocation = Array.isArray(raw.allocation)
    ? raw.allocation
        .filter((a) => a && typeof a === "object")
        .slice(0, 24)
        .map((a) => ({
          en: String(a.en || "").slice(0, 80),
          cn: String(a.cn || "").slice(0, 80),
          pct: Math.max(0, Math.min(100, Math.round(Number(a.pct) || 0))),
          color: String(a.color || "#9ec9bc").slice(0, 32),
        }))
    : [];
  const out = {
    owner: String(raw.owner || "").slice(0, 64),
    currency: String(raw.currency || "USD").slice(0, 8),
    totalNetWorth: roundMoney(Math.max(0, Number(raw.totalNetWorth) || 0)),
    change24h: Number.isFinite(Number(raw.change24h)) ? Number(raw.change24h) : 0,
    allocation,
    savedAt: Number(raw.savedAt) || Date.now(),
  };
  if (raw.lastAdjustNote) out.lastAdjustNote = String(raw.lastAdjustNote).slice(0, 120);
  if (raw.lastAdjustAt) out.lastAdjustAt = Number(raw.lastAdjustAt) || undefined;
  if (raw.tierId) out.tierId = String(raw.tierId).slice(0, 16);
  if (raw.matrix) out.matrix = String(raw.matrix).slice(0, 16);
  const cats = sanitizeCategories(raw.categories);
  if (cats) out.categories = cats;
  if (Array.isArray(raw.coreHoldings)) {
    out.coreHoldings = raw.coreHoldings.map(sanitizeHolding).filter(Boolean).slice(0, 16);
  }
  if (Array.isArray(raw.feedPool)) {
    out.feedPool = raw.feedPool
      .filter((row) => Array.isArray(row))
      .slice(0, 20)
      .map((row) => row.slice(0, 3).map((x) => String(x == null ? "" : x).slice(0, 40)));
  }
  return out;
}

function readWealth() {
  ensureDir();
  if (!fs.existsSync(WEALTH_PATH)) return null;
  try {
    return sanitizeSnapshot(JSON.parse(fs.readFileSync(WEALTH_PATH, "utf8")));
  } catch {
    return null;
  }
}

function writeWealth(raw) {
  ensureDir();
  const snap = sanitizeSnapshot(raw);
  if (!snap) {
    const err = new Error("bad_wealth");
    err.code = "bad_wealth";
    throw err;
  }
  snap.savedAt = Date.now();
  fs.writeFileSync(WEALTH_PATH, JSON.stringify(snap, null, 2), "utf8");
  return snap;
}

function getWealth() {
  const wealth = readWealth();
  return { ok: true, wealth };
}

function putWealth(raw) {
  const wealth = writeWealth(raw && raw.wealth != null ? raw.wealth : raw);
  return { ok: true, wealth };
}

/**
 * 剧场摘要调账：优先 totalNetWorth 绝对值；否则 deltaNetWorth 相对加减。
 * 不碰零花（D36/D41）。
 */
function wealthAdjust(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cur = readWealth() || {
    owner: "",
    currency: "USD",
    totalNetWorth: 0,
    change24h: 0,
    allocation: [],
  };
  let next;
  if (o.totalNetWorth != null && o.totalNetWorth !== "") {
    next = roundMoney(Math.max(0, Number(o.totalNetWorth) || 0));
  } else if (o.deltaNetWorth != null && o.deltaNetWorth !== "") {
    next = roundMoney(Math.max(0, (Number(cur.totalNetWorth) || 0) + Number(o.deltaNetWorth)));
  } else {
    const err = new Error("缺少 totalNetWorth 或 deltaNetWorth");
    err.code = "bad_wealth_adjust";
    throw err;
  }
  if (!Number.isFinite(next)) {
    const err = new Error("剧场调账金额无效");
    err.code = "bad_wealth_adjust";
    throw err;
  }
  const note = String(o.note || "").trim().slice(0, 120);
  const wealth = writeWealth({
    ...cur,
    totalNetWorth: next,
    lastAdjustNote: note || undefined,
    lastAdjustAt: Date.now(),
  });
  return { ok: true, wealth };
}

if (require.main === module) {
  const before = readWealth();
  const t = putWealth({
    owner: "SELFCHECK",
    currency: "USD",
    totalNetWorth: 42.5,
    change24h: 0.01,
    allocation: [{ en: "Cash", cn: "现金", pct: 100, color: "#9ec9bc" }],
    matrix: "lite",
    tierId: "poor",
    categories: {
      cash: {
        en: "01",
        cn: "现金",
        subs: {
          bank: {
            en: "Bank",
            cn: "银行",
            items: [{ en: "A", cn: "活期", code: "A", cost: 1, qty: 10, pnl: 0, custodian: "B", pledged: "No", lastTrade: "—", risk: "Low" }],
          },
        },
      },
    },
    coreHoldings: [{ en: "A", cn: "活期", code: "A", cost: 1, qty: 10, pnl: 0, custodian: "B", pledged: "No", lastTrade: "—", risk: "Low" }],
  });
  console.assert(t.ok && t.wealth.totalNetWorth === 42.5);
  console.assert(readWealth().owner === "SELFCHECK");
  console.assert(readWealth().matrix === "lite" && readWealth().categories);
  const a = wealthAdjust({ deltaNetWorth: 7.5, note: "selfcheck" });
  console.assert(a.ok && Math.abs(a.wealth.totalNetWorth - 50) < 1e-6);
  const b = wealthAdjust({ totalNetWorth: 10 });
  console.assert(Math.abs(b.wealth.totalNetWorth - 10) < 1e-6);
  if (before) writeWealth(before);
  else if (fs.existsSync(WEALTH_PATH)) fs.unlinkSync(WEALTH_PATH);
  console.log("wealth ok");
}

module.exports = {
  getWealth,
  putWealth,
  wealthAdjust,
  readWealth,
  writeWealth,
  WEALTH_PATH,
};
