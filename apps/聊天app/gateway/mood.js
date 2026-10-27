/**
 * 家机心情：H1.14 门控 + H2.3 V/A + H2.5 事件池 + H2.6 装饰 + H2.7 中表词典。
 * 词典命中 → events[] → 幂律加权合成 PA/NA/V/A → 软互抑 → 门控/prompt。
 * H2.6：限频 ambient；H2.7：薄词典；H2.9：LLM 选词；H2.10：隐喻/防御话术→弱事件。
 * H2.13：30min 批处理；H2.15：urgentPhrases / 脏位 / 反讨好·前景指令。
 * 全量 CVAW 重训另刀。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  matchLexicon,
  matchMetaphor,
  LEXICON,
  LEXICON_SIZE,
  listLexiconPublic,
  addLexiconExtra,
  removeLexiconExtra,
  saveLexiconExtra,
} = require("./mood-lexicon");

const DATA_DIR = path.join(__dirname, "..", "data");
const MOOD_PATH = path.join(DATA_DIR, "mood.json");
const EVENTS_MAX = 120;
const W_KEEP = 0.05;
const TAU_H = 4;
const B_BASE = 0.7;
const FAB = 0.85;
const VA_SCALE = 0.5;

/* H2.6：日常装饰（进同一事件池；限频，不另开管道） */
const AMBIENT_POOL = [
  { label: "刚遛完狗", valence: 0.45, arousal: 0.5, importance: 3 },
  { label: "刚醒来", valence: 0.15, arousal: 0.35, importance: 2 },
  { label: "有点困", valence: -0.1, arousal: 0.25, importance: 2 },
  { label: "吃了点好的", valence: 0.5, arousal: 0.4, importance: 3 },
  { label: "听歌发呆", valence: 0.25, arousal: 0.3, importance: 2 },
  { label: "有点累", valence: -0.15, arousal: 0.3, importance: 3 },
  { label: "晒到太阳了", valence: 0.4, arousal: 0.35, importance: 2 },
  { label: "刷到好笑的", valence: 0.55, arousal: 0.55, importance: 3 },
  { label: "想喝奶茶", valence: 0.2, arousal: 0.45, importance: 2 },
  { label: "窗外下雨", valence: -0.05, arousal: 0.25, importance: 2 },
  { label: "刚洗完澡", valence: 0.35, arousal: 0.3, importance: 2 },
  { label: "有点想你", valence: 0.4, arousal: 0.4, importance: 4 },
];
const AMBIENT_MIN_GAP_MS = 2.5 * 3600 * 1000;
const AMBIENT_FRESH_MS = 3 * 3600 * 1000;
const AMBIENT_CHANCE = 0.55;

/* Wave14 漏斗口语兜底：词典盖不住的伤害/拒绝短句 */
const URGENT_PHRASES = [
  "分手",
  "滚",
  "别找我",
  "不想理你",
  "去死",
  "讨厌你",
  "拉黑",
  "删了吧",
  "我不爱你了",
  "我们完了",
  "你烦不烦",
  "闭嘴",
  "求你别",
  "再见吧",
  "不理你了",
];

