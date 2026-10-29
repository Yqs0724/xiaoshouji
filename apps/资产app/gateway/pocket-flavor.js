/**
 * 零花账单演示文案：按人设调 LLM 生成，禁止穷鬼模板硬套有钱人设。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_PATH = path.join(__dirname, "..", "data", "pocket-flavor.json");

function emptyStore() {
  return {
    version: 1,
    persona_hash: "",
    bot_name: "",
    user_name: "",
    bot: null,
    you: null,
    generated_at: 0,
  };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    return Object.assign(emptyStore(), raw);
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
}

function personaHash(persona, botName, userName) {
  return crypto
    .createHash("sha1")
    .update(String(persona || "") + "\0" + botName + "\0" + userName)
    .digest("hex")
    .slice(0, 16);
}

function looksRich(persona) {
  return /富豪|亿万|财阀|豪门|信托|家族办公室|高净值|首富|资本|总裁|董事长|豪车|别墅|多套房|房产|有钱|富二代|私企老板|继承.{0,20}遗产|私人飞机|游艇/.test(
    String(persona || "")
  );
}

function sanitizeSide(raw, whoLabel) {
  const o = raw && typeof raw === "object" ? raw : {};
  const macro = Array.isArray(o.macro) ? o.macro : [];
  const micro = Array.isArray(o.micro) ? o.micro : [];
  const mapMacro = (x) => {
    if (!x || typeof x !== "object") return null;
    const amt = Number(x.amt);
    if (!Number.isFinite(amt) || amt === 0) return null;
    return {
      amt: Math.round(amt * 100) / 100,
      title: String(x.title || "").trim().slice(0, 40) || "流水",
      desc: String(x.desc || "").trim().slice(0, 40) || "—",
      note: String(x.note || "—").trim().slice(0, 60) || "—",
      dir: amt >= 0 ? "in" : "out",
    };
  };
  const mapMicro = (x) => {
    if (!x || typeof x !== "object") return null;
    const amt = Number(x.amt);
    if (!Number.isFinite(amt) || amt === 0) return null;
    return {
      t: String(x.t || "12:00").trim().slice(0, 8) || "12:00",
      amt: Math.round(amt * 100) / 100,
      title: String(x.title || "").trim().slice(0, 40) || "花销",
      desc: String(x.desc || "").trim().slice(0, 40) || "—",
    };
  };
  const bal = Number(o.pocket_balance);
  return {
    macro: macro.map(mapMacro).filter(Boolean).slice(0, 8),
    micro: micro.map(mapMicro).filter(Boolean).slice(0, 8),
    hint: String(o.hint || whoLabel + "零花").trim().slice(0, 80),
    pocket_balance: Number.isFinite(bal) && bal > 0 ? Math.round(bal) : null,
  };
}

function parseJsonLoose(text) {
  const s = String(text || "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

async function callLlmFlavor({ persona, botName, userName }) {
  const { chatCompletion, parseThinkBody } = require("../../共读app/gateway/llm");
  const rich = looksRich(persona);
  const system =
    "你是家用小手机的财务文案助手。只输出一个 JSON 对象，不要 markdown。" +
    "字段：bot{macro[],micro[],hint,pocket_balance}, you{macro[],micro[],hint,pocket_balance}。" +
    "macro 项：amt(正入账负支出数字), title, desc, note；micro 项：t(HH:MM), amt, title, desc。" +
    "bot 是「" +
    botName +
    "」的零花演示账单，you 是「" +
    userName +
    "」的。" +
    "必须贴合人设身份与财力；note 署名语气用角色口吻，不要写「家机」。" +
    (rich
      ? "人设偏有钱：禁止房租/廉租/月薪一万出头；收入用分红/奖金/投资回款等，支出用物业/车队保养/私宴等合理项；pocket_balance 建议数万～数十万量级。"
      : "按人设真实消费水平写，勿夸张成财阀。");
  const user =
    "人设摘要（遵守，勿整段复述）：\n" +
    String(persona || "").trim().slice(0, 3500) +
    "\n请各生成 4～6 条 macro、4～6 条 micro。";
  const out = await chatCompletion({
    system,
    user,
    think: false,
    replyKind: "chat",
  });
  const parsed = parseThinkBody((out && out.content) || "", false);
  const body = String((parsed && parsed.body) || (out && out.content) || "");
  const j = parseJsonLoose(body);
  if (!j) {
    const err = new Error("模型未返回可用账单 JSON");
    err.code = "flavor_parse";
    throw err;
  }
  return {
    bot: sanitizeSide(j.bot, botName),
    you: sanitizeSide(j.you, userName),
  };
}

async function ensurePocketFlavor(opts) {
  const force = !!(opts && opts.force);
  const { readSettings } = require("../../共读app/gateway/settings");
  const s = readSettings();
  const persona = String((s && s.persona_card) || "").trim();
  const botName = String((s && s.name_bot) || "沈言之").trim() || "沈言之";
  const userName = String((s && s.name_user) || "你").trim() || "你";
  const hash = personaHash(persona, botName, userName);
  const store = readStore();
  if (
    !force &&
    store.persona_hash === hash &&
    store.bot &&
    store.bot.macro &&
    store.bot.macro.length &&
    store.you &&
    store.you.macro &&
    store.you.macro.length
  ) {
    return { ok: true, cached: true, ...store, bot_name: botName, user_name: userName };
  }
  if (!persona) {
    const err = new Error("请先在设定写入人设，再生成零花账单");
    err.code = "no_persona";
    throw err;
  }
  const gen = await callLlmFlavor({ persona, botName, userName });
  if (!gen.bot.macro.length || !gen.you.macro.length) {
    const err = new Error("生成结果太空，请重试");
    err.code = "flavor_empty";
    throw err;
  }
  const next = {
    version: 1,
    persona_hash: hash,
    bot_name: botName,
    user_name: userName,
    bot: gen.bot,
    you: gen.you,
    generated_at: Date.now(),
  };
  writeStore(next);
  /* 顺手把聊天零花余额拉到人设量级（演示种子，可再手调） */
  try {
    const { readWallet, writeWallet } = require("./wallet");
    const w = readWallet();
    let changed = false;
    if (gen.you.pocket_balance != null) {
      w.you_balance = gen.you.pocket_balance;
      changed = true;
    }
    if (gen.bot.pocket_balance != null) {
      w.bot_balance = gen.bot.pocket_balance;
      changed = true;
    }
    if (changed) writeWallet(w);
  } catch (_) {}
  return { ok: true, cached: false, ...next };
}

function getPocketFlavor() {
  const store = readStore();
  const { readSettings } = require("../../共读app/gateway/settings");
  const s = readSettings();
  return {
    ok: true,
    ...store,
    bot_name: String((s && s.name_bot) || store.bot_name || "沈言之").trim(),
    user_name: String((s && s.name_user) || store.user_name || "你").trim(),
    has_data: !!(store.bot && store.bot.macro && store.bot.macro.length),
  };
}

if (require.main === module) {
  const rich = looksRich("总裁 多套房 豪车 继承遗产");
  console.assert(rich, "rich detect");
  const side = sanitizeSide(
    {
      macro: [{ amt: -100, title: "物业", desc: "月缴", note: "例" }],
      micro: [{ t: "10:00", amt: -20, title: "咖啡", desc: "微信" }],
      hint: "hi",
      pocket_balance: 88000,
    },
    "测"
  );
  console.assert(side.macro[0].dir === "out" && side.pocket_balance === 88000);
  console.log("pocket-flavor self-check ok");
}

module.exports = {
  ensurePocketFlavor,
  getPocketFlavor,
  looksRich,
  sanitizeSide,
};
