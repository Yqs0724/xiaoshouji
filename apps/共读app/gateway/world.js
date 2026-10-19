/**
 * 世界书（酒馆 World Info 精简版）：
 * - 多本；勾选最多 3 本参与扫描
 * - 总开关在 settings.worldbook_enabled（默认关）
 * - 命中：常驻条目 + 近文关键词；预算按「整条进或不进」，不截断条目正文
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const WORLD_PATH = path.join(DATA_DIR, "world-entries.json");

const ACTIVE_CAP = 3;
/** 默认扫描最近几条消息（对齐酒馆常见默认） */
const DEFAULT_SCAN_DEPTH = 4;
/** 字预算（懒对齐 token 预算；整条放不下就跳过，不砍正文） */
const DEFAULT_BUDGET_CHARS = 6000;

const SEED_ENTRIES = [
  {
    id: "seed-gaia",
    keys: ["盖亚", "Gaia", "盖娅"],
    body: "盖亚假说：把地球看成自我调节的系统；本书讨论时偏生物学/地球化学视角，跟批可点到「系统反馈」而不展开科幻拟人。",
    enabled: true,
    constant: false,
    order: 100,
  },
  {
    id: "seed-endosymbiosis",
    keys: ["内共生", "线粒体", "叶绿体"],
    body: "内共生：线粒体/叶绿体来自被吞噬的细菌；复杂生命起源叙事里这是关键台阶，跟批可轻点「能量与细胞器」线索。",
    enabled: true,
    constant: false,
    order: 100,
  },
  {
    id: "seed-polyphyletic",
    keys: ["多系", "polyphyletic", "辐射"],
    body: "多系辐射：相似形态可能多次独立演化；跟批避免说成单一祖先直线进步。",
    enabled: true,
    constant: false,
    order: 100,
  },
];

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORLD_PATH)) {
    const book = {
      id: "seed-default",
      name: "示例世界书",
      filename: "",
      active: false,
      entries: SEED_ENTRIES.map((e) => ({ ...e, keys: e.keys.slice() })),
    };
    fs.writeFileSync(WORLD_PATH, JSON.stringify({ books: [book] }, null, 2), "utf8");
  }
}

function normalizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const keys = Array.isArray(e.keys)
    ? e.keys.map((k) => String(k || "").trim()).filter(Boolean)
    : String(e.keys || e.key || "")
        .split(/[,，;；\n]+/)
        .map((k) => k.trim())
        .filter(Boolean);
  const body = String(e.body != null ? e.body : e.content || "").trim();
  if (!body) return null;
  const constant = !!(e.constant || e.permanent);
  if (!constant && !keys.length) return null;
  return {
    id: String(e.id || e.uid || randomUUID()),
    keys,
    body,
    enabled: e.enabled !== false,
    constant,
    order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100,
  };
}

function normalizeBook(b) {
  if (!b || typeof b !== "object") return null;
  const entries = (Array.isArray(b.entries) ? b.entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  return {
    id: String(b.id || randomUUID()),
    name: String(b.name || "未命名").trim() || "未命名",
    filename: String(b.filename || "").trim(),
    active: !!b.active,
    entries,
  };
}

/** 旧版 { entries: [...] } → { books: [...] } */
function migrateRaw(raw) {
  if (!raw || typeof raw !== "object") return { books: [] };
  if (Array.isArray(raw.books)) {
    return { books: raw.books.map(normalizeBook).filter(Boolean) };
  }
  if (Array.isArray(raw.entries)) {
    const entries = raw.entries.map(normalizeEntry).filter(Boolean);
    if (!entries.length) return { books: [] };
    return {
      books: [
        {
          id: "migrated-default",
          name: "默认世界书",
          filename: "",
          active: false,
          entries,
        },
      ],
    };
  }
  return { books: [] };
}

function readStore() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(WORLD_PATH, "utf8"));
    const next = migrateRaw(raw);
    /* 写回迁移结果，避免反复迁 */
    if (!Array.isArray(raw.books)) writeStore(next);
    return next;
  } catch {
    return { books: [] };
  }
}

function writeStore(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let books = (data.books || []).map(normalizeBook).filter(Boolean);
  let activeN = 0;
  for (const b of books) {
    if (!b.active) continue;
    activeN += 1;
    if (activeN > ACTIVE_CAP) b.active = false;
  }
  fs.writeFileSync(WORLD_PATH, JSON.stringify({ books }, null, 2), "utf8");
  return { books };
}

