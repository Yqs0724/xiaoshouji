/**
 * H3.1 通话语音回合：音频 → ASR → 心情观察 → 短接话 → TTS（Fish 或交前端浏览器）。
 */
const { transcribeAudio, chatCompletion } = require("../../共读app/gateway/llm");
const { observeUserText, decideReplyGate, buildMoodPrompt } = require("./mood");
const { synthesizeSpeech, fishConfigured } = require("./tts");
const { readSettings } = require("../../共读app/gateway/settings");

/**
 * @param {{ buf: Buffer, contentType?: string, filename?: string, video?: boolean }} input
 */
async function runVoiceTurn(input) {
  const buf = input && input.buf;
  if (!buf || !Buffer.isBuffer(buf) || !buf.length) {
    const err = new Error("没有录音");
    err.code = "voice_empty";
    throw err;
  }
  const asr = await transcribeAudio({
    buf,
    contentType: input.contentType || "audio/webm",
    filename: input.filename || "call.webm",
  });
  const userText = String((asr && asr.text) || "").trim();
  if (!userText) {
    const err = new Error("没听清，再说一次？");
    err.code = "asr_empty";
    throw err;
  }

  observeUserText(userText);
  try {
    const {
      peerBlocksYou,
      maybeSoftUnblockFromText,
    } = require("./daily-chat");
    if (peerBlocksYou()) {
      if (!maybeSoftUnblockFromText(userText)) {
        return {
          ok: true,
          user_text: userText,
          bot_text: "",
          skipped: true,
          skip_reason: "blocks_you",
          provider: "none",
        };
      }
    }
  } catch (_) {}
  const gate = decideReplyGate({ slowReply: false, coalesced: true });
  if (gate.skip) {
    return {
      ok: true,
      user_text: userText,
      bot_text: "",
      skipped: true,
      skip_reason: "mood_cold",
      provider: "none",
    };
  }

  const settings = readSettings();
  const nameBot = String(settings.name_bot || "家机").trim() || "家机";
  const isVideo = !!(input && input.video);
  let memPrompt = "";
  try {
    const { buildMemoryPrompt } = require("./memory");
    const { currentPeerId } = require("./daily-chat");
    memPrompt = (await buildMemoryPrompt(currentPeerId(), userText)) || "";
  } catch (_) {}
  let system =
    "你是" +
    nameBot +
    "，正在和用户" +
    (isVideo ? "视频" : "语音") +
    "通话。回复要短（一两句）、口语、自然。" +
    "不要列表、不要markdown。\n" +
    (gate.moodPrompt || buildMoodPrompt(gate.mood) || "") +
    (memPrompt ? "\n" + memPrompt : "");
  if (settings.call_gift_enabled && isVideo) {
    system +=
      "\n视频通话仪式礼物（无支付）：想送时可在回复末尾写 [[gift:1]]～[[gift:5]]" +
      "（1小心心 2花束 3夏日烟火 4流星雨 5银河铁道之夜），每条最多一枚。";
  }

  const raw = await chatCompletion({
    system,
    user: userText,
    think: false,
    replyKind: "chat",
  });
  let botText = String((raw && raw.content) || "").trim().slice(0, 280);
  if (!botText) {
    const err = new Error("家机没接上话");
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
    (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0) || 300;

  const base = {
    ok: true,
    user_text: userText,
    bot_text: botText,
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

module.exports = { runVoiceTurn };