const DEFAULT_MOOD = {
  pa: 0.35,
  na: 0.15,
  valence: 0.2,
  arousal: 0.35,
  events: [],
  updatedAt: 0,
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MOOD_PATH)) {
    fs.writeFileSync(
      MOOD_PATH,
      JSON.stringify(
        {
          pa: DEFAULT_MOOD.pa,
          na: DEFAULT_MOOD.na,
          valence: DEFAULT_MOOD.valence,
          arousal: DEFAULT_MOOD.arousal,
          events: [],
          updatedAt: Date.now(),
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function clampVA(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, x));
}

function clampImp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 5;
  return Math.max(1, Math.min(10, Math.round(x)));
}

/** 从 PA/NA 推默认 V/A（旧 mood.json 无字段时） */
function vaFromPaNa(pa, na) {
  const valence = clampVA(pa - na, -1, 1);
  const arousal = clamp01(0.2 + Math.abs(pa - na) * 0.35 + na * 0.4);
  return { valence, arousal };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const valence = clampVA(raw.valence != null ? raw.valence : 0, -1, 1);
  const arousal = clamp01(raw.arousal != null ? raw.arousal : 0.4);
  const ts = Number(raw.ts) || Date.now();
  return {
    id: String(raw.id || "").trim() || randomUUID(),
    kind: raw.kind === "ambient" ? "ambient" : "score",
    label: String(raw.label || "").trim().slice(0, 24),
    valence,
    arousal,
    importance: clampImp(raw.importance != null ? raw.importance : 5),
    ts,
  };
}

/** Wave14：w(t) = (1 + t/τ)^(-b_eff) */
function eventWeight(ev, now) {
  const t = Number(now) || Date.now();
  const hours = Math.max(0, (t - (Number(ev.ts) || t)) / 3600000);
  let bEff = B_BASE / (1 + clampImp(ev.importance) / 10);
  if (Number(ev.valence) > 0) bEff *= FAB;
  return Math.pow(1 + hours / TAU_H, -bEff);
}

function softMutual(pa, na) {
  const pa0 = clamp01(pa);
  const na0 = clamp01(na);
  return {
    pa: clamp01(pa0 * (1 - 0.3 * na0)),
    na: clamp01(na0 * (1 - 0.3 * pa0)),
  };
}

/**
 * 事件池 → PA/NA/V/A（Wave14 统一融合）。
 * pa += max(0,V)×A×0.5×w×强度；再软互抑。
 */
function fuseFromEvents(events, now) {
  const t = Number(now) || Date.now();
  const list = (Array.isArray(events) ? events : [])
    .map(normalizeEvent)
    .filter(Boolean);
  let pa = 0;
  let na = 0;
  let vAcc = 0;
  let aAcc = 0;
  let wSum = 0;
  const kept = [];
  for (const ev of list) {
    const w = eventWeight(ev, t);
    if (w < W_KEEP && t - ev.ts > 48 * 3600000) continue;
    kept.push(ev);
    const strength = 0.55 + clampImp(ev.importance) / 10;
    const V = clampVA(ev.valence, -1, 1);
    const A = clamp01(ev.arousal);
    pa += Math.max(0, V) * A * VA_SCALE * w * strength;
    na += Math.max(0, -V) * A * VA_SCALE * w * strength;
    vAcc += V * w;
    aAcc += A * w;
    wSum += w;
  }
  kept.sort((a, b) => b.ts - a.ts);
  const trimmed = kept.slice(0, EVENTS_MAX);
  if (!trimmed.length) {
    return {
      pa: DEFAULT_MOOD.pa,
      na: DEFAULT_MOOD.na,
      valence: DEFAULT_MOOD.valence,
      arousal: DEFAULT_MOOD.arousal,
      events: [],
      updatedAt: t,
      latest: "",
    };
  }
  const sm = softMutual(pa, na);
  const valence =
    wSum > 0
      ? clampVA(vAcc / wSum, -1, 1)
      : vaFromPaNa(sm.pa, sm.na).valence;
  const arousal =
    wSum > 0 ? clamp01(aAcc / wSum) : vaFromPaNa(sm.pa, sm.na).arousal;
  const latestEv = trimmed[0];
  return {
    pa: sm.pa,
    na: sm.na,
    valence,
    arousal,
    events: trimmed,
    updatedAt: t,
    latest: latestEv && latestEv.label ? latestEv.label : "",
  };
}

function readMoodRaw() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(MOOD_PATH, "utf8"));
  } catch (_) {
    return null;
  }
}

function readMood() {
  const raw = readMoodRaw();
  if (!raw || typeof raw !== "object") {
    return Object.assign({}, DEFAULT_MOOD, { updatedAt: Date.now() });
  }
  let events = Array.isArray(raw.events)
    ? raw.events.map(normalizeEvent).filter(Boolean)
    : [];
  /* 旧文件无 events：用标量种一条 ambient，避免状态归零 */
  if (!events.length && (raw.pa != null || raw.valence != null)) {
    const pa = clamp01(raw.pa);
    const na = clamp01(raw.na);
    const fb = vaFromPaNa(pa, na);
    events = [
      normalizeEvent({
        id: "seed",
        kind: "ambient",
        label: "",
        valence:
          raw.valence != null ? clampVA(raw.valence, -1, 1) : fb.valence,
        arousal: raw.arousal != null ? clamp01(raw.arousal) : fb.arousal,
        importance: 4,
        ts: Number(raw.updatedAt) || Date.now(),
      }),
    ];
  }
  return fuseFromEvents(events, Date.now());
}

function readMoodDirty() {
  const raw = readMoodRaw();
  return !!(raw && raw.dirty);
}

function moodPayload(fused, dirty) {
  return {
    pa: fused.pa,
    na: fused.na,
    valence: fused.valence,
    arousal: fused.arousal,
    events: fused.events,
    updatedAt: fused.updatedAt,
    dirty: !!dirty,
  };
}

