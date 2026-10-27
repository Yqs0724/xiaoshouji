/**
 * 剧情经济事件：人工确认后改零花 / 剧场（叠 walletAdjust / wealthAdjust）。
 * 不自动扫聊天；已 applied 的 id 不再执行（幂等）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { walletAdjust, readWallet, writeWallet } = require("./wallet");
const { wealthAdjust, readWealth, writeWealth, WEALTH_PATH } = require("./wealth");

const DATA_DIR = path.join(__dirname, "..", "data");
const EVENTS_PATH = path.join(DATA_DIR, "economy-events.json");
const EVENTS_MAX = 200;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_PATH)) {
    fs.writeFileSync(EVENTS_PATH, JSON.stringify({ events: [] }, null, 2), "utf8");
  }
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
    const events = Array.isArray(raw.events) ? raw.events : [];
    return { events };
  } catch {
    return { events: [] };
  }
}

function writeStore(store) {
  ensureFile();
  let events = Array.isArray(store.events) ? store.events : [];
  if (events.length > EVENTS_MAX) events = events.slice(-EVENTS_MAX);
  fs.writeFileSync(EVENTS_PATH, JSON.stringify({ events }, null, 2), "utf8");
  return { events };
}

function sanitizeEffect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const book = String(raw.book || "").trim();
  if (book === "pocket") {
    const who = raw.who === "bot" ? "bot" : "you";
    const delta = roundMoney(raw.delta);
    if (!Number.isFinite(delta) || delta === 0) return null;
    const cardId = String(raw.cardId || "").trim().slice(0, 64);
    return cardId ? { book: "pocket", who, delta, cardId } : { book: "pocket", who, delta };
  }
  if (book === "theater") {
    const deltaNetWorth = roundMoney(raw.deltaNetWorth != null ? raw.deltaNetWorth : raw.delta);
    if (!Number.isFinite(deltaNetWorth) || deltaNetWorth === 0) return null;
    return { book: "theater", deltaNetWorth };
  }
  return null;
}

function sanitizeEffects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 8)) {
    const e = sanitizeEffect(item);
    if (e) out.push(e);
  }
  return out;
}

function listEvents() {
  const { events } = readStore();
  return { ok: true, events: events.slice(-40).reverse() };
}

function createEvent(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const title = String(o.title || "").trim().slice(0, 80);
  const note = String(o.note || "").trim().slice(0, 120);
  const effects = sanitizeEffects(o.effects);
  if (!title) {
    const err = new Error("缺少事件标题");
    err.code = "bad_economy_event";
    throw err;
  }
  if (!effects.length) {
    const err = new Error("至少一项零花或剧场变动");
    err.code = "bad_economy_event";
    throw err;
  }
  const event = {
    id: randomUUID(),
    ts: Date.now(),
    title,
    note,
    effects,
    applied: false,
    appliedAt: null,
    result: null,
  };
  const store = readStore();
  store.events.push(event);
  writeStore(store);
  return { ok: true, event };
}

function findEvent(id) {
  const store = readStore();
  const event = store.events.find((e) => e && e.id === id);
  return { store, event };
}

/**
 * ponytail: 多 effect 顺序落盘，中途失败不自动回滚；未标 applied 可人工补救后再点。
 * 升级：事务快照或单 effect 事件。
 */
function applyEvent(id) {
  const want = String(id || "").trim();
  if (!want) {
    const err = new Error("缺少事件 id");
    err.code = "bad_economy_event";
    throw err;
  }
  const { store, event } = findEvent(want);
  if (!event) {
    const err = new Error("事件不存在");
    err.code = "economy_event_missing";
    throw err;
  }
  if (event.applied) {
    return { ok: true, event, already_applied: true };
  }

  const walletBefore = readWallet();
  const wealthBefore = readWealth();
  const results = [];
  try {
    for (const fx of event.effects) {
      if (fx.book === "pocket") {
        const r = walletAdjust({
          who: fx.who,
          delta: fx.delta,
          cardId: fx.cardId,
          note: (event.title + (event.note ? " · " + event.note : "")).slice(0, 120),
        });
        results.push({
          book: "pocket",
          who: fx.who,
          cardId: fx.cardId,
          you_balance: r.you_balance,
          bot_balance: r.bot_balance,
          you_total: r.you_total,
          bot_total: r.bot_total,
        });
      } else if (fx.book === "theater") {
        const r = wealthAdjust({
          deltaNetWorth: fx.deltaNetWorth,
          note: (event.title + (event.note ? " · " + event.note : "")).slice(0, 120),
        });
        results.push({ book: "theater", totalNetWorth: r.wealth.totalNetWorth });
      }
    }
  } catch (e) {
    try {
      writeWallet(walletBefore);
    } catch (_) {}
    try {
      if (wealthBefore) writeWealth(wealthBefore);
      else if (fs.existsSync(WEALTH_PATH)) fs.unlinkSync(WEALTH_PATH);
    } catch (_) {}
    throw e;
  }

  event.applied = true;
  event.appliedAt = Date.now();
  event.result = results;
  writeStore(store);
  return { ok: true, event, already_applied: false };
}

/** 创建并立即入账（UI 一键） */
function createAndApply(opts) {
  const created = createEvent(opts);
  return applyEvent(created.event.id);
}

if (require.main === module) {
  const storeBefore = readStore();
  const walletSnap = readWallet();
  const wealthSnap = readWealth();
  const created = createEvent({
    title: "selfcheck",
    note: "economy",
    effects: [
      { book: "pocket", who: "you", delta: 3 },
      { book: "theater", deltaNetWorth: 5 },
    ],
  });
  console.assert(created.ok && created.event.id);
  const once = applyEvent(created.event.id);
  console.assert(once.ok && !once.already_applied);
  const twice = applyEvent(created.event.id);
  console.assert(twice.ok && twice.already_applied);
  writeWallet(walletSnap);
  if (wealthSnap) writeWealth(wealthSnap);
  else if (fs.existsSync(WEALTH_PATH)) {
    try {
      fs.unlinkSync(WEALTH_PATH);
    } catch (_) {}
  }
  writeStore(storeBefore);
  console.log("economy-events ok");
}

module.exports = {
  listEvents,
  createEvent,
  applyEvent,
  createAndApply,
  EVENTS_PATH,
};
