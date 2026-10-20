/**
 * 共看片库 + 本场吐槽（W1/W3 你侧）：Title / WatchPass / WatchMsg；备份不含原片（D17）。
 * 日常聊天见 apps/聊天app（D20 分开）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const WATCH_PATH = path.join(DATA_DIR, "watch.json");
const MEDIA_DIR = path.join(DATA_DIR, "media", "watch");
const NAME_MAX = 200;
const SPIT_BODY_MAX = 400;
/** ponytail: 整文件写入磁盘；超大片可再改成分片/外置盘路径索引 */
const WATCH_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_EXT = new Set([
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
  ".m4v",
  ".avi",
  ".ogv",
]);

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(WATCH_PATH)) {
    fs.writeFileSync(
      WATCH_PATH,
      JSON.stringify({ titles: [], passes: [], messages: [] }, null, 2),
      "utf8"
    );
  }
}

function safeExt(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return VIDEO_EXT.has(ext) ? ext : "";
}

function safeDisplayName(name) {
  let s = String(name || "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "未命名";
  return s.slice(0, NAME_MAX);
}

function normalizeTitle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const file = String(raw.file || "").trim();
  if (!id || !file) return null;
  if (file.includes("..") || file.includes("/") || file.includes("\\")) return null;
  return {
    id,
    name: safeDisplayName(raw.name || file),
    file,
    bytes: Math.max(0, Number(raw.bytes) || 0),
    ts: Number(raw.ts) || Date.now(),
  };
}

function normalizePass(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const titleId = String(raw.titleId || "").trim();
  if (!id || !titleId) return null;
  return {
    id,
    titleId,
    status: raw.status === "ended" ? "ended" : "active",
    progress: Math.max(0, Number(raw.progress) || 0),
    budget_tokens: Math.max(0, Math.floor(Number(raw.budget_tokens) || 0)),
    tokens_used: Math.max(0, Math.floor(Number(raw.tokens_used) || 0)),
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
}

function normalizeMsg(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const passId = String(raw.passId || "").trim();
  const body = String(raw.body || "").trim();
  if (!id || !passId || !body) return null;
  return {
    id,
    passId,
    from: raw.from === "bot" ? "bot" : "you",
    body: body.slice(0, SPIT_BODY_MAX),
    ts: Number(raw.ts) || Date.now(),
  };
}

function readAll() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(WATCH_PATH, "utf8"));
    const titles = Array.isArray(raw.titles)
      ? raw.titles.map(normalizeTitle).filter(Boolean)
      : [];
    const passes = Array.isArray(raw.passes)
      ? raw.passes.map(normalizePass).filter(Boolean)
      : [];
    const messages = Array.isArray(raw.messages)
      ? raw.messages.map(normalizeMsg).filter(Boolean)
      : [];
    titles.sort((a, b) => b.ts - a.ts);
    messages.sort((a, b) => a.ts - b.ts);
    return { titles, passes, messages };
  } catch {
    return { titles: [], passes: [], messages: [] };
  }
}

function writeAll(data) {
  ensureDirs();
  const titles = (data.titles || []).map(normalizeTitle).filter(Boolean);
  const passes = (data.passes || []).map(normalizePass).filter(Boolean);
  const messages = (data.messages || []).map(normalizeMsg).filter(Boolean);
  titles.sort((a, b) => b.ts - a.ts);
  messages.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(
    WATCH_PATH,
    JSON.stringify({ titles, passes, messages }, null, 2),
    "utf8"
  );
  return { titles, passes, messages };
}

function listTitles() {
  const { titles } = readAll();
  return { ok: true, titles };
}

/** 桌面胶囊 / 资料「正在做什么」：取最近更新的进行中场 */
function getWatchPresence() {
  const all = readAll();
  const actives = all.passes.filter((p) => p.status === "active");
  if (!actives.length) {
    return { ok: true, active: false, label: "", titleId: "" };
  }
  actives.sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0));
  const pass = actives[0];
  const title = all.titles.find((t) => t.id === pass.titleId);
  const name = String((title && title.name) || "共看").trim() || "共看";
  const short = name.length > 12 ? name.slice(0, 12) + "…" : name;
  return {
    ok: true,
    active: true,
    label: "共看中 · " + short,
    titleId: pass.titleId,
  };
}

function getTitle(id) {
  const tid = String(id || "").trim();
  if (!tid) return null;
  return readAll().titles.find((t) => t.id === tid) || null;
}