function writeMood(m) {
  ensureFile();
  const prev = readMoodRaw() || {};
  const dirty =
    m && Object.prototype.hasOwnProperty.call(m, "dirty")
      ? !!m.dirty
      : !!prev.dirty;
  const fused =
    m && Array.isArray(m.events)
      ? fuseFromEvents(m.events, Number(m.updatedAt) || Date.now())
      : fuseFromEvents(
          (m && m.events) || prev.events || [],
          Date.now()
        );
  /* 允许测试直接塞 pa/na（无 events 时）种 seed */
  let events = fused.events;
  if ((!events || !events.length) && m && (m.pa != null || m.na != null)) {
    const pa = clamp01(m.pa);
    const na = clamp01(m.na);
    const fb = vaFromPaNa(pa, na);
    events = [
      normalizeEvent({
        id: randomUUID(),
        kind: "ambient",
        valence: m.valence != null ? clampVA(m.valence, -1, 1) : fb.valence,
        arousal: m.arousal != null ? clamp01(m.arousal) : fb.arousal,
        importance: 4,
        ts: Date.now(),
      }),
    ];
    const again = fuseFromEvents(events, Date.now());
    fs.writeFileSync(
      MOOD_PATH,
      JSON.stringify(moodPayload(again, dirty), null, 2),
      "utf8"
    );
    return again;
  }
  fs.writeFileSync(
    MOOD_PATH,
    JSON.stringify(moodPayload(fused, dirty), null, 2),
    "utf8"
  );
  return fused;
}

function markMoodDirty() {
  const cur = readMood();
  writeMood({ events: cur.events, updatedAt: cur.updatedAt, dirty: true });
}

function clearMoodDirty() {
  const cur = readMood();
  writeMood({ events: cur.events, updatedAt: cur.updatedAt, dirty: false });
}

function hitUrgentPhrase(text) {
  const s = String(text || "");
  if (!s) return false;
  for (const p of URGENT_PHRASES) {
    if (s.indexOf(p) >= 0) return true;
  }
  return false;
}

/** 幂律衰减 = 重算事件池（Wave14）；保留函数名兼容旧调用 */
function decayMood(m, now) {
  const events = m && Array.isArray(m.events) ? m.events : readMood().events;
  return fuseFromEvents(events, now || Date.now());
}

function scanText(text) {
  const matched = matchLexicon(text);
  const hits = matched.map((e) => ({
    w: e.w,
    valence: e.v,
    arousal: e.a,
    importance: e.i,
  }));
  let minV = 0;
  let maxV = 0;
  let negCount = 0;
  let posCount = 0;
  let vSum = 0;
  let aSum = 0;
  let iMax = 0;
  for (const h of hits) {
    const v = clampVA(h.valence, -1, 1);
    vSum += v;
    aSum += clamp01(h.arousal);
    iMax = Math.max(iMax, clampImp(h.importance));
    if (v < 0) {
      negCount += 1;
      minV = Math.min(minV, v);
    } else if (v > 0) {
      posCount += 1;
      maxV = Math.max(maxV, v);
    }
  }
  const n = hits.length;
  const avgV = n ? vSum / n : 0;
  const hitArousal = n
    ? clamp01(aSum / n)
    : 0.3;
  /* 多命中略抬唤醒 */
  const arousalBoost = n >= 3 ? 0.08 : 0;
  return {
    minV,
    maxV,
    negCount,
    posCount,
    avgV,
    hitArousal: clamp01(hitArousal + arousalBoost),
    importance: iMax || 0,
    hits,
  };
}

/** 本轮用户句 → 0～1 条 score 事件（坐标取自词典） */
function eventFromScan(sc) {
  if (!sc || !sc.hits || !sc.hits.length) return null;
  const n = sc.hits.length;
  let valence = clampVA(sc.avgV, -1, 1);
  if (sc.minV < -0.5 && sc.negCount >= sc.posCount) {
    valence = clampVA(Math.min(valence, sc.minV + 0.05), -1, 1);
  }
  if (sc.maxV > 0.55 && sc.posCount > sc.negCount) {
    valence = clampVA(Math.max(valence, sc.maxV - 0.05), -1, 1);
  }
  const importance = clampImp(
    Math.max(sc.importance || 5, 3 + sc.negCount + sc.posCount + (n >= 3 ? 1 : 0))
  );
  /* 标签：|V| 最大的那条 */
  let best = sc.hits[0];
  for (const h of sc.hits) {
    if (Math.abs(h.valence) > Math.abs(best.valence)) best = h;
  }
  return normalizeEvent({
    id: randomUUID(),
    kind: "score",
    label: best.w || "",
    valence,
    arousal: sc.hitArousal,
    importance,
    ts: Date.now(),
  });
}

/** 用户明确叫停解读时不写隐喻事件 */
function metaphorOptOut(text) {
  const s = String(text || "");
  return /我就是这个意思|别想多了|别多想|字面意思|没有别的意思|真的没事[啦啊哦]?[。！!]?$/.test(
    s
  );
}

