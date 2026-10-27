/**
 * 备忘录：密钥副本 + 杂记（D39）。≠ 聊天记忆库。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const MEMO_PATH = path.join(DATA_DIR, "memo.json");
const KEYS_MAX = 40;
const NOTES_MAX = 200;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEMO_PATH)) {
    fs.writeFileSync(
      MEMO_PATH,
      JSON.stringify({ keys: [], notes: [] }, null, 2),
      "utf8"
    );
  }
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(MEMO_PATH, "utf8"));
    return {
      keys: Array.isArray(raw.keys) ? raw.keys : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
    };
  } catch {
    return { keys: [], notes: [] };
  }
}

function writeStore(store) {
  ensureFile();
  let keys = Array.isArray(store.keys) ? store.keys : [];
  let notes = Array.isArray(store.notes) ? store.notes : [];
  if (keys.length > KEYS_MAX) keys = keys.slice(-KEYS_MAX);
  if (notes.length > NOTES_MAX) notes = notes.slice(-NOTES_MAX);
  const out = { keys, notes };
  fs.writeFileSync(MEMO_PATH, JSON.stringify(out, null, 2), "utf8");
  return out;
}

function sanitizeKey(raw, id) {
  return {
    id: id || randomUUID(),
    label: String((raw && raw.label) || "").trim().slice(0, 40) || "密钥",
    value: String((raw && raw.value) || "").trim().slice(0, 200),
    updated_at: Date.now(),
  };
}

function sanitizeNote(raw, id) {
  return {
    id: id || randomUUID(),
    title: String((raw && raw.title) || "").trim().slice(0, 80) || "无标题",
    body: String((raw && raw.body) || "").trim().slice(0, 16000),
    pinned: !!(raw && raw.pinned),
    updated_at: Date.now(),
  };
}

function listMemo() {
  const s = readStore();
  const notes = s.notes
    .slice()
    .sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updated_at || 0) - (a.updated_at || 0);
    });
  return { ok: true, keys: s.keys, notes };
}

function upsertKey(opts) {
  const s = readStore();
  let id = String((opts && opts.id) || "").trim();
  const label = String((opts && opts.label) || "").trim().slice(0, 40);
  // 无 id 但同名 label 已有 → 更新（资产换钥同步用）
  if (!id && label) {
    const hit = s.keys.find((k) => k && k.label === label);
    if (hit) id = hit.id;
  }
  if (id) {
    const i = s.keys.findIndex((k) => k.id === id);
    if (i < 0) {
      const err = new Error("密钥不存在");
      err.code = "memo_missing";
      throw err;
    }
    s.keys[i] = sanitizeKey(opts, id);
  } else {
    if (s.keys.length >= KEYS_MAX) {
      const err = new Error("密钥条数已满");
      err.code = "memo_full";
      throw err;
    }
    s.keys.push(sanitizeKey(opts));
  }
  writeStore(s);
  return listMemo();
}

function removeKey(id) {
  const s = readStore();
  const want = String(id || "").trim();
  const n = s.keys.length;
  s.keys = s.keys.filter((k) => k.id !== want);
  if (s.keys.length === n) {
    const err = new Error("密钥不存在");
    err.code = "memo_missing";
    throw err;
  }
  writeStore(s);
  return listMemo();
}

function upsertNote(opts) {
  const s = readStore();
  const id = String((opts && opts.id) || "").trim();
  if (id) {
    const i = s.notes.findIndex((n) => n.id === id);
    if (i < 0) {
      const err = new Error("笔记不存在");
      err.code = "memo_missing";
      throw err;
    }
    const prev = s.notes[i];
    s.notes[i] = sanitizeNote(
      {
        title: opts.title != null ? opts.title : prev.title,
        body: opts.body != null ? opts.body : prev.body,
        pinned: opts.pinned != null ? opts.pinned : prev.pinned,
      },
      id
    );
  } else {
    if (s.notes.length >= NOTES_MAX) {
      const err = new Error("笔记条数已满");
      err.code = "memo_full";
      throw err;
    }
    s.notes.push(sanitizeNote(opts));
  }
  writeStore(s);
  return listMemo();
}

function removeNote(id) {
  const s = readStore();
  const want = String(id || "").trim();
  const n = s.notes.length;
  s.notes = s.notes.filter((x) => x.id !== want);
  if (s.notes.length === n) {
    const err = new Error("笔记不存在");
    err.code = "memo_missing";
    throw err;
  }
  writeStore(s);
  return listMemo();
}

if (require.main === module) {
  const before = readStore();
  writeStore({ keys: [], notes: [] });
  const a = upsertKey({ label: "家机零花", value: "CASH" });
  console.assert(a.keys.length === 1 && a.keys[0].value === "CASH");
  const a2 = upsertKey({ label: "家机零花", value: "DONTLOOK" });
  console.assert(a2.keys.length === 1 && a2.keys[0].value === "DONTLOOK");
  const b = upsertNote({ title: "杂记", body: "hello", pinned: true });
  console.assert(b.notes.length === 1 && b.notes[0].pinned);
  removeKey(a2.keys[0].id);
  removeNote(b.notes[0].id);
  writeStore(before);
  console.log("memo ok");
}

module.exports = {
  listMemo,
  upsertKey,
  removeKey,
  upsertNote,
  removeNote,
  MEMO_PATH,
};
