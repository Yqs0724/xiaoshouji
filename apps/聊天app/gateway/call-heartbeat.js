/**
 * M4 通话心跳：双方安静超过间隔后，TA 主动说一句（不伪造用户发言）。
 * 连续未等到用户开口达上限则前端停表；本模块只生成一轮。
 */
const { chatCompletion } = require("../../共读app/gateway/llm");
const { synthesizeSpeech, fishConfigured } = require("./tts");
const { readSettings } = require("../../共读app/gateway/settings");

const STREAK_MAX = 10;

function clampHeartbeatSec(n) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return 45;
  return Math.max(30, Math.min(120, x));
}

/**
 * @param {{ streak?: number }} [opts]
 * @returns {Promise<{
 *   ok: true,
 *   bot_text: string,
 *   message?: object,
 *   provider: string,
 *   stopped?: boolean,
 *   streak: number,
 *   used?: number,
 *   audio_base64?: string,
 *   content_type?: string,
 *   tts_error?: string
 * }>}
 */
async function runCallHeartbeat(opts) {
  const streak = Math.max(0, Math.floor(Number(opts && opts.streak) || 0));
  if (streak >= STREAK_MAX) {
    return {
      ok: true,
      stopped: true,
      streak,
      bot_text: "",
      provider: "none",
    };
  }
  const settings = readSettings();
  if (!settings.call_heartbeat_enabled) {
    return {
      ok: true,
      stopped: true,
      streak,
      bot_text: "",
      provider: "none",
    };
  }
  const nameBot = String(settings.name_bot || "家机").trim() || "家机";
  let memPrompt = "";
  try {
    const { buildMemoryPrompt } = require("./memory");
    const { currentPeerId } = require("./daily-chat");
    memPrompt = (await buildMemoryPrompt(currentPeerId(), "")) || "";
  } catch (_) {}
  const isVideo = !!(opts && opts.video);
  let system =
    "你是" +
    nameBot +
    "，正在和用户" +
    (isVideo ? "视频" : "语音") +
    "通话。对方沉默了一会儿，你主动接一句短话（一两句口语、自然）。" +
    "不要列表、不要 markdown、不要提「心跳」「系统」「超时」。\n" +
    (memPrompt ? memPrompt + "\n" : "");
  if (settings.call_gift_enabled && isVideo) {
    system +=
      "\n偶尔可在末尾写 [[gift:1]]～[[gift:5]] 送仪式礼物（无支付），每条最多一枚。";
  }
  const raw = await chatCompletion({
    system,
    user: "（对方还没说话，你先开口）",
    think: false,
    replyKind: "chat",
  });
  let botText = String((raw && raw.content) || "").trim().slice(0, 280);
  if (!botText) {
    const err = new Error("心跳没接上");
    err.code = "llm_empty";
    throw err;
  }
  let gift = null;
  if (settings.call_gift_enabled && isVideo) {
    try {
      const { extractGiftTag } = require("./call-gifts");
      const parsed = extractGiftTag(botText);
      botText = parsed.text || botText;
      gift = parsed.gift;
    } catch (_) {}
  }
  const tokens =
    (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0) || 200;

  let message = null;
  try {
    const { appendMessage } = require("./daily-chat");
    const payload = { source: "call_heartbeat" };
    if (gift) payload.gift = { tier: gift.tier, id: gift.id, name: gift.name };
    message = appendMessage("bot", botText, "text", { payload });
  } catch (_) {}

  const nextStreak = streak + 1;
  const base = {
    ok: true,
    bot_text: botText,
    message,
    streak: nextStreak,
    used: tokens,
    gift: gift || undefined,
  };
  if (!fishConfigured()) {
    return Object.assign(base, { provider: "browser" });
  }
  try {
    const audio = await synthesizeSpeech(botText);
    return Object.assign(base, {
      provider: "fish",
      content_type: audio.contentType,
      audio_base64: audio.buf.toString("base64"),
    });
  } catch (e) {
    return Object.assign(base, {
      provider: "browser",
      tts_error: e.message || String(e),
    });
  }
}

module.exports = {
  runCallHeartbeat,
  clampHeartbeatSec,
  STREAK_MAX,
};

if (require.main === module) {
  console.assert(clampHeartbeatSec(10) === 30);
  console.assert(clampHeartbeatSec(200) === 120);
  console.assert(clampHeartbeatSec(45) === 45);
  console.assert(STREAK_MAX === 10);
  console.log("call-heartbeat selfcheck ok");
}
