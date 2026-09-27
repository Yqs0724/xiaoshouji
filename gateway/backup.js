const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");

/** 进备份包的数据文件（不含 .env） */
const DATA_FILES = [
  "books.json",
  "highlights.json",
  "sessions.json",
  "settings.json",
  "world-entries.json",
];

const KEY_FIELDS = ["weread_key", "llm_key", "llm_base", "gate_hash", "gate_salt"];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** 无压缩 ZIP（STORE），零依赖 */
function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const crc = crc32(body);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(body.length),
      u32(body.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      body,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(body.length),
      u32(body.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, centralDir, end]);
}

function scrubSettingsObj(obj) {
  const out = { ...(obj && typeof obj === "object" ? obj : {}) };
  for (const k of KEY_FIELDS) out[k] = "";
  out._backup_note = "密钥已剔除；请在本机用 .env 或设定页重新填写";
  out._backup_at = new Date().toISOString();
  return out;
}

function scrubSettingsRaw(raw) {
  let obj = {};
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = {};
  }
  return JSON.stringify(scrubSettingsObj(obj), null, 2);
}

function readDataJson(name) {
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function collectBackupBundle() {
  const exported_at = new Date().toISOString();
  const files = [];
  const data = {};
  for (const name of DATA_FILES) {
    const key = name.replace(/\.json$/, "");
    let parsed = readDataJson(name);
    if (parsed == null) continue;
    if (name === "settings.json") parsed = scrubSettingsObj(parsed);
    data[key] = parsed;
    files.push(name);
  }
  if (!files.length) {
    const err = new Error("data/ 里还没有可备份的文件");
    err.code = "no_data";
    throw err;
  }
  return {
    app: "共读小屋",
    version: 1,
    format: "coread-backup",
    exported_at,
    files,
    note: "单个 JSON 备份，手机可直接保存/分享；不含 .env 与 API Key。可用设定页「恢复」写回。",
    data,
  };
}

function collectBackupEntries() {
  const bundle = collectBackupBundle();
  const entries = [];
  const manifest = {
    app: bundle.app,
    version: bundle.version,
    exported_at: bundle.exported_at,
    files: bundle.files,
    note: bundle.note,
  };

  for (const name of bundle.files) {
    const key = name.replace(/\.json$/, "");
    entries.push({
      name: "data/" + name,
      data: JSON.stringify(bundle.data[key], null, 2),
    });
  }

  entries.unshift({
    name: "README.txt",
    data:
      "共读小屋备份\n" +
      "导出时间：" +
      manifest.exported_at +
      "\n" +
      "含：" +
      manifest.files.join(", ") +
      "\n" +
      "settings 中的 Key 已清空；勿把密钥备份传到公网。\n" +
      "手机更推荐导出单个 JSON。\n" +
      "恢复：暂请手动把对应 json 拷回小屋 data/（先关网关）。\n",
  });
  entries.push({
    name: "manifest.json",
    data: JSON.stringify(manifest, null, 2),
  });
  return { entries, manifest };
}

function disposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_") || "coread-backup";
  return (
    `attachment; filename="${ascii}"; filename*=UTF-8''` + encodeURIComponent(filename)
  );
}

function stampName(iso) {
  return (iso || new Date().toISOString()).replace(/[:.]/g, "-").slice(0, 19);
}

/** 默认：单个 JSON（手机友好） */
function buildBackupJson() {
  const bundle = collectBackupBundle();
  const filename = `共读小屋-备份-${stampName(bundle.exported_at)}.json`;
  const body = Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
  return {
    filename,
    contentType: "application/json; charset=utf-8",
    body,
    contentDisposition: disposition(filename),
  };
}

function buildBackupZip() {
  const { entries, manifest } = collectBackupEntries();
  const filename = `共读小屋-备份-${stampName(manifest.exported_at)}.zip`;
  const body = zipStore(entries);
  return {
    filename,
    contentType: "application/zip",
    body,
    contentDisposition: disposition(filename),
  };
}

/** format: json（默认）| zip */
function buildBackup(format) {
  const fmt = String(format || "json").toLowerCase();
  return fmt === "zip" ? buildBackupZip() : buildBackupJson();
}

const BACKUPS_DIR = path.join(DATA_DIR, "backups");

