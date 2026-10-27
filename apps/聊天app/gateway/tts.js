/**
 * H3.1 TTS：优先 Fish Audio；未配置时抛 tts_not_configured，前端回退浏览器朗读。
 * API：https://api.fish.audio/v1/tts （明天填 fish_api_key + fish_voice_id 即可）
 */
const { readSettings } = require("../../共读app/gateway/settings");

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const TEXT_MAX = 500;

function fishConfigured(s) {
  const set = s || readSettings();
  return !!(String(set.fish_api_key || "").trim() && String(set.fish_voice_id || "").trim());
}

function ttsStatus() {
  const s = readSettings();
  return {
    ok: true,
    fish: fishConfigured(s) ? "configured" : "missing",
    model: String(s.fish_tts_model || "s2.1-pro-free").trim() || "s2.1-pro-free",
    voice_set: !!String(s.fish_voice_id || "").trim(),
  };
}

/** Fish / 浏览器共用的语言码：zh|en|ja|ko → API 串 */
function normalizeTtsLang(raw) {
  const s = String(raw || "zh")
    .trim()
    .toLowerCase();
  if (s.startsWith("en")) return "en";
  if (s.startsWith("ja") || s.startsWith("jp")) return "ja";
  if (s.startsWith("ko") || s.startsWith("kr")) return "ko";
  return "zh";
}

function fishLanguageTag(lang) {
  const l = normalizeTtsLang(lang);
  if (l === "en") return "en";
  if (l === "ja") return "ja";
  if (l === "ko") return "ko";
  return "zh";
}

/**
 * @param {string} text
 * @param {{ language?: string }} [opts]
 * @returns {Promise<{ buf: Buffer, contentType: string, provider: "fish" }>}
 */
async function synthesizeSpeech(text, opts) {
  const raw = String(text || "").trim().slice(0, TEXT_MAX);
  if (!raw) {
    const err = new Error("没有可朗读的文字");
    err.code = "tts_empty";
    throw err;
  }
  const s = readSettings();
  const key = String(s.fish_api_key || "").trim();
  const voice = String(s.fish_voice_id || "").trim();
  if (!key || !voice) {
    const err = new Error("未配置 Fish Audio Key / Voice ID");
    err.code = "tts_not_configured";
    throw err;
  }
  const model = String(s.fish_tts_model || "s2.1-pro-free").trim() || "s2.1-pro-free";
  const language = fishLanguageTag(opts && opts.language);
  const res = await fetch(FISH_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      model,
    },
    body: JSON.stringify({
      text: raw,
      reference_id: voice,
      format: "mp3",
      latency: "balanced",
      normalize: true,
      language,
    }),
  });
  if (!res.ok) {
    let msg = "Fish TTS 失败 " + res.status;
    try {
      const j = await res.json();
      if (j && j.message) msg = String(j.message);
    } catch (_) {
      try {
        msg = (await res.text()).slice(0, 160) || msg;
      } catch (_) {}
    }
    const err = new Error(msg);
    err.code = "tts_fish_failed";
    throw err;
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) {
    const err = new Error("Fish TTS 返回空音频");
    err.code = "tts_empty_audio";
    throw err;
  }
  return { buf, contentType: "audio/mpeg", provider: "fish" };
}

module.exports = {
  synthesizeSpeech,
  fishConfigured,
  ttsStatus,
  normalizeTtsLang,
  fishLanguageTag,
  FISH_TTS_URL,
  TEXT_MAX,
};

if (require.main === module) {
  console.assert(ttsStatus().ok);
  console.assert(normalizeTtsLang("en-US") === "en");
  console.assert(normalizeTtsLang("ja-JP") === "ja");
  console.assert(fishLanguageTag("zh-CN") === "zh");
  synthesizeSpeech("hi")
    .then(() => {
      throw new Error("expected fail without key");
    })
    .catch((e) => {
      console.assert(e.code === "tts_not_configured", e.code);
      console.log("tts selfcheck ok", ttsStatus());
    });
}