/** H2.10：隐喻命中 → 弱 score（低 importance，不抢强情绪） */
function eventFromMetaphor(hits) {
  if (!hits || !hits.length) return null;
  let vSum = 0;
  let aSum = 0;
  let iMax = 0;
  for (const h of hits) {
    vSum += h.v;
    aSum += h.a;
    iMax = Math.max(iMax, h.i);
  }
  const n = hits.length;
  let best = hits[0];
  for (const h of hits) {
    if (Math.abs(h.v) > Math.abs(best.v)) best = h;
  }
  return normalizeEvent({
    id: randomUUID(),
    kind: "score",
    label: best.w || "言外",
    valence: clampVA(vSum / n, -1, 1),
    arousal: clamp01(aSum / n),
    importance: clampImp(Math.min(4, Math.max(2, iMax))),
    ts: Date.now(),
  });
}

function observeUserText(text) {
  const sc = scanText(text);
  const cur = readMood();
  const events = Array.isArray(cur.events) ? cur.events.slice() : [];
  const ev = eventFromScan(sc);
  if (ev) events.unshift(ev);

  let metaphorEvent = null;
  if (!metaphorOptOut(text)) {
    const metaHits = matchMetaphor(text);
    /* 已有强负向字面情绪时不叠隐喻，避免「分手+没事」双计 */
    const strongLex = sc.minV < -0.5 || (sc.negCount >= 2 && sc.avgV < -0.35);
    if (metaHits.length && !strongLex) {
      metaphorEvent = eventFromMetaphor(metaHits);
      if (metaphorEvent) events.unshift(metaphorEvent);
    }
  }

  const mood = writeMood({
    events,
    updatedAt: Date.now(),
    dirty: true,
  });
  return {
    mood,
    scan: sc,
    event: ev || metaphorEvent,
    metaphorEvent,
  };
}

/** Wave14 漏斗：大波动才值得花 token 做选词校准 */
function scanIntensity(text, sc) {
  const bang = (String(text || "").match(/[!！?？…]/g) || []).length;
  const n = (sc && sc.hits && sc.hits.length) || 0;
  return Math.min(1, n * 0.15 + bang * 0.12 + (sc && sc.negCount >= 2 ? 0.2 : 0));
}

function shouldCalibrate(scan, mood, text) {
  const sc = scan || { minV: 0, maxV: 0, negCount: 0, posCount: 0, avgV: 0, hits: [] };
  const m = mood || readMood();
  const intensity = scanIntensity(text, sc);
  if (hitUrgentPhrase(text)) return true;
  if (sc.minV < -0.5) return true;
  if (sc.maxV > 0.7) return true;
  if (sc.negCount >= 2 && sc.avgV < -0.2) return true;
  if (intensity >= 0.7) return true;
  if (m.pa >= 0.5 && sc.avgV < -0.2 && (sc.negCount || sc.hits.length)) return true;
  if (m.na >= 0.4 && sc.avgV > 0.2 && (sc.posCount || sc.hits.length)) return true;
  return false;
}

/**
 * 把 LLM 选出的词落到词典坐标，写入一条 score 事件。
 * @returns {{ event: object, mood: object } | null}
 */
function applyCalibratedWords(words) {
  const raw = Array.isArray(words) ? words : [];
  const hits = [];
  const seen = new Set();
  for (const w0 of raw) {
    const w = String(w0 || "").trim().slice(0, 24);
    if (!w || seen.has(w)) continue;
    let entry = LEXICON.find((e) => e.w === w);
    if (!entry) {
      const m = matchLexicon(w);
      entry = m[0] || null;
    }
    if (!entry) continue;
    seen.add(entry.w);
    hits.push(entry);
    if (hits.length >= 5) break;
  }
  if (!hits.length) return null;
  let vSum = 0;
  let aSum = 0;
  let iMax = 0;
  for (const h of hits) {
    vSum += h.v;
    aSum += h.a;
    iMax = Math.max(iMax, h.i);
  }
  const n = hits.length;
  let best = hits[0];
  for (const h of hits) {
    if (Math.abs(h.v) > Math.abs(best.v)) best = h;
  }
  const ev = normalizeEvent({
    id: randomUUID(),
    kind: "score",
    label: best.w,
    valence: clampVA(vSum / n, -1, 1),
    arousal: clamp01(aSum / n),
    importance: clampImp(Math.max(iMax, 6 + Math.min(2, n - 1))),
    ts: Date.now(),
  });
  const cur = readMood();
  const events = Array.isArray(cur.events) ? cur.events.slice() : [];
  events.unshift(ev);
  const mood = writeMood({ events, updatedAt: Date.now() });
  return { event: ev, mood, words: hits.map((h) => h.w) };
}

