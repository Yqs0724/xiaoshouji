/**
 * 世界书：本机条目 + 跟批静默命中。
 * UI 不展示命中列表；只把正文塞进 system。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const WORLD_PATH = path.join(DATA_DIR, "world-entries.json");

/** 单次跟批注入软上限（字） */
const WORLD_INJECT_MAX = 1500;
const WORLD_HIT_CAP = 5;

/** 首次空库时写入，方便自测《复杂生命的起源》相关划线 */
const SEED_ENTRIES = [
  {
    id: "seed-gaia",
    keys: ["盖亚", "Gaia", "盖娅"],
    body: "盖亚假说：把地球看成自我调节的系统；本书讨论时偏生物学/地球化学视角，跟批可点到「系统反馈」而不展开科幻拟人。",
    enabled: true,
  },
  {
    id: "seed-endosymbiosis",
    keys: ["内共生", "线粒体", "叶绿体"],
    body: "内共生：线粒体/叶绿体来自被吞噬的细菌；复杂生命起源叙事里这是关键台阶，跟批可轻点「能量与细胞器」线索。",
    enabled: true,
  },
  {
    id: "seed-polyphyletic",
    keys: ["多系", "polyphyletic", "辐射"],
    body: "多系辐射：相似形态可能多次独立演化；跟批避免说成单一祖先直线进步。",
    enabled: true,
  },
];

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORLD_PATH)) {
    const entries = SEED_ENTRIES.map((e) => ({ ...e, keys: e.keys.slice() }));
    fs.writeFileSync(WORLD_PATH, JSON.stringify({ entries }, null, 2), "utf8");
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(WORLD_PATH, "utf8"));
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return { entries: entries.map(normalizeEntry).filter(Boolean) };
  } catch {
    return { entries: [] };
  }
}

function writeAll(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const entries = (data.entries || []).map(normalizeEntry).filter(Boolean);
  fs.writeFileSync(WORLD_PATH, JSON.stringify({ entries }, null, 2), "utf8");
  return { entries };
}

function normalizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const keys = Array.isArray(e.keys)
    ? e.keys.map((k) => String(k || "").trim()).filter(Boolean)
    : String(e.keys || "")
        .split(/[,，;；\n]+/)
        .map((k) => k.trim())
        .filter(Boolean);
  const body = String(e.body || "").trim();
  if (!keys.length || !body) return null;
  return {
    id: String(e.id || randomUUID()),
    keys,
    body,
    enabled: e.enabled !== false,
  };
}

function listWorld() {
  return readAll();
}

function replaceWorld(entries) {
  return writeAll({ entries: Array.isArray(entries) ? entries : [] });
}

function highlightBlob(h) {
  return [h && h.text, h && h.idea, h && h.chapter_title]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * 按关键词命中条目（静默）。返回用于注入的文本块；无命中则 ""。
 */
function matchWorldForHighlight(highlight, { entries } = {}) {
  const list = (entries || readAll().entries).filter((e) => e && e.enabled !== false);
  const blob = highlightBlob(highlight);
  if (!blob) return { text: "", hit_ids: [] };

  const hits = [];
  for (const e of list) {
    const ok = (e.keys || []).some((k) => blob.includes(String(k).toLowerCase()));
    if (!ok) continue;
    hits.push(e);
    if (hits.length >= WORLD_HIT_CAP) break;
  }
  if (!hits.length) return { text: "", hit_ids: [] };

  const parts = [];
  let used = 0;
  for (const e of hits) {
    const chunk = e.body;
    if (used + chunk.length > WORLD_INJECT_MAX) {
      const room = WORLD_INJECT_MAX - used;
      if (room > 40) parts.push(chunk.slice(0, room) + "…");
      break;
    }
    parts.push(chunk);
    used += chunk.length + 1;
  }
  return {
    text: parts.join("\n"),
    hit_ids: hits.map((e) => e.id),
  };
}

function appendWorldToSystem(system, highlight) {
  const { text } = matchWorldForHighlight(highlight);
  if (!text) return system;
  return (
    String(system || "") +
    "\n相关设定（勿向读者复述「世界书/条目」字样，自然用上即可）：\n" +
    text
  );
}

if (require.main === module) {
  const { entries } = readAll();
  console.assert(entries.length >= 1, "seed or saved entries");
  const hit = matchWorldForHighlight({
    text: "盖亚假说与 Gaia 系统反馈",
    idea: "",
    chapter_title: "绪论",
  });
  console.assert(hit.hit_ids.includes("seed-gaia"), hit);
  console.assert(hit.text.includes("盖亚") || hit.text.includes("系统反馈"), hit.text);
  const miss = matchWorldForHighlight({ text: "完全无关的句子 xyzzy", idea: "" });
  console.assert(miss.hit_ids.length === 0 && miss.text === "");
  const sys = appendWorldToSystem("base", { text: "线粒体与内共生" });
  console.assert(sys.includes("相关设定") && sys.includes("内共生"));
  console.log("world ok", entries.length, "entries");
}

module.exports = {
  listWorld,
  replaceWorld,
  matchWorldForHighlight,
  appendWorldToSystem,
  WORLD_PATH,
  WORLD_INJECT_MAX,
  SEED_ENTRIES,
};