function listWorld() {
  const { books } = readStore();
  return {
    books,
    active_cap: ACTIVE_CAP,
    active_ids: books.filter((b) => b.active).map((b) => b.id),
  };
}

/** 兼容旧 PUT：整表替换成一本「默认」 */
function replaceWorld(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return writeStore({
    books: [
      {
        id: "migrated-default",
        name: "默认世界书",
        filename: "",
        active: false,
        entries: list,
      },
    ],
  });
}

function publicBook(b) {
  return {
    id: b.id,
    name: b.name,
    filename: b.filename,
    active: !!b.active,
    entry_count: (b.entries || []).length,
  };
}

function listWorldPublic() {
  const data = listWorld();
  return {
    books: data.books.map(publicBook),
    active_cap: data.active_cap,
    active_ids: data.active_ids,
  };
}

/**
 * 解析酒馆世界书 JSON / 纯文本。
 * ST entries 常为对象 map；也接受数组。
 */
function parseImportPayload(rawText, { name, filename } = {}) {
  const text = String(rawText || "");
  const baseName =
    String(name || "").trim() ||
    String(filename || "")
      .replace(/\.[^.]+$/, "")
      .trim() ||
    "导入世界书";
  const trimmed = text.trim();
  if (!trimmed) {
    const err = new Error("内容为空");
    err.code = "world_empty";
    throw err;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      /* 当纯文本 */
      data = null;
    }
    if (data) {
      let rawEntries = [];
      if (data.entries && typeof data.entries === "object" && !Array.isArray(data.entries)) {
        rawEntries = Object.values(data.entries);
      } else if (Array.isArray(data.entries)) {
        rawEntries = data.entries;
      } else if (Array.isArray(data)) {
        rawEntries = data;
      }
      const entries = rawEntries
        .map((e) =>
          normalizeEntry({
            id: e && (e.uid != null ? String(e.uid) : e.id),
            keys: e && (e.key || e.keys),
            body: e && (e.content != null ? e.content : e.body),
            enabled: e && e.enabled,
            constant: e && e.constant,
            order: e && e.order,
          })
        )
        .filter(Boolean);
      if (entries.length) {
        return {
          name: String(data.name || baseName).trim() || baseName,
          filename: String(filename || "").trim(),
          entries,
        };
      }
    }
  }

  /* 纯文本：整本当一条常驻 */
  return {
    name: baseName,
    filename: String(filename || "").trim(),
    entries: [
      {
        id: randomUUID(),
        keys: [],
        body: trimmed,
        enabled: true,
        constant: true,
        order: 100,
      },
    ],
  };
}

function addBookFromText(rawText, opts = {}) {
  const parsed = parseImportPayload(rawText, opts);
  const store = readStore();
  const book = normalizeBook({
    id: randomUUID(),
    name: parsed.name,
    filename: parsed.filename,
    active: false,
    entries: parsed.entries,
  });
  if (!book || !book.entries.length) {
    const err = new Error("没有可用条目");
    err.code = "world_empty";
    throw err;
  }
  store.books.push(book);
  writeStore(store);
  return book;
}

function deleteBook(id) {
  const store = readStore();
  const before = store.books.length;
  store.books = store.books.filter((b) => b.id !== String(id));
  if (store.books.length === before) {
    const err = new Error("找不到这本世界书");
    err.code = "world_not_found";
    throw err;
  }
  writeStore(store);
  return listWorldPublic();
}

function setBookActive(id, active) {
  const store = readStore();
  const book = store.books.find((b) => b.id === String(id));
  if (!book) {
    const err = new Error("找不到这本世界书");
    err.code = "world_not_found";
    throw err;
  }
  const want = !!active;
  if (want && !book.active) {
    const n = store.books.filter((b) => b.active).length;
    if (n >= ACTIVE_CAP) {
      const err = new Error("最多同时启用 " + ACTIVE_CAP + " 本");
      err.code = "world_active_cap";
      throw err;
    }
  }
  book.active = want;
  writeStore(store);
  return listWorldPublic();
}

function activeEntries() {
  return readStore()
    .books.filter((b) => b.active)
    .flatMap((b) => (b.entries || []).filter((e) => e && e.enabled !== false));
}

