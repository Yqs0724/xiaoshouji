/**
 * 日常聊天贴纸包：内置仅留一张测试；其余靠用户自建。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const USER_JSON = path.join(DATA_DIR, "user-stickers.json");
const USER_DIR = path.join(DATA_DIR, "user-stickers");
const STICKER_MAX_BYTES = 2 * 1024 * 1024;
const USER_ID_RE = /^user-[a-f0-9-]{36}$/;

const STICKERS = [
  { id: "decor-bear", src: "/assets/chat/stickers/decor-bear.png", label: "测试" },
];

const BY_BUILTIN = new Map(STICKERS.map((s) => [s.id, s]));

function ensureUserStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
  if (!fs.existsSync(USER_JSON)) {
    fs.writeFileSync(USER_JSON, JSON.stringify({ stickers: [] }, null, 2), "utf8");
  }
}

function readUserStickers() {
  ensureUserStore();
  try {
    const raw = JSON.parse(fs.readFileSync(USER_JSON, "utf8"));
    const list = Array.isArray(raw.stickers) ? raw.stickers : [];
    return list
      .map((s) => {
        const id = String((s && s.id) || "").trim();
        const file = String((s && s.file) || "").trim();
        const label = String((s && s.label) || "贴纸").trim().slice(0, 20) || "贴纸";
        if (!USER_ID_RE.test(id) || !file) return null;
        const abs = path.normalize(path.join(USER_DIR, file));
        if (!abs.startsWith(USER_DIR + path.sep) || !fs.existsSync(abs)) return null;
        return {
          id,
          src: "/api/v1/chat/stickers/file/" + encodeURIComponent(file),
          label,
          file,
          custom: true,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeUserStickers(list) {
  ensureUserStore();
  fs.writeFileSync(
    USER_JSON,
    JSON.stringify({ stickers: list.map((s) => ({ id: s.id, file: s.file, label: s.label })) }, null, 2),
    "utf8"
  );
}

function listStickers() {
  return STICKERS.map((s) => ({ id: s.id, src: s.src, label: s.label, custom: false }));
}

function listAllStickers() {
  return listStickers().concat(readUserStickers());
}

function getSticker(id) {
  const key = String(id || "").trim();
  if (BY_BUILTIN.has(key)) {
    const s = BY_BUILTIN.get(key);
    return { id: s.id, src: s.src, label: s.label, custom: false };
  }
  return readUserStickers().find((s) => s.id === key) || null;
}

function isStickerId(id) {
  return !!getSticker(id);
}

function randomSticker() {
  const all = listAllStickers();
  return all[Math.floor(Math.random() * all.length)];
}

function extFromContentType(ct) {
  const s = String(ct || "").toLowerCase();
  if (s.includes("png")) return "png";
  if (s.includes("webp")) return "webp";
  if (s.includes("gif")) return "gif";
  return "jpg";
}

function addUserSticker(buf, contentType, label) {
  ensureUserStore();
  if (!Buffer.isBuffer(buf) || !buf.length) {
    const err = new Error("图片为空");
    err.code = "bad_sticker_media";
    throw err;
  }
  if (buf.length > STICKER_MAX_BYTES) {
    const err = new Error("贴纸太大（上限 2MB）");
    err.code = "sticker_too_large";
    throw err;
  }
  const ext = extFromContentType(contentType);
  const id = "user-" + randomUUID();
  const file = id + "." + ext;
  fs.writeFileSync(path.join(USER_DIR, file), buf);
  const entry = {
    id,
    file,
    label: String(label || "贴纸").trim().slice(0, 20) || "贴纸",
    src: "/api/v1/chat/stickers/file/" + encodeURIComponent(file),
    custom: true,
  };
  const list = readUserStickers();
  list.push(entry);
  writeUserStickers(list);
  return { ok: true, sticker: entry };
}

function resolveUserStickerPath(fileName) {
  const name = String(fileName || "").trim();
  if (!/^user-[a-f0-9-]{36}\.(jpe?g|png|webp|gif)$/i.test(name)) return null;
  const filePath = path.normalize(path.join(USER_DIR, name));
  if (!filePath.startsWith(USER_DIR + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

function removeUserSticker(id) {
  const key = String(id || "").trim();
  if (!USER_ID_RE.test(key)) {
    const err = new Error("只能删除自建贴纸");
    err.code = "sticker_not_custom";
    throw err;
  }
  const list = readUserStickers();
  const hit = list.find((s) => s.id === key);
  if (!hit) {
    const err = new Error("贴纸不存在");
    err.code = "sticker_missing";
    throw err;
  }
  const next = list.filter((s) => s.id !== key);
  writeUserStickers(next);
  try {
    const abs = path.normalize(path.join(USER_DIR, hit.file));
    if (abs.startsWith(USER_DIR + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}
  return { ok: true, deleted: key };
}

if (require.main === module) {
  const all = listAllStickers();
  console.assert(all.length >= 1);
  console.assert(isStickerId("decor-bear"));
  console.log("stickers ok", all.length);
}

module.exports = {
  STICKERS,
  listStickers,
  listAllStickers,
  getSticker,
  isStickerId,
  randomSticker,
  addUserSticker,
  removeUserSticker,
  resolveUserStickerPath,
  STICKER_MAX_BYTES,
};