function parseCalibrateWords(content) {
  const s = String(content || "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(String);
    if (j && Array.isArray(j.words)) return j.words.map(String);
  } catch (_) {
    /* 容错：抽 JSON 块 */
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && Array.isArray(j.words)) return j.words.map(String);
    } catch (_) {}
  }
  return [];
}

/**
 * H2.9：大波动时 LLM 从词表选词，词典给 V/A。失败/未配置 → null，不挡接话。
 * @returns {Promise<{ ok: true, event, mood, words, used } | null>}
 */
async function maybeCalibrateMood(userText, opts) {
  const text = String(userText || "").trim();
  if (text.length < 2 || text.length > 500) return null;
  const sc = (opts && opts.scan) || scanText(text);
  const moodBefore = readMood();
  if (!(opts && opts.force) && !shouldCalibrate(sc, moodBefore, text)) {
    return null;
  }
  let chatCompletion;
  try {
    chatCompletion = require("../../共读app/gateway/llm").chatCompletion;
  } catch (_) {
    return null;
  }
  const vocab = LEXICON.map((e) => e.w).join("、");
  const system =
    "你是情绪选词器。只从给定词表里选 0～5 个最能概括「用户这句话对角色心情冲击」的词。" +
    "反讨好：冷场就选低唤醒中性/淡漠词，敷衍就别美化成甜蜜；伤害/拒绝必须如实偏负，禁止每次都往正面美化。" +
    "不要解释。只输出一行 JSON：{\"words\":[\"词1\",\"词2\"]}。" +
    "词必须出自词表；没有合适的就 {\"words\":[]}。";
  const user =
    "词表：\n" +
    vocab +
    "\n\n用户这句话：\n" +
    text.slice(0, 400);
  let raw;
  try {
    raw = await chatCompletion({
      system,
      user,
      think: false,
      replyKind: "chat",
    });
  } catch (_) {
    return null;
  }
  const words = parseCalibrateWords(raw && raw.content);
  const applied = applyCalibratedWords(words);
  if (!applied) return null;
  const used =
    (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0) || 400;
  return {
    ok: true,
    event: applied.event,
    mood: applied.mood,
    words: applied.words,
    used,
  };
}

/** 记忆库鲜活条 valence 轻拉（仅本请求，不写事件、不落盘） */
function nudgeFromMemory(mood, peerId) {
  if (!peerId || !mood) return mood;
  try {
    const { listPeerMemories } = require("./memory");
    const { memories } = listPeerMemories(peerId, { limit: 3 });
    if (!memories || !memories.length) return mood;
    let sum = 0;
    let n = 0;
    for (const mem of memories) {
      if (mem && mem.valence != null) {
        sum += clampVA(mem.valence, -1, 1);
        n += 1;
      }
    }
    if (!n) return mood;
    const mean = sum / n;
    const next = Object.assign({}, mood);
    next.valence = clampVA(mood.valence * 0.92 + mean * 0.08, -1, 1);
    if (mean < -0.2) next.na = clamp01(mood.na + 0.03);
    if (mean > 0.2) next.pa = clamp01(mood.pa + 0.03);
    const sm = softMutual(next.pa, next.na);
    next.pa = sm.pa;
    next.na = sm.na;
    return next;
  } catch (_) {
    return mood;
  }
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
  const v = Math.round(clampVA(m.valence, -1, 1) * 100) / 100;
  const a = Math.round(clamp01(m.arousal) * 100) / 100;
  parts.push(
    "情感坐标 valence=" +
      v +
      "（负=负面，正=正面），arousal=" +
      a +
      "（高=激动，低=平静）；语气跟着坐标走，勿报数字。"
  );
  if (m.latest) {
    parts.push("最近情绪线索：「" + String(m.latest).slice(0, 16) + "」。");
  }
  parts.push(
    "预设心情是背景色；对方当前这条消息才是前景——若这话带伤害/拒绝/怒意，必须先对这话做出真实反应，即使之前心情不错；对方示好时也可以被融化。"
  );
  return (
    "【当下心情】\n" +
    parts.join("\n") +
    "\n（自然融入回答，不要主动点破「我在按心情设定演戏」。）"
  );
}

function moodLabel(mood) {
  const m = mood || readMood();
  if (m.na >= 0.72) return "冷战";
  if (m.na >= 0.4 || (m.valence <= -0.2 && m.na >= 0.28)) return "别扭";
  if (m.valence <= -0.35 && m.arousal >= 0.55) return "生气";
  if (m.valence <= -0.25 && m.arousal < 0.45) return "低落";
  if (m.pa >= 0.55 && m.na < 0.28) return "开心";
  if (m.pa < 0.22 && m.na < 0.4) return "低落";
  if (m.valence >= 0.35 && m.arousal >= 0.55) return "兴奋";
  return "平静";
}