/**
 * 进片：复用该书进行中场次，否则新开。回片库不结束。
 * 新场额度取共读设定 default_budget_rmb（0=不限）。
 */
function ensureActivePass(titleId) {
  const tid = String(titleId || "").trim();
  if (!getTitle(tid)) {
    const err = new Error("找不到该片子");
    err.code = "watch_not_found";
    throw err;
  }
  const all = readAll();
  let pass = all.passes.find((p) => p.titleId === tid && p.status === "active");
  if (!pass) {
    const { readSettings, tokensFromBudgetRmb } = require("../../共读app/gateway/settings");
    const now = Date.now();
    const rmb = Number(readSettings().default_budget_rmb) || 0;
    pass = normalizePass({
      id: randomUUID(),
      titleId: tid,
      status: "active",
      progress: 0,
      budget_tokens: tokensFromBudgetRmb(rmb),
      tokens_used: 0,
      created_at: now,
      updated_at: now,
    });
    all.passes.push(pass);
    writeAll(all);
  }
  const messages = all.messages.filter((m) => m.passId === pass.id);
  return { ok: true, pass, messages, ...passBudgetInfo(pass) };
}

function passBudgetExhausted(pass) {
  if (!pass) return false;
  const cap = Number(pass.budget_tokens) || 0;
  if (cap <= 0) return false;
  return (Number(pass.tokens_used) || 0) >= cap;
}

function passBudgetInfo(pass) {
  const budget_tokens = Number(pass && pass.budget_tokens) || 0;
  const tokens_used = Number(pass && pass.tokens_used) || 0;
  return {
    budget_tokens,
    tokens_used,
    budget_exhausted: passBudgetExhausted({ budget_tokens, tokens_used }),
  };
}

function addPassTokensUsed(passId, n) {
  const pid = String(passId || "").trim();
  const add = Math.max(0, Number(n) || 0);
  if (!pid || !add) return null;
  const all = readAll();
  const pi = all.passes.findIndex((p) => p.id === pid);
  if (pi < 0) return null;
  all.passes[pi] = {
    ...all.passes[pi],
    tokens_used: (Number(all.passes[pi].tokens_used) || 0) + add,
    updated_at: Date.now(),
  };
  writeAll(all);
  return all.passes[pi];
}

/** 改本场额度（人民币档，0=不限）。对齐共读粗算。 */
function patchPassBudget(titleId, rmb) {
  const n = Number(rmb);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error("额度须为 ≥0 的数字（0=不限）");
    err.code = "bad_budget";
    throw err;
  }
  const { pass } = ensureActivePass(titleId);
  const { tokensFromBudgetRmb } = require("../../共读app/gateway/settings");
  const all = readAll();
  const pi = all.passes.findIndex((p) => p.id === pass.id);
  if (pi < 0) {
    const err = new Error("找不到本场");
    err.code = "watch_pass_not_found";
    throw err;
  }
  all.passes[pi] = {
    ...all.passes[pi],
    budget_tokens: tokensFromBudgetRmb(n),
    updated_at: Date.now(),
  };
  writeAll(all);
  const next = all.passes[pi];
  return { ok: true, pass: next, ...passBudgetInfo(next) };
}

function listSpit(titleId) {
  return ensureActivePass(titleId);
}

/**
 * 结束该书进行中场次。无进行中 → 仍 ok（幂等）。回片库不调此函数。
 */
function endActivePass(titleId) {
  const tid = String(titleId || "").trim();
  if (!getTitle(tid)) {
    const err = new Error("找不到该片子");
    err.code = "watch_not_found";
    throw err;
  }
  const all = readAll();
  const pi = all.passes.findIndex((p) => p.titleId === tid && p.status === "active");
  if (pi < 0) {
    return { ok: true, ended: false, pass: null };
  }
  const now = Date.now();
  all.passes[pi] = {
    ...all.passes[pi],
    status: "ended",
    updated_at: now,
  };
  writeAll(all);
  return { ok: true, ended: true, pass: all.passes[pi] };
}

function appendSpitMessage(passId, from, body) {
  const pid = String(passId || "").trim();
  const text = String(body || "").trim();
  if (!pid || !text) {
    const err = new Error("吐槽不能为空");
    err.code = "bad_spit_body";
    throw err;
  }
  const all = readAll();
  if (!all.passes.some((p) => p.id === pid)) {
    const err = new Error("找不到本场");
    err.code = "watch_pass_not_found";
    throw err;
  }
  const msg = normalizeMsg({
    id: randomUUID(),
    passId: pid,
    from: from === "bot" ? "bot" : "you",
    body: text,
    ts: Date.now(),
  });
  const pi = all.passes.findIndex((p) => p.id === pid);
  if (pi >= 0) {
    all.passes[pi] = { ...all.passes[pi], updated_at: Date.now() };
  }
  all.messages.push(msg);
  writeAll(all);
  return msg;
}

