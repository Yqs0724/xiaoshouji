/**
 * 零花/剧场进门钥（D37）：家机生气/冷战时悄悄换钥，和好类心情恢复。
 * 副本同步备忘录；不往聊天塞提示气泡。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const KEYS_PATH = path.join(DATA_DIR, "pocket-keys.json");
const COLD_KEY = "DONTLOOK";
const WARM_KEY = "CASH";
const COLD_LABELS = new Set(["冷战", "生气"]);
const WARM_LABELS = new Set(["开心", "平静", "兴奋"]);

function defaults() {
  return {
    theater: "ARIA",
    me: "ME",
    bot: WARM_KEY,
    botPrev: [],
    cold: false,
    updatedAt: 0,
  };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEYS_PATH)) {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(defaults(), null, 2), "utf8");
  }
}

function sanitize(raw) {
  const d = defaults();
  const r = raw && typeof raw === "object" ? raw : {};
  const prev = Array.isArray(r.botPrev)
    ? r.botPrev.map((x) => String(x || "").trim()).filter(Boolean).slice(-12)
    : [];
  return {
    theater: String(r.theater || d.theater).trim().slice(0, 40) || d.theater,
    me: String(r.me || d.me).trim().slice(0, 40) || d.me,
    bot: String(r.bot || d.bot).trim().slice(0, 40) || d.bot,
    botPrev: prev,
    cold: !!r.cold,
    updatedAt: Number(r.updatedAt) || 0,
  };
}

function readKeys() {
  ensureFile();
  try {
    return sanitize(JSON.parse(fs.readFileSync(KEYS_PATH, "utf8")));
  } catch {
    return defaults();
  }
}

function writeKeys(data) {
  ensureFile();
  const out = sanitize(data);
  out.updatedAt = Date.now();
  fs.writeFileSync(KEYS_PATH, JSON.stringify(out, null, 2), "utf8");
  return out;
}

function syncToMemo(keys) {
  const k = keys || readKeys();
  try {
    const { upsertKey } = require("../../备忘录app/gateway/memo");
    upsertKey({ label: "剧场", value: k.theater });
    upsertKey({ label: "你的零花", value: k.me });
    upsertKey({ label: "家机零花", value: k.bot });
  } catch (_) {
    /* 备忘录可选 */
  }
}

/** 便签缺条或与 pocket-keys 不一致时才写盘 */
function memoOutOfSync(k) {
  try {
    const { listMemo } = require("../../备忘录app/gateway/memo");
    const keys = (listMemo().keys || []).slice();
    const want = [
      ["剧场", k.theater],
      ["你的零花", k.me],
      ["家机零花", k.bot],
    ];
    for (let i = 0; i < want.length; i++) {
      const label = want[i][0];
      const value = String(want[i][1] || "");
      const hit = keys.find((x) => x && x.label === label);
      if (!hit || String(hit.value || "") !== value) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function ensureMemoSeeded(keys) {
  const k = keys || readKeys();
  if (memoOutOfSync(k)) syncToMemo(k);
  return k;
}

function getPocketKeys() {
  const k = ensureMemoSeeded(readKeys());
  return {
    ok: true,
    theater: k.theater,
    me: k.me,
    bot: k.bot,
    botPrev: k.botPrev.slice(),
    cold: k.cold,
    updatedAt: k.updatedAt,
  };
}

function rotateCold(keys) {
  if (keys.cold && keys.bot.toUpperCase() === COLD_KEY) return { keys, changed: false };
  if (keys.bot.toUpperCase() !== COLD_KEY) {
    keys.botPrev.push(keys.bot);
  }
  keys.bot = COLD_KEY;
  keys.cold = true;
  return { keys, changed: true };
}

function restoreWarm(keys) {
  if (!keys.cold && keys.bot.toUpperCase() === WARM_KEY) {
    return { keys, changed: false };
  }
  if (keys.bot.toUpperCase() !== WARM_KEY) {
    keys.botPrev.push(keys.bot);
  }
  keys.bot = WARM_KEY;
  keys.cold = false;
  return { keys, changed: true };
}

/**
 * 按心情标签（及 NA/PA 兜底）换/恢复家机零花钥。静默；有变更则写备忘录。
 * @returns {{ ok:true, changed:boolean, action:string|null, keys:object }}
 */
function syncPocketKeysFromMoodLabel(label, mood) {
  const lab = String(label || "").trim();
  const na = mood ? Number(mood.na) : NaN;
  const pa = mood ? Number(mood.pa) : NaN;
  const v = mood ? Number(mood.valence) : NaN;
  const coldByScore = Number.isFinite(na) && na >= 0.55 && Number.isFinite(v) && v < -0.1;
  const warmByScore = Number.isFinite(na) && na < 0.28 && Number.isFinite(pa) && pa >= 0.4;
  let keys = readKeys();
  let changed = false;
  let action = null;
  if (COLD_LABELS.has(lab) || coldByScore) {
    const out = rotateCold(keys);
    keys = out.keys;
    changed = out.changed;
    if (changed) action = "cold";
  } else if (WARM_LABELS.has(lab) || warmByScore) {
    const out = restoreWarm(keys);
    keys = out.keys;
    changed = out.changed;
    if (changed) action = "warm";
  }
  if (changed) {
    keys = writeKeys(keys);
    syncToMemo(keys);
  }
  return { ok: true, changed, action, keys: getPocketKeys() };
}

/** 接话 system：仅冷战换钥态注入；勿主动报明文 */
function buildPocketKeyPrompt() {
  const k = readKeys();
  if (!k.cold && k.bot.toUpperCase() === WARM_KEY) return "";
  return (
    "【玩法事实·零花钥】你生气/冷战时已改过自己的零花资产进门密码；对方若仍用旧密码会进不去。" +
    "对方问起可以承认改过；不要主动报明文密码，也不要主动提醒去哪查。"
  );
}

if (require.main === module) {
  const snap = readKeys();
  writeKeys(defaults());
  const a = syncPocketKeysFromMoodLabel("冷战");
  console.assert(a.changed && a.keys.bot === COLD_KEY && a.keys.cold, "cold rotate");
  const a2 = syncPocketKeysFromMoodLabel("生气");
  console.assert(!a2.changed, "no re-rotate");
  const b = syncPocketKeysFromMoodLabel("开心");
  console.assert(b.changed && b.keys.bot === WARM_KEY && !b.keys.cold, "warm restore");
  console.assert((b.keys.botPrev || []).map((x) => x.toUpperCase()).includes(COLD_KEY), "prev");
  const { listMemo, removeKey } = require("../../备忘录app/gateway/memo");
  const before = listMemo().keys || [];
  before
    .filter((x) => x && (x.label === "剧场" || x.label === "你的零花" || x.label === "家机零花"))
    .forEach(function (x) {
      try {
        removeKey(x.id);
      } catch (_) {}
    });
  console.assert(memoOutOfSync(readKeys()), "detect missing");
  getPocketKeys();
  console.assert(!memoOutOfSync(readKeys()), "seeded");
  const seeded = (listMemo().keys || []).find((x) => x && x.label === "家机零花");
  console.assert(seeded && seeded.value === WARM_KEY, "memo bot key");
  writeKeys(snap);
  console.log("pocket-keys ok");
}

module.exports = {
  getPocketKeys,
  readKeys,
  writeKeys,
  syncToMemo,
  ensureMemoSeeded,
  memoOutOfSync,
  syncPocketKeysFromMoodLabel,
  buildPocketKeyPrompt,
  COLD_KEY,
  WARM_KEY,
  KEYS_PATH,
};
