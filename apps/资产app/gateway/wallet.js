/**
 * 模拟钱包（角色/用户玩法余额）。
 * 聊天红包/转账只动 you_balance / bot_balance（聊天零花桶）。
 * cards[]：储蓄计入可花合计；信用卡记额度/应还，不进可花合计。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const WALLET_PATH = path.join(DATA_DIR, "wallet.json");
const SEED_BALANCE = 1000;
const LEDGER_MAX = 200;
const CARDS_MAX = 24;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WALLET_PATH)) {
    fs.writeFileSync(
      WALLET_PATH,
      JSON.stringify(
        {
          you_balance: SEED_BALANCE,
          bot_balance: SEED_BALANCE,
          cards: [],
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

function sanitizeCard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "credit" ? "credit" : "debit";
  const owner = raw.owner === "bot" ? "bot" : "you";
  const label = String(raw.label || "").trim().slice(0, 40) || (kind === "credit" ? "信用卡" : "储蓄卡");
  const tier = String(raw.tier || "").trim().slice(0, 16);
  const card = {
    id: String(raw.id || randomUUID()).slice(0, 64),
    owner,
    kind,
    label,
    tier,
  };
  if (kind === "credit") {
    card.limit = roundMoney(Math.max(0, Number(raw.limit) || 0));
    card.due = roundMoney(Math.max(0, Number(raw.due) || 0));
    card.bal = 0;
  } else {
    card.bal = roundMoney(Math.max(0, Number(raw.bal) || 0));
    card.limit = 0;
    card.due = 0;
  }
  return card;
}

function sanitizeCards(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list.slice(0, CARDS_MAX)) {
    const c = sanitizeCard(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function readWallet() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
    return {
      you_balance: roundMoney(Math.max(0, Number(raw.you_balance) || 0)),
      bot_balance: roundMoney(Math.max(0, Number(raw.bot_balance) || 0)),
      cards: sanitizeCards(raw.cards),
      ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    };
  } catch {
    return {
      you_balance: SEED_BALANCE,
      bot_balance: SEED_BALANCE,
      cards: [],
      ledger: [],
    };
  }
}

function writeWallet(data) {
  ensureFile();
  const you_balance = roundMoney(Math.max(0, Number(data.you_balance) || 0));
  const bot_balance = roundMoney(Math.max(0, Number(data.bot_balance) || 0));
  const cards = sanitizeCards(data.cards);
  let ledger = Array.isArray(data.ledger) ? data.ledger : [];
  if (ledger.length > LEDGER_MAX) ledger = ledger.slice(-LEDGER_MAX);
  const out = { you_balance, bot_balance, cards, ledger };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(out, null, 2), "utf8");
  return out;
}

function debitSum(w, who) {
  return (w.cards || [])
    .filter((c) => c.owner === who && c.kind === "debit")
    .reduce((s, c) => s + (Number(c.bal) || 0), 0);
}

function spendable(w, who) {
  const base = who === "bot" ? w.bot_balance : w.you_balance;
  return roundMoney(base + debitSum(w, who));
}

function getWallet() {
  const w = readWallet();
  return {
    ok: true,
    you_balance: w.you_balance,
    bot_balance: w.bot_balance,
    you_total: spendable(w, "you"),
    bot_total: spendable(w, "bot"),
    cards: w.cards,
    ledger: w.ledger.slice(-40),
  };
}

/**
 * from/to: "you" | "bot"
 * kind: "redpacket" | "transfer" | …
 * 只动聊天零花桶（与银行卡分账）。
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
    you_total: spendable(saved, "you"),
    bot_total: spendable(saved, "bot"),
    cards: saved.cards,
  };
}

/**
 * 手充/调账：无 cardId → 聊天零花桶；有 cardId → 对应卡（储蓄改 bal，信用卡改 due）。
 */