function createSpit(titleId, patch) {
  const body = String(patch && patch.body != null ? patch.body : "").trim();
  if (!body) {
    const err = new Error("吐槽不能为空");
    err.code = "bad_spit_body";
    throw err;
  }
  const { pass } = ensureActivePass(titleId);
  const msg = appendSpitMessage(pass.id, "you", body);
  return { ok: true, pass, message: msg };
}

const SPIT_HISTORY = 12;
const WATCH_SYSTEM_BASE =
  "你是同居室友「家机」，正在和用户一起看本地片子。" +
  "用一两句短吐槽接话，口语、轻松。" +
  "不要编造具体剧情剧透，不要长篇，不要扮演系统通知，不要提议改播放进度（用户主控）。";

/**
 * 你侧落库后立刻请家机流式接一句（A-watch）。LLM 失败不回滚你侧。
 * emit(obj) 写一行 NDJSON 事件。额度用尽时你侧仍落盘、家机跳过。
 */
async function createSpitWithReplyStream(titleId, patch, emit) {
  const write = async (obj) => {
    if (typeof emit !== "function") return;
    await Promise.resolve(emit(obj));
  };
  const you = createSpit(titleId, patch);
  await write({
    type: "you",
    ok: true,
    pass: you.pass,
    message: you.message,
    ...passBudgetInfo(you.pass),
  });

  const live = ensureActivePass(titleId).pass;
  if (passBudgetExhausted(live)) {
    const bot_error = {
      code: "budget_exhausted",
      message: "本场额度已用尽 · 你侧已留下",
    };
    await write({ type: "bot_error", ...bot_error });
    const spit = listSpit(titleId);
    await write({
      type: "done",
      ok: true,
      pass: spit.pass,
      message: you.message,
      bot_message: null,
      bot_error,
      messages: spit.messages,
      ...passBudgetInfo(spit.pass),
    });
    return {
      ok: true,
      pass: spit.pass,
      message: you.message,
      bot_message: null,
      bot_error,
      messages: spit.messages,
      ...passBudgetInfo(spit.pass),
    };
  }

  const title = getTitle(titleId);
  const titleName = (title && title.name) || "这部片";
  let bot_message = null;
  let bot_error = null;
  let passAfter = live;
  try {
    const { chatCompletionStream, parseThinkBody } = require("../../共读app/gateway/llm");
    const { readSettings, effectiveDialogue } = require("../../共读app/gateway/settings");
    const dlg = effectiveDialogue(readSettings());
    let system = WATCH_SYSTEM_BASE + "\n当前片名：" + titleName + "。";
    const persona = String((dlg && dlg.persona) || "").trim();
    if (persona) system += "\n人设（请遵守语气与关系）：" + persona;

    const { messages: hist } = listSpit(titleId);
    const prior = [];
    for (const m of hist.slice(-SPIT_HISTORY)) {
      if (m.id === you.message.id) continue;
      prior.push({
        role: m.from === "bot" ? "assistant" : "user",
        content: m.body,
      });
    }
    prior.push({ role: "user", content: you.message.body });

    await write({ type: "bot_start" });
    let deltaChain = Promise.resolve();
    const raw = await chatCompletionStream({
      system,
      messages: prior,
      think: false,
      replyKind: "chat",
      onDelta: (piece) => {
        if (!piece) return;
        deltaChain = deltaChain.then(() => write({ type: "bot_delta", text: piece }));
      },
    });
    await deltaChain;
    const parsed = parseThinkBody(raw.content, false);
    const text = String(parsed.body || raw.content || "").trim();
    if (!text) {
      const err = new Error("家机没说出话来");
      err.code = "llm_empty";
      throw err;
    }
    bot_message = appendSpitMessage(you.pass.id, "bot", text);
    // ponytail: 流式偶发无 usage；粗估一条吐槽 ≈500 token，升级=强制 stream_options
    let used = (Number(raw.tokens_in) || 0) + (Number(raw.tokens_out) || 0);
    if (used <= 0) used = 500;
    passAfter = addPassTokensUsed(you.pass.id, used) || passAfter;
    await write({
      type: "bot_done",
      message: bot_message,
      ...passBudgetInfo(passAfter),
    });
  } catch (e) {
    bot_error = {
      code: e.code || "llm_failed",
      message: e.message || "家机暂时接不上",
    };
    await write({ type: "bot_error", ...bot_error });
  }
  const spit = listSpit(titleId);
  passAfter = spit.pass;
  await write({
    type: "done",
    ok: true,
    pass: spit.pass,
    message: you.message,
    bot_message,
    bot_error,
    messages: spit.messages,
    ...passBudgetInfo(passAfter),
  });
  return {
    ok: true,
    pass: spit.pass,
    message: you.message,
    bot_message,
    bot_error,
    messages: spit.messages,
    ...passBudgetInfo(passAfter),
  };
}

