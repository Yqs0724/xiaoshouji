/**
 * H2.7 情绪中表 + H2.10 隐喻/防御话术薄表。
 * 每条：词 / valence(-1~1) / arousal(0~1) / importance(1~10)。
 * ponytail: 内置百级；可选 data/cvaw-extra.json 追加（数组 [词,v,a,imp]）；真全量 CVAW 需自备词表。
 */
const fs = require("node:fs");
const path = require("node:path");

const RAW = [
  /* —— 关系 / 冲突（偏长优先） —— */
  ["不想跟你说", -0.55, 0.4, 6],
  ["爱答不理", -0.5, 0.35, 5],
  ["不要你了", -0.85, 0.65, 9],
  ["滚出去", -0.9, 0.8, 9],
  ["分手吧", -0.88, 0.75, 9],
  ["别找我", -0.75, 0.55, 8],
  ["不理你", -0.7, 0.5, 7],
  ["不想理", -0.65, 0.45, 7],
  ["别说话", -0.55, 0.45, 6],
  ["不想聊", -0.45, 0.35, 5],
  ["受够了", -0.8, 0.7, 8],
  ["讨厌你", -0.75, 0.65, 8],
  ["恨你", -0.85, 0.75, 9],
  ["骗子", -0.7, 0.6, 7],
  ["拉黑", -0.8, 0.55, 8],
  ["冷战", -0.6, 0.35, 7],
  ["分手", -0.85, 0.7, 9],
  ["滚吧", -0.85, 0.75, 8],
  ["去死", -0.95, 0.85, 9],
  ["闭嘴", -0.65, 0.7, 6],
  ["有病", -0.55, 0.55, 5],
  ["恶心", -0.7, 0.6, 6],
  ["烦死", -0.65, 0.7, 6],
  ["气死", -0.7, 0.85, 7],
  ["冷漠", -0.55, 0.3, 5],
  ["冷淡", -0.5, 0.3, 5],
  ["敷衍", -0.45, 0.35, 5],
  ["没劲", -0.35, 0.25, 4],
  ["无聊", -0.25, 0.3, 3],
  ["无语", -0.4, 0.45, 4],
  ["滚", -0.85, 0.8, 8],
  ["讨厌", -0.6, 0.55, 6],
  ["生气", -0.55, 0.75, 6],
  /* —— 负面情绪 —— */
  ["失望透了", -0.7, 0.45, 7],
  ["很难过", -0.65, 0.4, 6],
  ["好委屈", -0.6, 0.5, 6],
  ["好伤心", -0.7, 0.45, 7],
  ["好害怕", -0.55, 0.7, 6],
  ["好焦虑", -0.5, 0.75, 6],
  ["好烦", -0.5, 0.6, 5],
  ["崩溃", -0.75, 0.85, 8],
  ["绝望", -0.85, 0.55, 8],
  ["孤独", -0.55, 0.3, 5],
  ["寂寞", -0.5, 0.3, 5],
  ["委屈", -0.55, 0.5, 6],
  ["伤心", -0.65, 0.4, 6],
  ["难过", -0.6, 0.35, 6],
  ["失望", -0.55, 0.4, 6],
  ["心疼", -0.35, 0.45, 5],
  ["愧疚", -0.4, 0.5, 5],
  ["后悔", -0.45, 0.5, 5],
  ["尴尬", -0.3, 0.55, 4],
  ["紧张", -0.2, 0.7, 4],
  ["焦虑", -0.45, 0.75, 6],
  ["担心", -0.35, 0.6, 5],
  ["害怕", -0.5, 0.7, 6],
  ["恐惧", -0.7, 0.8, 7],
  ["愤怒", -0.7, 0.85, 8],
  ["暴躁", -0.6, 0.8, 6],
  ["嫉妒", -0.45, 0.65, 5],
  ["吃醋", -0.35, 0.6, 5],
  ["酸了", -0.3, 0.55, 4],
  ["郁闷", -0.45, 0.35, 4],
  ["低落", -0.5, 0.25, 5],
  ["疲惫", -0.3, 0.25, 4],
  ["累了", -0.35, 0.3, 4],
  ["想哭", -0.6, 0.55, 6],
  ["哭了", -0.55, 0.5, 5],
  /* —— 正面 / 修复 —— */
  ["对不起嘛", 0.35, 0.4, 5],
  ["抱抱你", 0.7, 0.45, 6],
  ["想通了", 0.45, 0.4, 5],
  ["没事了", 0.4, 0.35, 5],
  ["和好吧", 0.55, 0.45, 6],
  ["爱你哦", 0.85, 0.55, 8],
  ["喜欢你", 0.75, 0.5, 7],
  ["想你了", 0.65, 0.45, 6],
  ["太好了", 0.7, 0.65, 6],
  ["好开心", 0.75, 0.65, 6],
  ["好幸福", 0.8, 0.55, 7],
  ["好感动", 0.7, 0.55, 6],
  ["辛苦了", 0.45, 0.35, 4],
  ["对不起", 0.3, 0.4, 5],
  ["原谅", 0.5, 0.4, 6],
  ["和好", 0.55, 0.4, 6],
  ["消气", 0.4, 0.35, 5],
  ["爱你", 0.85, 0.55, 8],
  ["抱抱", 0.65, 0.4, 6],
  ["亲亲", 0.7, 0.5, 5],
  ["么么", 0.6, 0.45, 4],
  ["想你", 0.55, 0.4, 5],
  ["喜欢", 0.6, 0.45, 5],
  ["开心", 0.7, 0.6, 5],
  ["高兴", 0.65, 0.55, 5],
  ["幸福", 0.75, 0.5, 6],
  ["安心", 0.5, 0.25, 4],
  ["温暖", 0.55, 0.3, 4],
  ["舒服", 0.5, 0.3, 3],
  ["放松", 0.45, 0.25, 3],
  ["兴奋", 0.65, 0.8, 6],
  ["期待", 0.5, 0.6, 4],
  ["谢谢", 0.45, 0.35, 3],
  ["晚安", 0.4, 0.25, 3],
  ["早安", 0.4, 0.4, 3],
  ["加油", 0.5, 0.55, 4],
  ["骄傲", 0.6, 0.55, 5],
  ["感动", 0.65, 0.5, 5],
  ["甜蜜", 0.7, 0.45, 5],
  ["可爱", 0.55, 0.45, 3],
  ["好笑", 0.55, 0.55, 3],
  ["惊喜", 0.7, 0.75, 6],
  ["放心", 0.45, 0.3, 4],
  ["信任", 0.55, 0.35, 5],
  ["想见面", 0.6, 0.5, 5],
  ["陪陪我", 0.4, 0.4, 5],
  ["想你啦", 0.6, 0.45, 5],
];