function walletAdjust(opts) {
  const who = opts && opts.who === "bot" ? "bot" : "you";
  const delta = roundMoney(opts && opts.delta);
  const note = String((opts && opts.note) || "").trim().slice(0, 120);
  const cardId = String((opts && opts.cardId) || "").trim();
  if (!Number.isFinite(delta) || delta === 0) {
    const err = new Error("调账金额无效");
    err.code = "bad_wallet_amount";
    throw err;
  }
  const w = readWallet();
  let card = null;
  if (cardId) {
    card = w.cards.find((c) => c.id === cardId);
    if (!card) {
      const err = new Error("银行卡不存在");
      err.code = "card_missing";
      throw err;
    }
    if (card.owner !== who) {
      const err = new Error("卡归属与 who 不一致");
      err.code = "bad_wallet_party";
      throw err;
    }
    if (card.kind === "credit") {
      const next = roundMoney(card.due + delta);
      if (next < -1e-9) {
        const err = new Error("调账后应还不能为负");
        err.code = "wallet_insufficient";
        throw err;
      }
      card.due = Math.max(0, next);
    } else {
      const next = roundMoney(card.bal + delta);
      if (next < -1e-9) {
        const err = new Error("调账后卡余额不足");
        err.code = "wallet_insufficient";
        throw err;
      }
      card.bal = Math.max(0, next);
    }
  } else {
    const key = who === "bot" ? "bot_balance" : "you_balance";
    const next = roundMoney(w[key] + delta);
    if (next < -1e-9) {
      const err = new Error("调账后余额不足");
      err.code = "wallet_insufficient";
      throw err;
    }
    w[key] = Math.max(0, next);
  }
  const amount = roundMoney(Math.abs(delta));
  const entry = {
    id: randomUUID(),
    ts: Date.now(),
    kind: "adjust",
    from: delta > 0 ? "system" : who,
    to: delta > 0 ? who : "system",
    amount,
    note: note || (delta > 0 ? "调账入账" : "调账扣减"),
    card_id: card ? card.id : undefined,
  };
  w.ledger.push(entry);
  const saved = writeWallet(w);
  return {
    ok: true,
    entry,
    you_balance: saved.you_balance,
    bot_balance: saved.bot_balance,
    you_total: spendable(saved, "you"),
    bot_total: spendable(saved, "bot"),
    cards: saved.cards,
  };
}

function addCard(opts) {
  const w = readWallet();
  if (w.cards.length >= CARDS_MAX) {
    const err = new Error("银行卡过多");
    err.code = "cards_full";
    throw err;
  }
  const card = sanitizeCard({
    id: randomUUID(),
    owner: opts && opts.owner,
    kind: opts && opts.kind,
    label: opts && opts.label,
    tier: opts && opts.tier,
    bal: opts && opts.bal,
    limit: opts && opts.limit,
    due: opts && opts.due,
  });
  if (!card) {
    const err = new Error("银行卡无效");
    err.code = "bad_card";
    throw err;
  }
  w.cards.push(card);
  const saved = writeWallet(w);
  return { ok: true, card, cards: saved.cards, you_total: spendable(saved, "you"), bot_total: spendable(saved, "bot") };
}

function patchCard(id, opts) {
  const w = readWallet();
  const card = w.cards.find((c) => c.id === String(id || "").trim());
  if (!card) {
    const err = new Error("银行卡不存在");
    err.code = "card_missing";
    throw err;
  }
  const o = opts && typeof opts === "object" ? opts : {};
  if (o.label != null) card.label = String(o.label).trim().slice(0, 40) || card.label;
  if (o.tier != null) card.tier = String(o.tier).trim().slice(0, 16);
  if (card.kind === "credit") {
    if (o.limit != null) card.limit = roundMoney(Math.max(0, Number(o.limit) || 0));
    if (o.due != null) card.due = roundMoney(Math.max(0, Number(o.due) || 0));
  } else if (o.bal != null) {
    card.bal = roundMoney(Math.max(0, Number(o.bal) || 0));
  }
  const saved = writeWallet(w);
  return { ok: true, card, cards: saved.cards, you_total: spendable(saved, "you"), bot_total: spendable(saved, "bot") };
}

function removeCard(id) {
  const w = readWallet();
  const want = String(id || "").trim();
  const before = w.cards.length;
  w.cards = w.cards.filter((c) => c.id !== want);
  if (w.cards.length === before) {
    const err = new Error("银行卡不存在");
    err.code = "card_missing";
    throw err;
  }
  const saved = writeWallet(w);
  return { ok: true, cards: saved.cards, you_total: spendable(saved, "you"), bot_total: spendable(saved, "bot") };
}

if (require.main === module) {
  const before = readWallet();
  const snap = {
    you_balance: before.you_balance,
    bot_balance: before.bot_balance,
    cards: before.cards,
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
  writeWallet(snap);
  const added = addCard({ owner: "you", kind: "debit", label: "工行储蓄", bal: 100 });
  console.assert(added.ok && added.card.bal === 100);
  console.assert(Math.abs(added.you_total - (snap.you_balance + 100)) < 1e-6);
  const adj = walletAdjust({ who: "you", delta: 20, cardId: added.card.id, note: "卡入账" });
  console.assert(adj.cards.find((c) => c.id === added.card.id).bal === 120);
  const cc = addCard({ owner: "you", kind: "credit", label: "金卡", limit: 50000, due: 1000, tier: "gold" });
  console.assert(cc.card.kind === "credit");
  console.assert(Math.abs(spendable(readWallet(), "you") - (snap.you_balance + 120)) < 1e-6);
  removeCard(added.card.id);
  removeCard(cc.card.id);
  writeWallet(snap);
  console.log("wallet ok");
}

module.exports = {
  getWallet,
  readWallet,
  writeWallet,
  walletTransfer,
  walletAdjust,
  addCard,
  patchCard,
  removeCard,
  spendable,
  WALLET_PATH,
  SEED_BALANCE,
};
