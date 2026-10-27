/**
 * M5 视频通话仪式礼物：五档、无支付；标签 [[gift:1]]～[[gift:5]] 或英文 id。
 */
const GIFTS = [
  { tier: 1, id: "heart", name: "小心心", emoji: "💗" },
  { tier: 2, id: "bouquet", name: "花束", emoji: "💐" },
  { tier: 3, id: "fireworks", name: "夏日烟火", emoji: "🎆" },
  { tier: 4, id: "meteor", name: "流星雨", emoji: "🌠" },
  { tier: 5, id: "galaxy", name: "银河铁道之夜", emoji: "🌌" },
];

const BY_ID = new Map(GIFTS.map((g) => [g.id, g]));
const BY_NAME = new Map(GIFTS.map((g) => [g.name, g]));

/** `[[gift:3]]` / `[[gift:heart]]` / `[[gift:小心心]]` */
const GIFT_TAG_RE = /\[\[\s*gift\s*:\s*([^\]]+?)\s*\]\]/gi;

function giftByTier(tier) {
  const n = Math.floor(Number(tier));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return GIFTS[n - 1];
}

function resolveGiftToken(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (/^[1-5]$/.test(s)) return giftByTier(s);
  const byId = BY_ID.get(s);
  if (byId) return byId;
  const name = String(raw || "").trim();
  return BY_NAME.get(name) || null;
}

/**
 * 剥礼物标签；每条最多保留一枚（最后一个）。
 * @returns {{ text: string, gift: null|{ tier:number, id:string, name:string, emoji:string } }}
 */
function extractGiftTag(text) {
  let gift = null;
  const cleaned = String(text || "")
    .replace(GIFT_TAG_RE, (_, tok) => {
      const g = resolveGiftToken(tok);
      if (g) gift = g;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, gift };
}

function listGifts() {
  return GIFTS.map((g) => ({ ...g }));
}

module.exports = {
  GIFTS,
  giftByTier,
  resolveGiftToken,
  extractGiftTag,
  listGifts,
};

if (require.main === module) {
  console.assert(extractGiftTag("嗨 [[gift:1]]").gift.tier === 1);
  console.assert(extractGiftTag("嗨 [[gift:1]]").text === "嗨");
  console.assert(extractGiftTag("x [[gift:galaxy]]").gift.id === "galaxy");
  console.assert(extractGiftTag("[[gift:花束]]").gift.tier === 2);
  console.assert(giftByTier(5).name === "银河铁道之夜");
  console.assert(!giftByTier(0) && !giftByTier(6));
  console.log("call-gifts selfcheck ok");
}
