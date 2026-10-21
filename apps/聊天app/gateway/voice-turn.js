/**
 * H3.1 通话语音回合：音频 → ASR → 心情观察 → 短接话 → TTS（Fish 或交前端浏览器）。
 */
const { transcribeAudio, chatCompletion } = require("../../共读app/gateway/llm");
const { observeUserText, decideReplyGate, buildMoodPrompt } = require("./mood");
const { synthesizeSpeech, fishConfigured } = require("./tts");
const { readSettings } = require("../../共读app/gateway/settings");

/**
 * @param {{ buf: Buffer, contentType?: string, filename?: string }} input
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
  let memPrompt = "";
  try {
    const { buildMemoryPrompt } = require("./memory");
    const { currentPeerId } = require("./daily-chat");
    memPrompt = (await buildMemoryPrompt(currentPeerId(), userText)) || "";
  } catch (_) {}
  const system =
    "你是" +
    nameBot +
    "，正在和用户语音通话。回复要短（一两句）、口语、自然。" +
    "不要列表、不要markdown。\n" +
    (gate.moodPrompt || buildMoodPrompt(gate.mood) || "") +
    (memPrompt ? "\n" + memPrompt : "");

  const raw = await chatCompletion({
    system,
    user: userText,
    think: false,
    replyKind: "chat",
  });
  const botText = String((raw && raw.content) || "").trim().slice(0, 280);
  if (!botText) {
    const err = new Error("家机没接上话");
    err.code = "llm_empty";
    throw err;
  }

  const tokens =
    (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0) || 300;

  if (!fishConfigured()) {
    return {
      ok: true,
      user_text: userText,
      bot_text: botText,
      provider: "browser",
      used: tokens,
    };
  }

  try {
    const audio = await synthesizeSpeech(botText);
    return {
      ok: true,
      user_text: userText,
      bot_text: botText,
      provider: "fish",
      content_type: audio.contentType,
      audio_base64: audio.buf.toString("base64"),
      used: tokens,
    };
  } catch (e) {
    return {
      ok: true,
      user_text: userText,
      bot_text: botText,
      provider: "browser",
      tts_error: e.message || String(e),
      used: tokens,
    };
  }
}

module.exports = { runVoiceTurn };