function lastAmbientTs(events) {
  let t = 0;
  for (const ev of events || []) {
    if (!ev || ev.kind !== "ambient") continue;
    if (String(ev.id || "") === "seed") continue;
    t = Math.max(t, Number(ev.ts) || 0);
  }
  return t;
}

/**
 * H2.6：限频写入 0～1 条 ambient。force 时跳过概率（自检用）。
 * @returns {object | null} 新事件；未写则 null
 */
function maybeAmbient(opts) {
  const force = !!(opts && opts.force);
  const cur = readMood();
  const events = Array.isArray(cur.events) ? cur.events.slice() : [];
  const now = Date.now();
  const last = lastAmbientTs(events);
  if (!force && last && now - last < AMBIENT_MIN_GAP_MS) return null;
  if (!force && Math.random() > AMBIENT_CHANCE) return null;
  const prevLab =
    events.find((e) => e && e.kind === "ambient" && e.id !== "seed") || null;
  let pick = AMBIENT_POOL[Math.floor(Math.random() * AMBIENT_POOL.length)];
  if (prevLab && AMBIENT_POOL.length > 1) {
    for (let i = 0; i < 4; i++) {
      const cand = AMBIENT_POOL[Math.floor(Math.random() * AMBIENT_POOL.length)];
      if (cand.label !== prevLab.label) {
        pick = cand;
        break;
      }
    }
  }
  if (!pick) return null;
  const ev = normalizeEvent({
    id: randomUUID(),
    kind: "ambient",
    label: pick.label,
    valence: pick.valence,
    arousal: pick.arousal,
    importance: pick.importance,
    ts: now,
  });
  events.unshift(ev);
  writeMood({ events, updatedAt: now });
  return ev;
}

/** Wave14：胶囊取池中最新一条；新鲜 ambient 优先生动标签，否则 PA/NA 标签 */
function publicLabel(mood) {
  const m = mood || readMood();
  const latest = Array.isArray(m.events) && m.events[0] ? m.events[0] : null;
  const now = Date.now();
  if (
    latest &&
    latest.kind === "ambient" &&
    latest.label &&
    now - (Number(latest.ts) || 0) < AMBIENT_FRESH_MS
  ) {
    return String(latest.label).slice(0, 16);
  }
  return moodLabel(m);
}

/** H2.8：星图用事件点（只读快照） */
function moodPoints(mood, now) {
  const t = Number(now) || Date.now();
  const list = Array.isArray(mood && mood.events) ? mood.events : [];
  return list.slice(0, 40).map((ev) => {
    const ts = Number(ev.ts) || t;
    return {
      kind: ev.kind === "ambient" ? "ambient" : "score",
      label: String(ev.label || "").slice(0, 24),
      valence: Math.round(clampVA(ev.valence, -1, 1) * 1000) / 1000,
      arousal: Math.round(clamp01(ev.arousal) * 1000) / 1000,
      importance: clampImp(ev.importance),
      ageH: Math.round(((t - ts) / 3600000) * 10) / 10,
      w: Math.round(eventWeight(ev, t) * 1000) / 1000,
    };
  });
}

/** H2.17：幂律衰减预览曲线（小时轴）；三档 importance，valence=-0.2 */
const DECAY_HOURS = [0, 1, 4, 12, 24, 48, 72, 168, 360, 720];
function decayCurvePreview(now) {
  const t = Number(now) || Date.now();
  const series = [1, 5, 9].map((imp) => ({
    importance: imp,
    points: DECAY_HOURS.map((h) => {
      const w = eventWeight(
        { valence: -0.2, importance: imp, ts: t - h * 3600000 },
        t
      );
      return { h, w: Math.round(w * 1000) / 1000 };
    }),
  }));
  return { hours: DECAY_HOURS.slice(), series };
}

/** 对外快照：胶囊 / GET /api/v1/chat/mood */
function getMoodPublic(opts) {
  maybeAmbient();
  let mood = readMood();
  mood = nudgeFromMemory(mood, opts && opts.peerId);
  const now = Date.now();
  const points = moodPoints(mood, now);
  return {
    ok: true,
    pa: Math.round(mood.pa * 1000) / 1000,
    na: Math.round(mood.na * 1000) / 1000,
    valence: Math.round(clampVA(mood.valence, -1, 1) * 1000) / 1000,
    arousal: Math.round(clamp01(mood.arousal) * 1000) / 1000,
    label: publicLabel(mood),
    moodLabel: moodLabel(mood),
    latest: mood.latest || "",
    events: (mood.events || []).length,
    points,
    decayCurve: decayCurvePreview(now),
    updatedAt: mood.updatedAt,
  };
}