function parseBackupBundle(input) {
  let bundle = input;
  if (typeof input === "string") {
    try {
      bundle = JSON.parse(input);
    } catch {
      const err = new Error("不是合法 JSON");
      err.code = "bad_backup";
      throw err;
    }
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    const err = new Error("备份格式不对");
    err.code = "bad_backup";
    throw err;
  }
  if (bundle.format !== "coread-backup") {
    const err = new Error("请选择共读小屋导出的 JSON 备份（format: coread-backup）");
    err.code = "bad_backup";
    throw err;
  }
  if (!bundle.data || typeof bundle.data !== "object" || Array.isArray(bundle.data)) {
    const err = new Error("备份里没有 data 段");
    err.code = "bad_backup";
    throw err;
  }
  const ver = Number(bundle.version) || 1;
  if (ver > 1) {
    const err = new Error("备份版本过新，请升级小屋后再恢复");
    err.code = "bad_backup";
    throw err;
  }
  return bundle;
}

function previewBackup(input) {
  const b = parseBackupBundle(input);
  const files =
    Array.isArray(b.files) && b.files.length
      ? b.files.slice()
      : Object.keys(b.data)
          .filter((k) => b.data[k] != null)
          .map((k) => k + ".json");
  return {
    exported_at: b.exported_at || null,
    files,
    has: {
      books: b.data.books != null,
      highlights: b.data.highlights != null,
      sessions: b.data.sessions != null,
      settings: b.data.settings != null,
    },
  };
}

function writeSnapshotBeforeRestore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  try {
    const snap = buildBackupJson();
    const name = "pre-restore-" + stampName(new Date().toISOString()) + ".json";
    const fp = path.join(BACKUPS_DIR, name);
    fs.writeFileSync(fp, snap.body);
    return name;
  } catch (e) {
    if (e.code === "no_data") return null;
    throw e;
  }
}

/**
 * 从 JSON 备份恢复 data/。
 * Key 不从备份写入：保留本机现有 weread_key / llm_key / llm_base。
 */
function restoreFromBackup(input) {
  const b = parseBackupBundle(input);
  const snapshot = writeSnapshotBeforeRestore();
  const currentSettings = readDataJson("settings.json") || {};
  const written = [];

  for (const name of DATA_FILES) {
    const key = name.replace(/\.json$/, "");
    if (!Object.prototype.hasOwnProperty.call(b.data, key) || b.data[key] == null) continue;
    let payload = b.data[key];
    if (typeof payload !== "object") {
      const err = new Error(name + " 内容不是对象");
      err.code = "bad_backup";
      throw err;
    }
    if (name === "settings.json") {
      payload = { ...payload };
      delete payload._backup_note;
      delete payload._backup_at;
      for (const k of KEY_FIELDS) {
        const local = String(currentSettings[k] || "").trim();
        payload[k] = local;
      }
    }
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(payload, null, 2), "utf8");
    written.push(name);
  }

  if (!written.length) {
    const err = new Error("备份里没有可恢复的数据文件");
    err.code = "bad_backup";
    throw err;
  }

  return {
    written,
    snapshot,
    exported_at: b.exported_at || null,
  };
}

if (require.main === module) {
  const json = buildBackupJson();
  console.assert(json.filename.endsWith(".json"));
  const parsed = JSON.parse(json.body.toString("utf8"));
  console.assert(parsed.format === "coread-backup" && parsed.data && parsed.data.settings);
  console.assert(!parsed.data.settings.weread_key);
  const file = buildBackupZip();
  console.assert(file.body[0] === 0x50 && file.body[1] === 0x4b, "zip magic");
  const scrubbed = scrubSettingsRaw(
    JSON.stringify({ weread_key: "secret", llm_key: "sk", persona: "hi" })
  );
  const s = JSON.parse(scrubbed);
  console.assert(s.weread_key === "" && s.llm_key === "" && s.persona === "hi");
  const prev = previewBackup(parsed);
  console.assert(prev.files.length && prev.has.settings);
  try {
    parseBackupBundle({ format: "nope", data: {} });
    throw new Error("expected bad_backup");
  } catch (e) {
    if (e.code !== "bad_backup") throw e;
  }
  console.log("backup ok", {
    jsonBytes: json.body.length,
    zipBytes: file.body.length,
    name: json.filename,
  });
}

module.exports = {
  buildBackup,
  buildBackupJson,
  buildBackupZip,
  parseBackupBundle,
  previewBackup,
  restoreFromBackup,
  scrubSettingsRaw,
  zipStore,
  DATA_FILES,
};
