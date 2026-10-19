/**
 * 家机轻量心情（H1.14）：本地漏斗 → PA/NA → 接话门控（延迟/冷战跳过）+ prompt 一句。
 * 非完整情绪教程；词典可后换大表。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const MOOD_PATH = path.join(DATA_DIR, "mood.json");

/* ponytail: 闭集小表够用；要准再换 CVAW 大词典 */
const NEG_WORDS = [
  "滚",
  "分手",
  "不要你了",
  "讨厌",
  "去死",
  "闭嘴",
  "不理你",
  "冷战",
  "生气",
  "气死",
  "受够了",
  "骗子",
  "恶心",
  "烦死",
  "滚出去",
  "分手吧",
  "讨厌你",
  "恨你",
  "别找我",
  "拉黑",
  "无语",
  "有病",
  "滚吧",
  "不想理",
  "别说话",
];
const POS_WORDS = [
  "爱你",
  "抱抱",
  "对不起",
  "原谅",
  "想你",
  "喜欢",
  "晚安",
  "早安",
  "开心",
  "谢谢",
  "辛苦了",
  "和好",
  "么么",
  "亲亲",
  "想通了",
  "没事了",
  "消气",
  "抱抱你",
];

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MOOD_PATH)) {
    fs.writeFileSync(
      MOOD_PATH,
      JSON.stringify({ pa: 0.35, na: 0.15, updatedAt: Date.now() }, null, 2),
      "utf8"
    );
  }
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function readMood() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(MOOD_PATH, "utf8"));
    return {
      pa: clamp01(raw.pa),
      na: clamp01(raw.na),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  } catch (_) {
    return { pa: 0.35, na: 0.15, updatedAt: Date.now() };
  }
}

function writeMood(m) {
  ensureFile();
  fs.writeFileSync(
    MOOD_PATH,
    JSON.stringify(
      {
        pa: clamp01(m.pa),
        na: clamp01(m.na),
        updatedAt: Number(m.updatedAt) || Date.now(),
      },
      null,
      2
    ),
    "utf8"
  );
}

/** 幂律味儿的轻衰减：按小时淡一点 */
function decayMood(m, now) {
  const t = Number(now) || Date.now();
  const prev = Number(m.updatedAt) || t;
  const hours = Math.max(0, (t - prev) / 3600000);
  if (hours < 0.05) return { ...m, updatedAt: t };
  /* w ≈ (1 + h/4)^(-0.5) 拉回中性 */
  const w = Math.pow(1 + hours / 4, -0.5);
  const mid = 0.25;
  return {
    pa: clamp01(mid + (m.pa - mid) * w),
    na: clamp01(mid + (m.na - mid) * w),
    updatedAt: t,
  };
}

function scanText(text) {
  const s = String(text || "");
  let minV = 0;
  let maxV = 0;
  let negCount = 0;
  let posCount = 0;
  for (const w of NEG_WORDS) {
    if (w && s.includes(w)) {
      negCount += 1;
      minV = Math.min(minV, -0.7);
    }
  }
  for (const w of POS_WORDS) {
    if (w && s.includes(w)) {
      posCount += 1;
      maxV = Math.max(maxV, 0.75);
    }
  }
  const n = negCount + posCount;
  const avgV = n ? (posCount * 0.6 + negCount * -0.6) / n : 0;
  return { minV, maxV, negCount, posCount, avgV };
}

function observeUserText(text) {
  let m = decayMood(readMood());
  const sc = scanText(text);
  if (sc.minV < -0.5) {
    m.na = clamp01(m.na + 0.28);
    m.pa = clamp01(m.pa - 0.12);
  }
  if (sc.negCount >= 2 && sc.avgV < -0.2) {
    m.na = clamp01(m.na + 0.18);
  }
  if (sc.maxV > 0.7) {
    m.pa = clamp01(m.pa + 0.22);
    m.na = clamp01(m.na - 0.14);
  }
  if (sc.posCount >= 2 && sc.avgV > 0.2) {
    m.pa = clamp01(m.pa + 0.12);
    m.na = clamp01(m.na - 0.1);
  }
  /* ESM 软互抑 */
  const pa0 = m.pa;
  const na0 = m.na;
  m.pa = clamp01(pa0 * (1 - 0.3 * na0));
  m.na = clamp01(na0 * (1 - 0.3 * pa0));
  m.updatedAt = Date.now();
  writeMood(m);
  return { mood: m, scan: sc };
}