function scanBlobFromMessages(messages, depth) {
  const d = Math.max(0, Number(depth) || 0);
  const list = Array.isArray(messages) ? messages : [];
  const slice = d === 0 ? [] : list.slice(-d);
  return slice
    .map((m) => {
      if (!m || typeof m !== "object") return "";
      return String(m.body != null ? m.body : m.content != null ? m.content : m.text || "");
    })
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function highlightBlob(h) {
  return [h && h.text, h && h.idea, h && h.chapter_title]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * 酒馆式激活：常驻优先，再关键词命中；按 order 降序；预算内整条纳入。
 */
function matchWorldForScan(scanText, { budgetChars, entries } = {}) {
  const budget = Math.max(200, Number(budgetChars) || DEFAULT_BUDGET_CHARS);
  const list = (entries || activeEntries()).slice();
  const blob = String(scanText || "").toLowerCase();

  const activated = [];
  for (const e of list) {
    if (e.constant) {
      activated.push(e);
      continue;
    }
    if (!blob) continue;
    const ok = (e.keys || []).some((k) => blob.includes(String(k).toLowerCase()));
    if (ok) activated.push(e);
  }

  activated.sort((a, b) => {
    if (!!b.constant !== !!a.constant) return b.constant ? 1 : -1;
    return (Number(b.order) || 0) - (Number(a.order) || 0);
  });

  const parts = [];
  const hit_ids = [];
  let used = 0;
  for (const e of activated) {
    const chunk = e.body;
    if (used + chunk.length > budget) continue; /* 整条放不下就跳过，不截断 */
    parts.push(chunk);
    hit_ids.push(e.id);
    used += chunk.length + 1;
  }
  return { text: parts.join("\n\n"), hit_ids, used };
}

function matchWorldForHighlight(highlight, opts = {}) {
  return matchWorldForScan(highlightBlob(highlight), opts);
}

function matchWorldForMessages(messages, opts = {}) {
  const depth =
    opts.scanDepth != null ? Number(opts.scanDepth) : DEFAULT_SCAN_DEPTH;
  return matchWorldForScan(scanBlobFromMessages(messages, depth), opts);
}

function appendWorldBlock(system, text) {
  const t = String(text || "").trim();
  if (!t) return String(system || "");
  return (
    String(system || "") +
    "\n相关设定（勿向读者复述「世界书/条目」字样，自然用上即可）：\n" +
    t
  );
}

function appendWorldToSystem(system, highlight) {
  const { text } = matchWorldForHighlight(highlight);
  return appendWorldBlock(system, text);
}

/** 聊天用：读开关后注入；关则原样返回 */
function appendWorldbookForChat(system, messages, settings) {
  const s = settings || {};
  if (!s.worldbook_enabled) return String(system || "");
  const { text } = matchWorldForMessages(messages, {
    scanDepth: s.worldbook_scan_depth,
    budgetChars: s.worldbook_budget_chars,
  });
  return appendWorldBlock(system, text);
}

if (require.main === module) {
  const { books } = readStore();
  console.assert(books.length >= 1, "has books");
  const store = readStore();
  const b0 = store.books[0];
  b0.active = true;
  writeStore(store);
  const hit = matchWorldForScan("盖亚假说与 Gaia 系统反馈", {
    entries: activeEntries(),
  });
  console.assert(hit.hit_ids.includes("seed-gaia"), hit);
  const miss = matchWorldForScan("完全无关的句子 xyzzy", {
    entries: activeEntries().filter((e) => !e.constant),
  });
  console.assert(miss.hit_ids.length === 0);
  const imported = parseImportPayload(
    JSON.stringify({
      entries: {
        "1": {
          uid: 1,
          key: ["测试键"],
          content: "测试正文一整段不该被砍",
          constant: false,
          enabled: true,
          order: 50,
        },
      },
    }),
    { name: "测" }
  );
  console.assert(imported.entries.length === 1);
  console.assert(imported.entries[0].body.includes("不该被砍"));
  b0.active = false;
  writeStore(store);
  console.log("world ok", books.length, "books");
}

module.exports = {
  listWorld,
  listWorldPublic,
  replaceWorld,
  addBookFromText,
  deleteBook,
  setBookActive,
  parseImportPayload,
  matchWorldForHighlight,
  matchWorldForMessages,
  matchWorldForScan,
  appendWorldToSystem,
  appendWorldbookForChat,
  activeEntries,
  WORLD_PATH,
  ACTIVE_CAP,
  DEFAULT_SCAN_DEPTH,
  DEFAULT_BUDGET_CHARS,
  SEED_ENTRIES,
};
