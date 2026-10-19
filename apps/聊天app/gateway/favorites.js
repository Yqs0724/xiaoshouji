/**
 * 收藏落库（H1.3）：聊天气泡 / 朋友圈摘句 → favorites.json
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const FAV_PATH = path.join(DATA_DIR, "favorites.json");
const TEXT_MAX = 400;
const META_MAX = 64;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FAV_PATH)) {
    fs.writeFileSync(
      FAV_PATH,
      JSON.stringify({ items: [] }, null, 2),
      "utf8"
    );
  }
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text || raw.t || "").trim().slice(0, TEXT_MAX);
  if (!text) return null;
  const src = raw.src === "moments" ? "moments" : "chat";
  return {
    id: String(raw.id || randomUUID()),
    src,
    refId: String(raw.refId || raw.ref_id || "").trim().slice(0, 64),
    text,
    meta: String(raw.meta || "").trim().slice(0, META_MAX),
    ts: Number(raw.ts) || Date.now(),
  };
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(FAV_PATH, "utf8"));
    const items = Array.isArray(raw.items)
      ? raw.items.map(normalizeItem).filter(Boolean)
      : [];
    items.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    return { items };
  } catch (_) {
    return { items: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(
    FAV_PATH,
    JSON.stringify({ items: Array.isArray(data.items) ? data.items : [] }, null, 2),
    "utf8"
  );
}

function listFavorites() {
  return { ok: true, items: readAll().items };
}

function addFavorite(patch) {
  const item = normalizeItem({
    id: randomUUID(),
    src: patch && patch.src,
    refId: patch && (patch.refId || patch.ref_id),
    text: patch && (patch.text || patch.t),
    meta: patch && patch.meta,
    ts: Date.now(),
  });
  if (!item) {
    const err = new Error("收藏内容为空");
    err.code = "empty_text";
    throw err;
  }
  const all = readAll();
  /* 同 src+refId 或同正文已有则不重复加 */
  const dup = all.items.find(
    (x) =>
      (item.refId && x.src === item.src && x.refId === item.refId) ||
      x.text === item.text
  );
  if (dup) return { ok: true, item: dup, existed: true };
  all.items.unshift(item);
  writeAll(all);
  return { ok: true, item, existed: false };
}

function removeFavorite(id) {
  const sid = String(id || "");
  const all = readAll();
  const before = all.items.length;
  all.items = all.items.filter((x) => x.id !== sid);
  if (all.items.length === before) {
    const err = new Error("收藏不存在");
    err.code = "not_found";
    throw err;
  }
  writeAll(all);
  return { ok: true, id: sid };
}

module.exports = {
  listFavorites,
  addFavorite,
  removeFavorite,
  FAV_PATH,
};

if (require.main === module) {
  const stamp = "fav-selfcheck-" + Date.now();
  const a = addFavorite({ text: stamp, meta: "自检 · 聊天", src: "chat", refId: "r1" });
  console.assert(a.ok && a.item && a.item.text === stamp);
  const again = addFavorite({ text: stamp, meta: "自检", src: "chat", refId: "r1" });
  console.assert(again.existed === true);
  console.assert(listFavorites().items.some((x) => x.id === a.item.id));
  removeFavorite(a.item.id);
  console.assert(!listFavorites().items.some((x) => x.id === a.item.id));
  console.log("favorites selfcheck ok");
}