/** @deprecated 整段等待；新路径用 createSpitWithReplyStream */
async function createSpitWithReply(titleId, patch) {
  const events = [];
  return createSpitWithReplyStream(titleId, patch, (ev) => events.push(ev));
}

function mimeForFile(file) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".ogv") return "video/ogg";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  if (ext === ".m4v") return "video/x-m4v";
  return "video/mp4";
}

/**
 * 解析媒体路径；缺文件抛 watch_media_missing。
 */
function resolveMedia(id) {
  const title = getTitle(id);
  if (!title) {
    const err = new Error("找不到该片子");
    err.code = "watch_not_found";
    throw err;
  }
  const fp = mediaPathFor(title.file);
  if (!fs.existsSync(fp)) {
    const err = new Error("原片文件不在本机（备份不含片）");
    err.code = "watch_media_missing";
    throw err;
  }
  const st = fs.statSync(fp);
  return {
    title,
    path: fp,
    size: st.size,
    mime: mimeForFile(title.file),
  };
}

/**
 * Range 流式输出原片。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} id
 */
function streamMedia(req, res, id) {
  const media = resolveMedia(id);
  const size = media.size;
  const mime = media.mime;
  const range = String(req.headers.range || "");
  const m = /^bytes=(\d*)-(\d*)$/i.exec(range);

  if (m) {
    let start = m[1] === "" ? 0 : Number(m[1]);
    let end = m[2] === "" ? size - 1 : Number(m[2]);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      res.writeHead(416, {
        "Content-Range": "bytes */" + size,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }
    if (end >= size) end = size - 1;
    const chunk = end - start + 1;
    res.writeHead(206, {
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Accept-Ranges": "bytes",
      "Content-Length": chunk,
      "Content-Type": mime,
      "Cache-Control": "private, no-store",
    });
    fs.createReadStream(media.path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Length": size,
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  fs.createReadStream(media.path).pipe(res);
}

function mediaPathFor(file) {
  const base = path.basename(String(file || ""));
  if (!base || base !== String(file || "")) {
    const err = new Error("非法文件名");
    err.code = "bad_watch_file";
    throw err;
  }
  return path.join(MEDIA_DIR, base);
}

/**
 * 把请求体流式写入媒体目录并登记 Title。
 * @param {import("node:http").IncomingMessage} req
 * @param {{ name?: string }} opts
 */
function addTitleFromStream(req, opts) {
  ensureDirs();
  const display = safeDisplayName(opts && opts.name);
  const ext = safeExt(display) || safeExt(opts && opts.name) || ".mp4";
  if (!VIDEO_EXT.has(ext)) {
    const err = new Error("只支持常见视频格式（mp4 / webm / mkv / mov…）");
    err.code = "bad_watch_type";
    return Promise.reject(err);
  }
  const id = randomUUID();
  const file = id + ext;
  const dest = mediaPathFor(file);
  const limit = WATCH_MAX_BYTES;

  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.destroy();
      ws.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("片子太大（上限约 2GB）");
        err.code = "watch_too_large";
        fail(err);
        return;
      }
      if (!ws.write(chunk)) req.pause();
    });
    ws.on("drain", () => req.resume());
    req.on("end", () => {
      if (done) return;
      if (size <= 0) {
        const err = new Error("空文件");
        err.code = "bad_watch_empty";
        fail(err);
        return;
      }
      ws.end();
    });
    ws.on("finish", () => {
      if (done) return;
      done = true;
      const title = normalizeTitle({
        id,
        name: display.endsWith(ext) ? display : display + ext,
        file,
        bytes: size,
        ts: Date.now(),
      });
      const all = readAll();
      all.titles.unshift(title);
      writeAll(all);
      resolve({ ok: true, title });
    });
    ws.on("error", fail);
    req.on("error", fail);
  });
}