/**
 * @param {{ slowReply?: boolean, coalesced?: boolean, peerId?: string }} [opts]
 */
function decideReplyGate(opts) {
  maybeAmbient();
  let mood = readMood();
  mood = nudgeFromMemory(mood, opts && opts.peerId);
  const slowReply = !(opts && opts.slowReply === false);
  const coalesced = !!(opts && opts.coalesced);
  let delayMs = 1200 + Math.floor(Math.random() * 2800);
  let skip = false;
  if (mood.na >= 0.45) {
    delayMs += 3000 + Math.floor(mood.na * 9000);
  }
  if (mood.arousal >= 0.65 && mood.valence < 0) {
    delayMs += 800;
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
    delayMs = Math.min(delayMs, 800 + Math.floor(Math.random() * 700));
  } else {
    delayMs = Math.max(400, Math.min(22000, delayMs));
  }
  try {
    require("../../资产app/gateway/pocket-keys").syncPocketKeysFromMoodLabel(
      moodLabel(mood),
      mood
    );
  } catch (_) {
    /* 零花换钥可选 */
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

const BATCH_MS = 30 * 60 * 1000;
let batchTimer = null;
let lastBatchAt = 0;

/**
 * 30min 批处理：脏位才跑（无对话不耗）；扫近句喂词典；小波动补 1 次 LLM 选词。
 * ponytail: 非全量 CVAW 重训；额外词表见 data/cvaw-extra.json（可选）。
 */
async function runMoodBatch(opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  const wasDirty = readMoodDirty();
  if (!force && !wasDirty) {
    return { ok: true, skipped: true, reason: "clean", lastBatchAt };
  }
  if (!force && lastBatchAt && now - lastBatchAt < BATCH_MS - 5000) {
    return { ok: true, skipped: true, reason: "cooldown", lastBatchAt };
  }
  lastBatchAt = now;
  let scanned = 0;
  let hits = 0;
  let latestYou = "";
  try {
    const { listPeers, withPeer, listMessages, llmContent } = require("./daily-chat");
    const peers = (listPeers().peers || []).slice(0, 8);
    for (const p of peers) {
      withPeer(p.id, () => {
        const msgs = (listMessages().messages || []).slice(-30);
        for (const m of msgs) {
          if (!m || m.from !== "you") continue;
          const t = String(llmContent(m) || "").trim();
          if (!t || t.length < 2) continue;
          scanned += 1;
          latestYou = t;
          const out = observeUserText(t);
          if (out && (out.event || out.metaphorEvent)) hits += 1;
        }
      });
    }
  } catch (_) {}
  let calibrated = null;
  /* 有情绪命中才补 1 次选词（小波动）；纯寒暄不烧 token */
  if (hits > 0 && latestYou && latestYou.length >= 2 && latestYou.length <= 500) {
    try {
      calibrated = await maybeCalibrateMood(latestYou, { force: true });
    } catch (_) {
      calibrated = null;
    }
  }
  try {
    maybeAmbient();
  } catch (_) {}
  try {
    const m = readMood();
    require("../../资产app/gateway/pocket-keys").syncPocketKeysFromMoodLabel(
      moodLabel(m),
      m
    );
  } catch (_) {}
  clearMoodDirty();
  return {
    ok: true,
    scanned,
    hits,
    calibrated: !!(calibrated && calibrated.ok),
    lastBatchAt,
    lexicon: LEXICON_SIZE,
  };
}

function startMoodBatchScheduler() {
  if (batchTimer) return { ok: true, running: true };
  batchTimer = setInterval(() => {
    Promise.resolve(runMoodBatch()).catch(() => {});
  }, BATCH_MS);
  if (batchTimer.unref) batchTimer.unref();
  setTimeout(() => {
    Promise.resolve(runMoodBatch({ force: true })).catch(() => {});
  }, 12_000).unref?.();
  return { ok: true, running: true, interval_ms: BATCH_MS };
}

module.exports = {
  readMood,
  writeMood,
  observeUserText,
  decideReplyGate,
  buildMoodPrompt,
  moodLabel,
  publicLabel,
  getMoodPublic,
  maybeAmbient,
  maybeCalibrateMood,
  shouldCalibrate,
  hitUrgentPhrase,
  readMoodDirty,
  markMoodDirty,
  clearMoodDirty,
  applyCalibratedWords,
  scanText,
  eventWeight,
  fuseFromEvents,
  decayCurvePreview,
  listLexiconPublic,
  addLexiconExtra,
  removeLexiconExtra,
  saveLexiconExtra,
  sleep,
  runMoodBatch,
  startMoodBatchScheduler,
  MOOD_PATH,
  AMBIENT_POOL,
  LEXICON_SIZE,
  BATCH_MS,
  URGENT_PHRASES,
};

if (require.main === module) {
  (async () => {
    writeMood({
      pa: 0.4,
      na: 0.1,
      valence: 0.3,
      arousal: 0.3,
      updatedAt: Date.now(),
      dirty: false,
    });
    const bad = observeUserText("你滚吧 我受够了 分手");
    console.assert(bad.mood.na > 0.25, "fight na");
    console.assert(bad.mood.valence < 0.2, "fight v");
    console.assert(bad.event && bad.event.kind === "score", "score event");
    console.assert(Array.isArray(bad.mood.events) && bad.mood.events.length >= 1);
    console.assert(readMoodDirty(), "dirty after observe");
    console.assert(LEXICON_SIZE >= 80, "lexicon");
    const soft = scanText("我很难过也很失望");
    console.assert(soft.negCount >= 1 && soft.avgV < 0, "lexicon soft neg");
    console.assert(soft.hits.some((h) => h.arousal > 0), "lexicon arousal");
    const w0 = eventWeight(
      { valence: -0.7, importance: 5, ts: Date.now() },
      Date.now()
    );
    const w24 = eventWeight(
      { valence: -0.7, importance: 5, ts: Date.now() - 24 * 3600000 },
      Date.now()
    );
    console.assert(w0 > w24 && w24 > 0.2, "power-law decay");
    const gateCold = decideReplyGate();
    console.assert(gateCold.delayMs >= 1200);
    const gateFast = decideReplyGate({ slowReply: false });
    console.assert(gateFast.delayMs <= 180);
    writeMood({
      pa: 0.5,
      na: 0.1,
      valence: 0.4,
      arousal: 0.35,
      updatedAt: Date.now(),
      dirty: false,
    });
    const good = observeUserText("对不起 抱抱 想你了 和好吧");
    console.assert(good.mood.pa > 0.25, "patch pa");
    console.assert(buildMoodPrompt(good.mood).includes("valence="));
    console.assert(buildMoodPrompt(good.mood).includes("前景"), "foreground");
    const pub = getMoodPublic();
    console.assert(pub.ok && pub.label && pub.valence != null && pub.arousal != null);
    console.assert(pub.events >= 1);
    console.assert(Array.isArray(pub.points) && pub.points.length >= 1, "points");
    console.assert(pub.points[0].valence != null && pub.points[0].arousal != null);
    const amb = maybeAmbient({ force: true });
    console.assert(amb && amb.kind === "ambient" && amb.label, "ambient");
    const afterAmb = readMood();
    console.assert(publicLabel(afterAmb) === amb.label, "public ambient label");
    const amb2 = maybeAmbient();
    console.assert(amb2 == null, "ambient gap");
    const extreme = softMutual(1, 1);
    console.assert(extreme.pa < 0.8 && extreme.na < 0.8, "esm");
    const calScan = scanText("你滚 分手吧 我受够了");
    console.assert(
      shouldCalibrate(calScan, { pa: 0.6, na: 0.1 }, "你滚 分手吧"),
      "calibrate gate"
    );
    console.assert(hitUrgentPhrase("我要拉黑你了"), "urgent phrase");
    console.assert(
      shouldCalibrate(scanText("嗯"), { pa: 0.3, na: 0.1 }, "我要拉黑你了"),
      "urgent gate"
    );
    const applied = applyCalibratedWords(["难过", "失望", "不存在的词"]);
    console.assert(applied && applied.words.includes("难过"), "calibrate apply");
    writeMood({
      pa: 0.5,
      na: 0.15,
      valence: 0.35,
      arousal: 0.35,
      updatedAt: Date.now(),
      dirty: false,
    });
    const meta = observeUserText("没事，随便");
    console.assert(meta.metaphorEvent && meta.metaphorEvent.importance <= 4, "metaphor weak");
    console.assert(meta.mood.valence < 0.35, "metaphor pulls v");
    const skipMeta = observeUserText("没事，我就是这个意思");
    console.assert(!skipMeta.metaphorEvent, "metaphor opt-out");
    clearMoodDirty();
    lastBatchAt = 0;
    const cleanBatch = await runMoodBatch();
    console.assert(cleanBatch && cleanBatch.skipped && cleanBatch.reason === "clean", "dirty skip");
    console.log("mood selfcheck ok", {
      afterFightNa: bad.mood.na,
      afterFightV: bad.mood.valence,
      afterPatchPa: good.mood.pa,
      label: pub.label,
      ambient: amb.label,
      events: readMood().events.length,
      w0: Math.round(w0 * 100) / 100,
      w24: Math.round(w24 * 100) / 100,
    });
  })().catch((e) => {
    console.error("mood selfcheck fail", e);
    process.exit(1);
  });
}
