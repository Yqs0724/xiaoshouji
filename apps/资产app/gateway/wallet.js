/**
 * 模拟钱包（角色/用户玩法余额）。
 * 与额度 App 的 LLM tokens / 费用粗算无关；日后总资产模块接管本文件与 wallet.json。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const WALLET_PATH = path.join(DATA_DIR, "wallet.json");
const SEED_BALANCE = 1000;
const LEDGER_MAX = 200;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WALLET_PATH)) {
    fs.writeFileSync(
      WALLET_PATH,
      JSON.stringify(
        {
          you_balance: SEED_BALANCE,
          bot_balance: SEED_BALANCE,
          ledger: [],
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function readWallet() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
    return {
      you_balance: roundMoney(Math.max(0, Number(raw.you_balance) || 0)),
      bot_balance: roundMoney(Math.max(0, Number(raw.bot_balance) || 0)),
      ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    };
  } catch {
    return {
      you_balance: SEED_BALANCE,
      bot_balance: SEED_BALANCE,
      ledger: [],
    };
  }
}

function writeWallet(data) {
  ensureFile();
  const you_balance = roundMoney(Math.max(0, Number(data.you_balance) || 0));
  const bot_balance = roundMoney(Math.max(0, Number(data.bot_balance) || 0));
  let ledger = Array.isArray(data.ledger) ? data.ledger : [];
  if (ledger.length > LEDGER_MAX) ledger = ledger.slice(-LEDGER_MAX);
  const out = { you_balance, bot_balance, ledger };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(out, null, 2), "utf8");
  return out;
}

function getWallet() {
  const w = readWallet();
  return {
    ok: true,
    you_balance: w.you_balance,
    bot_balance: w.bot_balance,
    ledger: w.ledger.slice(-40),
  };
}

/**
 * from/to: "you" | "bot"
 * kind: "redpacket" | "transfer" | …
 */
function walletTransfer(opts) {
  const from = opts && opts.from === "bot" ? "bot" : "you";
  const to = opts && opts.to === "bot" ? "bot" : "you";
  const amount = roundMoney(opts && opts.amount);
  const kind = String((opts && opts.kind) || "transfer").trim() || "transfer";
  const note = String((opts && opts.note) || "").trim().slice(0, 80);
  const msg_id = String((opts && opts.msg_id) || "").trim();

  if (!(amount > 0)) {
    const err = new Error("金额无效");
    err.code = "bad_wallet_amount";
    throw err;
  }
  if (from === to) {
    const err = new Error("收付款方不能相同");
    err.code = "bad_wallet_party";
    throw err;
  }

  const w = readWallet();
  const fromKey = from === "bot" ? "bot_balance" : "you_balance";
  const toKey = to === "bot" ? "bot_balance" : "you_balance";
  if (w[fromKey] + 1e-9 < amount) {
    const err = new Error("余额不足");
    err.code = "wallet_insufficient";
    throw err;
  }
  w[fromKey] = roundMoney(w[fromKey] - amount);
  w[toKey] = roundMoney(w[toKey] + amount);
  const entry = {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    from,
    to,
    amount,
    note,
    msg_id: msg_id || undefined,
  };
  w.ledger.push(entry);
  const saved = writeWallet(w);
  return {
    ok: true,
    entry,
    you_balance: saved.you_balance,
    bot_balance: saved.bot_balance,
  };
}

if (require.main === module) {
  const before = readWallet();
  const snap = {
    you_balance: before.you_balance,
    bot_balance: before.bot_balance,
    ledger: before.ledger,
  };
  const t = walletTransfer({
    from: "you",
    to: "bot",
    amount: 1.23,
    kind: "transfer",
    note: "selfcheck",
  });
  console.assert(t.ok && t.entry.amount === 1.23);
  console.assert(Math.abs(t.you_balance - (snap.you_balance - 1.23)) < 1e-6);
  console.assert(Math.abs(t.bot_balance - (snap.bot_balance + 1.23)) < 1e-6);
  try {
    walletTransfer({ from: "you", to: "bot", amount: 1e12, kind: "redpacket" });
    throw new Error("expected wallet_insufficient");
  } catch (e) {
    if (e.code !== "wallet_insufficient") throw e;
  }
  writeWallet(snap);
  console.log("wallet ok");
}

module.exports = {
  getWallet,
  readWallet,
  writeWallet,
  walletTransfer,
  WALLET_PATH,
  SEED_BALANCE,
};