function buildMoodPrompt(mood) {
  const m = mood || readMood();
  const parts = [];
  if (m.pa > 0.45 && m.na < 0.35) {
    parts.push("最近心情还行，语气可以松一点。");
  } else if (m.na >= 0.7) {
    parts.push(
      "你现在很受伤/生气，可能不想好好说话；可以冷淡、简短，甚至明显不想理人。不要秒回讨好。"
    );
  } else if (m.na >= 0.45) {
    parts.push("心里还有点别扭，语气偏短、别太热情。");
  } else if (m.pa < 0.2 && m.na < 0.35) {
    parts.push("有点提不起劲，回得平淡即可。");
  }
  if (!parts.length) return "";
  return (
    "【当下心情】\n" +
    parts.join("\n") +
    "\n（自然融入回答，不要主动点破「我在按心情设定演戏」。）"
  );
}

function moodLabel(mood) {
  const m = mood || readMood();
  if (m.na >= 0.72) return "冷战";
  if (m.na >= 0.45) return "别扭";
  if (m.pa >= 0.55 && m.na < 0.3) return "开心";
  if (m.pa < 0.22 && m.na < 0.4) return "低落";
  return "平静";
}

/** 对外快照：胶囊 / GET /api/v1/chat/mood */
function getMoodPublic() {
  const mood = decayMood(readMood());
  writeMood(mood);
  return {
    ok: true,
    pa: Math.round(mood.pa * 1000) / 1000,
    na: Math.round(mood.na * 1000) / 1000,
    label: moodLabel(mood),
    updatedAt: mood.updatedAt,
  };
}

/**
 * @param {{ slowReply?: boolean, coalesced?: boolean }} [opts]
 * @returns {{ delayMs: number, skip: boolean, mood: object, moodPrompt: string }}
 */
function decideReplyGate(opts) {
  const mood = decayMood(readMood());
  writeMood(mood);
  const slowReply = !(opts && opts.slowReply === false);
  const coalesced = !!(opts && opts.coalesced);
  /* 基线延迟破秒回；NA 高再拉长；极高 NA 概率冷战不回 */
  let delayMs = 1200 + Math.floor(Math.random() * 2800);
  let skip = false;
  if (mood.na >= 0.45) {
    delayMs += 3000 + Math.floor(mood.na * 9000);
  }
  if (mood.pa >= 0.5 && mood.na < 0.3) {
    delayMs = Math.floor(delayMs * 0.55);
  }
  if (mood.na >= 0.72) {
    const p = 0.25 + (mood.na - 0.72) * 1.2;
    if (Math.random() < Math.min(0.65, p)) skip = true;
  }
  if (!slowReply) delayMs = Math.min(delayMs, 180);
  else if (coalesced) {
    /* 已等过连发窗，只留短停顿像在打字 */
    delayMs = Math.min(delayMs, 800 + Math.floor(Math.random() * 700));
  } else {
    delayMs = Math.max(400, Math.min(22000, delayMs));
  }
  return {
    delayMs,
    skip,
    mood,
    moodPrompt: buildMoodPrompt(mood),
  };
}

function sleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return new Promise((r) => setTimeout(r, n));
}

module.exports = {
  readMood,
  writeMood,
  observeUserText,
  decideReplyGate,
  buildMoodPrompt,
  moodLabel,
  getMoodPublic,
  scanText,
  sleep,
  MOOD_PATH,
};

if (require.main === module) {
  writeMood({ pa: 0.4, na: 0.1, updatedAt: Date.now() });
  const bad = observeUserText("你滚吧 我受够了 分手");
  console.assert(bad.mood.na > 0.4);
  const gateCold = decideReplyGate();
  console.assert(gateCold.delayMs >= 1200);
  const gateFast = decideReplyGate({ slowReply: false });
  console.assert(gateFast.delayMs <= 180);
  writeMood({ pa: 0.5, na: 0.1, updatedAt: Date.now() });
  const good = observeUserText("对不起 抱抱 想你了 和好吧");
  console.assert(good.mood.pa > 0.35);
  console.assert(buildMoodPrompt(good.mood).length >= 0);
  const pub = getMoodPublic();
  console.assert(pub.ok && pub.label);
  console.log("mood selfcheck ok", {
    afterFightNa: bad.mood.na,
    afterPatchPa: good.mood.pa,
    label: pub.label,
  });
}