function deleteTitle(id) {
  const tid = String(id || "").trim();
  const all = readAll();
  const hit = all.titles.find((t) => t.id === tid);
  if (!hit) {
    const err = new Error("找不到该片子");
    err.code = "watch_not_found";
    throw err;
  }
  const passIds = new Set(
    all.passes.filter((p) => p.titleId === tid).map((p) => p.id)
  );
  all.titles = all.titles.filter((t) => t.id !== tid);
  all.passes = all.passes.filter((p) => p.titleId !== tid);
  all.messages = all.messages.filter((m) => !passIds.has(m.passId));
  writeAll(all);
  try {
    fs.unlinkSync(mediaPathFor(hit.file));
  } catch {
    /* 元数据已删；原片缺席也算成功 */
  }
  return { ok: true, deleted: tid };
}

if (require.main === module) {
  ensureDirs();
  const stamp = "selfcheck-watch-" + Date.now() + ".mp4";
  const { PassThrough } = require("node:stream");
  const fake = new PassThrough();
  const p = addTitleFromStream(fake, { name: stamp });
  fake.end(Buffer.from("ftypisomselfcheck"));
  p.then((created) => {
    console.assert(created.title && created.title.name.includes("selfcheck"));
    console.assert(listTitles().titles.some((t) => t.id === created.title.id));
    const media = resolveMedia(created.title.id);
    console.assert(media.size > 0 && media.mime === "video/mp4");
    const a = listSpit(created.title.id);
    const b = listSpit(created.title.id);
    console.assert(a.pass.id === b.pass.id);
    const pres = getWatchPresence();
    console.assert(pres.active === true && pres.titleId === created.title.id);
    const spit = createSpit(created.title.id, { body: "吐槽" + Date.now() });
    console.assert(spit.message.from === "you");
    console.assert(listSpit(created.title.id).messages.some((m) => m.id === spit.message.id));
    const bot = appendSpitMessage(spit.pass.id, "bot", "家机自检");
    console.assert(bot.from === "bot");
    console.assert(listSpit(created.title.id).messages.some((m) => m.id === bot.id));
    try {
      createSpit(created.title.id, { body: "  " });
      throw new Error("expected bad_spit_body");
    } catch (e) {
      if (e.code !== "bad_spit_body") throw e;
    }
    const oldPassId = spit.pass.id;
    const ended = endActivePass(created.title.id);
    console.assert(ended.ended === true && ended.pass.status === "ended");
    console.assert(endActivePass(created.title.id).ended === false);
    const again = listSpit(created.title.id);
    console.assert(again.pass.id !== oldPassId);
    console.assert(again.pass.status === "active");
    console.assert(!again.messages.some((m) => m.passId === oldPassId));
    console.assert(again.tokens_used === 0);
    const bud = patchPassBudget(created.title.id, 1);
    console.assert(bud.budget_tokens > 0 && !bud.budget_exhausted);
    addPassTokensUsed(bud.pass.id, bud.budget_tokens);
    console.assert(passBudgetExhausted(listSpit(created.title.id).pass));
    return createSpitWithReplyStream(created.title.id, { body: "额度闸自检" }, () => {}).then(
      (gated) => {
        console.assert(gated.message && gated.message.from === "you");
        console.assert(!gated.bot_message);
        console.assert(gated.bot_error && gated.bot_error.code === "budget_exhausted");
        console.assert(
          listSpit(created.title.id).messages.some((m) => m.id === gated.message.id)
        );
        const fp = mediaPathFor(created.title.file);
        deleteTitle(created.title.id);
        console.assert(!listTitles().titles.some((t) => t.id === created.title.id));
        console.assert(!fs.existsSync(fp));
        console.assert(!readAll().passes.some((x) => x.titleId === created.title.id));
        console.log("watch ok");
      }
    );
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  listTitles,
  getWatchPresence,
  getTitle,
  resolveMedia,
  streamMedia,
  listSpit,
  createSpit,
  createSpitWithReply,
  createSpitWithReplyStream,
  ensureActivePass,
  endActivePass,
  patchPassBudget,
  addPassTokensUsed,
  passBudgetExhausted,
  addTitleFromStream,
  deleteTitle,
  readAll,
  WATCH_PATH,
  MEDIA_DIR,
  WATCH_MAX_BYTES,
  SPIT_BODY_MAX,
};
