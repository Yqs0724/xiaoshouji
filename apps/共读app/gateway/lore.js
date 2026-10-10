/**
 * 剧情摘要卡（X1 / D13）：短卡列表，手贴进网关；非向量库、不注入跟批。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const LORE_PATH = path.join(DATA_DIR, "lore.json");
const BODY_MAX = 8000;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LORE_PATH)) {
    fs.writeFileSync(LORE_PATH, JSON.stringify({ cards: [] }, null, 2), "utf8");
  }
}

function normalizeCard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const body = String(raw.body || "").trim();
  if (!id || !body) return null;
  const source = raw.source === "mcp" ? "mcp" : "paste";
  return {
    id,
    body: body.slice(0, BODY_MAX),
    source,
    ts: Number(raw.ts) || Date.now(),
  };
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(LORE_PATH, "utf8"));
    const cards = Array.isArray(raw.cards)
      ? raw.cards.map(normalizeCard).filter(Boolean)
      : [];
    cards.sort((a, b) => b.ts - a.ts);
    return { cards };
  } catch {
    return { cards: [] };
  }
}

function writeAll(data) {
  ensureFile();
  const cards = (data.cards || []).map(normalizeCard).filter(Boolean);
  cards.sort((a, b) => b.ts - a.ts);
  fs.writeFileSync(LORE_PATH, JSON.stringify({ cards }, null, 2), "utf8");
  return { cards };
}

function listCards() {
  return { ok: true, ...readAll() };
}

function createCard(patch) {
  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("摘要不能为空");
    err.code = "bad_lore_body";
    throw err;
  }
  const card = normalizeCard({
    id: randomUUID(),
    body,
    source: "paste",
    ts: Date.now(),
  });
  const all = readAll();
  all.cards.unshift(card);
  writeAll(all);
  return { ok: true, card };
}

function deleteCard(id) {
  const cid = String(id || "").trim();
  const all = readAll();
  const next = all.cards.filter((c) => c.id !== cid);
  if (next.length === all.cards.length) {
    const err = new Error("找不到该摘要卡");
    err.code = "lore_not_found";
    throw err;
  }
  writeAll({ cards: next });
  return { ok: true, deleted: cid };
}

if (require.main === module) {
  const stamp = "selfcheck-lore-" + Date.now();
  const created = createCard({ body: stamp });
  console.assert(created.card && created.card.body === stamp);
  console.assert(created.card.source === "paste");
  console.assert(listCards().cards.some((c) => c.id === created.card.id));
  deleteCard(created.card.id);
  console.assert(!listCards().cards.some((c) => c.id === created.card.id));
  try {
    createCard({ body: "  " });
    throw new Error("expected bad_lore_body");
  } catch (e) {
    if (e.code !== "bad_lore_body") throw e;
  }
  console.log("lore ok");
}

module.exports = {
  listCards,
  createCard,
  deleteCard,
  readAll,
  LORE_PATH,
};