function buildLexicon(rows) {
  const list = [];
  const seen = new Set();
  for (const row of rows) {
    const w = String(row[0] || "").trim();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    list.push({
      w,
      v: Math.max(-1, Math.min(1, Number(row[1]) || 0)),
      a: Math.max(0, Math.min(1, Number(row[2]) || 0.4)),
      i: Math.max(1, Math.min(10, Math.round(Number(row[3]) || 5))),
    });
  }
  list.sort((a, b) => b.w.length - a.w.length || a.w.localeCompare(b.w, "zh"));
  return list;
}

const LEXICON = buildLexicon(RAW);

/* H2.10：言外之意——弱负向、低唤醒、低重要度（不抢吵架事件） */
const METAPHOR_RAW = [
  ["我一点也不难过", -0.35, 0.35, 4],
  ["我才没生气", -0.4, 0.4, 4],
  ["我没有生气", -0.35, 0.35, 4],
  ["到时候再说", -0.3, 0.3, 3],
  ["看情况吧", -0.28, 0.28, 3],
  ["没什么", -0.25, 0.28, 3],
  ["不说了", -0.35, 0.35, 4],
  ["算了吧", -0.35, 0.32, 4],
  ["都行吧", -0.22, 0.25, 3],
  ["你定吧", -0.25, 0.28, 3],
  ["都可以", -0.2, 0.25, 2],
  ["随便你", -0.3, 0.3, 3],
  ["有点累", -0.22, 0.28, 3],
  ["还好啦", -0.2, 0.28, 3],
  ["没事的", -0.25, 0.3, 3],
  ["没事啦", -0.25, 0.3, 3],
  ["没事", -0.28, 0.3, 3],
  ["随便", -0.3, 0.3, 3],
  ["还好", -0.18, 0.28, 2],
  ["算了", -0.32, 0.3, 3],
  ["都行", -0.2, 0.25, 2],
];

const METAPHOR = buildLexicon(METAPHOR_RAW);

/**
 * 长词优先命中；若短词已被更长命中词覆盖则跳过（「分手吧」压过「分手」）。
 */
function matchLexicon(text) {
  const s = String(text || "");
  if (!s) return [];
  const hits = [];
  for (const e of LEXICON) {
    if (!e.w || !s.includes(e.w)) continue;
    if (hits.some((h) => h.w.includes(e.w))) continue;
    hits.push(e);
  }
  return hits;
}

/** H2.10：防御/省略/软拒话术；用户明确「别想多了」时上层应跳过 */
function matchMetaphor(text) {
  const s = String(text || "");
  if (!s) return [];
  const hits = [];
  for (const e of METAPHOR) {
    if (!e.w || !s.includes(e.w)) continue;
    if (hits.some((h) => h.w.includes(e.w))) continue;
    hits.push(Object.assign({}, e, { metaphor: true }));
  }
  return hits;
}

const EXTRA_PATH = path.join(__dirname, "..", "data", "cvaw-extra.json");
const BUILTIN_N = LEXICON.length;

function readExtraFile() {
  try {
    if (!fs.existsSync(EXTRA_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(EXTRA_PATH, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function normalizeExtraRow(row) {
  const w = String((row && (row[0] || row.w)) || "").trim().slice(0, 24);
  if (!w) return null;
  const v = Number(row[1] != null ? row[1] : row.v != null ? row.v : row.valence);
  const a = Number(row[2] != null ? row[2] : row.a != null ? row.a : row.arousal);
  const imp = Number(
    row[3] != null ? row[3] : row.i != null ? row.i : row.importance
  );
  if (!Number.isFinite(v) || !Number.isFinite(a)) return null;
  return {
    w,
    v: Math.max(-1, Math.min(1, v)),
    a: Math.max(0, Math.min(1, a)),
    i: Math.max(1, Math.min(10, Math.round(Number.isFinite(imp) ? imp : 4))),
  };
}

function rebuildLexiconFromExtra() {
  const base = buildLexicon(RAW);
  LEXICON.length = 0;
  for (const e of base) LEXICON.push(e);
  const seen = new Set(LEXICON.map((e) => e.w));
  for (const row of readExtraFile()) {
    const e = normalizeExtraRow(row);
    if (!e || seen.has(e.w)) continue;
    LEXICON.push(e);
    seen.add(e.w);
  }
  LEXICON.sort((a, b) => b.w.length - a.w.length || a.w.localeCompare(b.w, "zh"));
}

(function loadCvawExtra() {
  rebuildLexiconFromExtra();
})();

function listLexiconPublic() {
  const extra = readExtraFile()
    .map(normalizeExtraRow)
    .filter(Boolean);
  return {
    ok: true,
    builtin: BUILTIN_N,
    total: LEXICON.length,
    extra,
  };
}

function saveLexiconExtra(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const e = normalizeExtraRow(row);
    if (!e || seen.has(e.w)) continue;
    seen.add(e.w);
    out.push([e.w, e.v, e.a, e.i]);
    if (out.length >= 200) break;
  }
  const dir = path.dirname(EXTRA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EXTRA_PATH, JSON.stringify(out, null, 2), "utf8");
  rebuildLexiconFromExtra();
  return listLexiconPublic();
}

function addLexiconExtra(row) {
  const e = normalizeExtraRow(row);
  if (!e) {
    const err = new Error("词条无效");
    err.code = "bad_lexicon";
    throw err;
  }
  const cur = readExtraFile()
    .map(normalizeExtraRow)
    .filter(Boolean)
    .filter((x) => x.w !== e.w);
  cur.push(e);
  return saveLexiconExtra(cur);
}

function removeLexiconExtra(word) {
  const w = String(word || "").trim();
  const cur = readExtraFile()
    .map(normalizeExtraRow)
    .filter(Boolean)
    .filter((x) => x.w !== w);
  return saveLexiconExtra(cur);
}

(function selfCheck() {
  if (LEXICON.length < 80) throw new Error("lexicon size");
  const h = matchLexicon("分手吧 我很难过");
  if (!h.some((x) => x.w === "分手吧")) throw new Error("lexicon long");
  if (h.some((x) => x.w === "分手")) throw new Error("lexicon subsume");
  if (!h.some((x) => x.w === "很难过")) throw new Error("lexicon mid");
  const m = matchMetaphor("没事，随便吧");
  if (!m.some((x) => x.w === "没事" || x.w === "随便")) {
    throw new Error("metaphor hit");
  }
  const m2 = matchMetaphor("我一点也不难过");
  if (!m2.some((x) => x.w === "我一点也不难过")) throw new Error("metaphor long");
})();

module.exports = {
  LEXICON,
  METAPHOR,
  matchLexicon,
  matchMetaphor,
  listLexiconPublic,
  saveLexiconExtra,
  addLexiconExtra,
  removeLexiconExtra,
  rebuildLexiconFromExtra,
  get LEXICON_SIZE() {
    return LEXICON.length;
  },
  METAPHOR_SIZE: METAPHOR.length,
  BUILTIN_N,
};
