const { chatCompletion, parseThinkBody, resolveThinkText } = require("./llm");
const { getHighlights, findBook, readAll, writeAll } = require("./highlights");
const {
  readSettings,
  isDoorLocked,
  assertDoorOpen,
  effectiveDialogue,
  appendDialogueHints,
  appendLoreToSystem,
} = require("./settings");
const { getOpenSession, budgetExhausted, addOpenTokensUsed } = require("./sessions");
const { loreTextForInject } = require("./pass-lore");

function saveHighlightPatch(bookId, highlightId, patch) {
  const all = readAll();
  const list = all.byBook[bookId] || [];
  const idx = list.findIndex((h) => h.id === highlightId);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  all.byBook[bookId] = list;
  writeAll(all);
  return list[idx];
}

/** paused 优先；mode: immersive | ideas | silent
 * 微信孤儿想法 / 本地想法：kind===idea，靠 idea 字段跟批。
 */
function shouldFollowHighlight(h, { paused = false, mode = "immersive" } = {}) {
  if (paused) return false;
  if (mode === "silent") return false;
  if (!h) return false;
  if (h.follow || h.follow_error) return false;
  const hasIdea = !!(h.idea && String(h.idea).trim());
  const hasText = !!(h.text && String(h.text).trim());
  if (h.kind === "idea") {
    if (!hasIdea) return false;
    return mode === "immersive" || mode === "ideas";
  }
  if (!hasText && !hasIdea) return false;
  if (mode === "ideas" && !hasIdea) return false;
  return true;
}

/** 跟批注入长卡时的软上限（字），超出截断并标注 */
const PERSONA_CARD_FOLLOW_MAX = 4000;

function buildFollowSystem(persona, personaCard, { includeCard = false } = {}) {
  let system =
    "你是共读小屋里的陪伴读者，语气自然、有温度，贴合原文，不要说教，不要复述整段划线。跟批控制在 2～5 句。";
  const p = String(persona || "").trim();
  if (p) {
    system += "\n用户设定的跟批人设（请遵守称呼与语气）：" + p;
  }
  if (includeCard) {
    let card = String(personaCard || "").trim();
    if (card) {
      if (card.length > PERSONA_CARD_FOLLOW_MAX) {
        card =
          card.slice(0, PERSONA_CARD_FOLLOW_MAX) +
          "\n…（完整角色卡已截断，全文仅保存在设定里）";
      }
      system += "\n完整角色卡（补充设定，勿整段复述）：\n" + card;
    }
  }
  return system;
}

function variantSnap(f) {
  return {
    think: f.think || null,
    body: f.body || "",
    tokens_in: Number(f.tokens_in) || 0,
    tokens_out: Number(f.tokens_out) || 0,
    model: f.model || null,
    at: f.at || Date.now(),
  };
}

/** 旧跟批无 variants 时补成单候选；active 指向当前展示条 */
function normalizeFollowVariants(follow) {
  if (!follow || !follow.body) return follow;
  if (Array.isArray(follow.variants) && follow.variants.length) {
    const active = Math.max(
      0,
      Math.min(follow.variants.length - 1, Number(follow.active) || 0)
    );
    const v = follow.variants[active];
    return {
      ...follow,
      active,
      think: v.think || null,
      body: v.body || "",
      tokens_in: Number(v.tokens_in) || 0,
      tokens_out: Number(v.tokens_out) || 0,
      model: v.model || null,
      at: v.at || follow.at,
    };
  }
  const snap = variantSnap(follow);
  return { ...follow, variants: [snap], active: 0 };
}

function applyFollowVariant(follow, index) {
  const f = normalizeFollowVariants(follow);
  if (!f || !f.variants.length) {
    const err = new Error("没有可切换的候选");
    err.code = "no_variants";
    throw err;
  }
  const i = Math.max(0, Math.min(f.variants.length - 1, Number(index)));
  const v = f.variants[i];
  return {
    ...f,
    active: i,
    think: v.think || null,
    body: v.body || "",
    tokens_in: Number(v.tokens_in) || 0,
    tokens_out: Number(v.tokens_out) || 0,
    model: v.model || null,
    at: v.at || f.at,
    edited: !!v.edited,
  };
}

function applySessionLore(system, highlight, open, loreSummary) {
  if (open && open.lore_light) {
    return (
      system +
      "\n本场设定：少提设定。不要注入/主动提及剧情摘要背景，多贴原文与当下感受；不要主动续写长线剧情。"
    );
  }
  return appendLoreToSystem(system, loreSummary);
}

function appendFollowTone(system, tone) {
  // 语气档位已下线：长短/口吻交人设与划线内容，不再注入 short/ask/empathy
  return String(system || "");
}

/** 本场跟批 system（与 followOne 同装配；世界书已下线） */
function buildOpenFollowSystem(book, open, highlight) {
  const sess = open || getOpenSession();
  const dlg = effectiveDialogue(sess);
  let system = buildFollowSystem("", dlg.persona_card, {
    includeCard: !!dlg.persona_card_in_follow,
  });
  system = appendDialogueHints(system, dlg);
  const pass =
    (sess && Number(sess.pass_ordinal)) ||
    (book && Number(book.active_pass)) ||
    1;
  const lore =
    book && book.id ? loreTextForInject(book.id, pass) : "";
  system = applySessionLore(system, highlight || { text: "", idea: "" }, sess, lore);
  system = appendFollowTone(system, sess && sess.follow_tone);
  return system;
}

async function followOne(book, highlight, { think, model, feedback } = {}) {
  const userParts = buildFollowUserParts(book, highlight, { feedback });

  const s = readSettings();
  const open = getOpenSession();
  const system = buildOpenFollowSystem(book, open, highlight);

  const usedModel =
    String(model || s.llm_model || "").trim() || undefined;
  const raw = await chatCompletion({
    system,
    user: userParts.join("\n"),
    think: !!think,
    model: usedModel,
  });
  const parsed = parseThinkBody(raw.content, !!think);
  const snap = {
    think: resolveThinkText(parsed, raw, !!think),
    body: parsed.body || raw.content,
    tokens_in: raw.tokens_in,
    tokens_out: raw.tokens_out,
    model: usedModel,
    at: Date.now(),
  };
  return { ...snap, variants: [snap], active: 0 };
}

function buildFollowUserParts(book, highlight, { feedback } = {}) {
  const userParts = [`书名：《${(book && book.title) || "未命名"}》`];
  if (highlight && highlight.text) userParts.push(`划线原文：${highlight.text}`);
  if (highlight && highlight.idea) userParts.push(`读者想法：${highlight.idea}`);
  if (highlight && highlight.chapter_title) {
    userParts.push(`章节：${highlight.chapter_title}`);
  }
  // feedback !== undefined → 踩/OOC 重生：带上旧文 + 理由
  if (feedback !== undefined && highlight) {
    const prev = highlight.follow ? normalizeFollowVariants(highlight.follow) : null;
    if (prev && prev.body) userParts.push("先前跟批：\n" + prev.body);
    const fb = String(feedback || "").trim();
    userParts.push(
      fb
        ? "读者点了踩，理由：" +
            fb +
            "。请另写一条跟批，按理由调整；不要辩解或道歉套话，直接输出新跟批。"
        : "读者点了踩。请另写一条跟批，换个角度，少说教，贴原文；不要辩解或道歉套话。"
    );
  }
  return userParts;
}

/**
 * 换一条：保留旧候选，追加新跟批并切到最新。
 * 用户主动操作：不要求未暂停；仍守本场额度。
 * feedback !== undefined 时为踩/OOC 路径（可空字符串）。
 */
async function regenerateFollow(
  bookKey,
  highlightId,
  { think = true, model, feedback } = {}
) {
  assertDoorOpen();
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const hid = String(highlightId || "").trim();
  if (!hid) {
    const err = new Error("请指定 highlightId");
    err.code = "highlight_required";
    throw err;
  }
  const { highlights } = getHighlights(book.id);
  const h = highlights.find((x) => x.id === hid);
  if (!h || !h.follow || !h.follow.body) {
    const err = new Error("该划线还没有跟批");
    err.code = "no_follow";
    throw err;
  }

  const open = getOpenSession();
  if (open && open.book_id === book.id && budgetExhausted(open)) {
    const err = new Error("本场额度已用尽");
    err.code = "budget_exhausted";
    throw err;
  }

  const base = normalizeFollowVariants(h.follow);
  const fresh = await followOne(book, h, {
    think,
    model,
    ...(feedback !== undefined ? { feedback } : {}),
  });
  const snap = variantSnap(fresh);
  const variants = base.variants.concat([snap]);
  const follow = applyFollowVariant({ ...fresh, variants, active: variants.length - 1 }, variants.length - 1);
  const updated = saveHighlightPatch(book.id, h.id, {
    follow,
    follow_error: null,
  });
  if (open && open.book_id === book.id) {
    addOpenTokensUsed((snap.tokens_in || 0) + (snap.tokens_out || 0));
  }
  const openAfter = getOpenSession();
  return {
    book_id: book.id,
    highlight: updated,
    follow_count: variants.length,
    tokens_used: openAfter && openAfter.book_id === book.id ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter && openAfter.book_id === book.id ? openAfter.budget_tokens || 0 : 0,
    budget_exhausted: !!(openAfter && openAfter.book_id === book.id && budgetExhausted(openAfter)),
    highlights: getHighlights(book.id).highlights,
  };
}

function selectFollowVariant(bookKey, highlightId, index) {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const hid = String(highlightId || "").trim();
  const { highlights } = getHighlights(book.id);
  const h = highlights.find((x) => x.id === hid);
  if (!h || !h.follow) {
    const err = new Error("该划线还没有跟批");
    err.code = "no_follow";
    throw err;
  }
  const follow = applyFollowVariant(h.follow, index);
  const updated = saveHighlightPatch(book.id, h.id, { follow });
  return {
    book_id: book.id,
    highlight: updated,
    highlights: getHighlights(book.id).highlights,
  };
}

/**
 * 手改跟批：直接覆盖当前展示的候选；不调 LLM、不计额度、不另开新页。
 */
function editFollow(bookKey, highlightId, body) {
  const text = String(body || "").trim();
  if (!text) {
    const err = new Error("请输入跟批正文");
    err.code = "empty_body";
    throw err;
  }
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }
  const hid = String(highlightId || "").trim();
  if (!hid) {
    const err = new Error("请指定 highlightId");
    err.code = "highlight_required";
    throw err;
  }
  const { highlights } = getHighlights(book.id);
  const h = highlights.find((x) => x.id === hid);
  if (!h || !h.follow || !h.follow.body) {
    const err = new Error("该划线还没有跟批");
    err.code = "no_follow";
    throw err;
  }
  const base = normalizeFollowVariants(h.follow);
  const i = Math.max(0, Math.min(base.variants.length - 1, Number(base.active) || 0));
  const prev = base.variants[i] || {};
  const snap = {
    think: prev.think || null,
    body: text,
    tokens_in: Number(prev.tokens_in) || 0,
    tokens_out: Number(prev.tokens_out) || 0,
    model: prev.model || null,
    at: Date.now(),
    edited: true,
  };
  const variants = base.variants.slice();
  variants[i] = snap;
  const follow = applyFollowVariant({ ...base, variants, active: i }, i);
  const updated = saveHighlightPatch(book.id, h.id, {
    follow,
    follow_error: null,
  });
  return {
    book_id: book.id,
    highlight: updated,
    follow_count: variants.length,
    highlights: getHighlights(book.id).highlights,
  };
}

/**
 * 对一书尚未跟批的划线生成跟批（默认最新 3 条，串行）。
 * 遵守本场 follow_paused / follow_mode。
 */
async function followPending(
  bookKey,
  { limit = 3, think = true, retry = false, model, highlightId } = {}
) {
  const book = findBook(bookKey);
  if (!book) {
    const err = new Error("找不到这本书");
    err.code = "book_not_found";
    throw err;
  }

  const open = getOpenSession();
  const paused = !!(open && open.book_id === book.id && open.follow_paused);
  const mode =
    (open && open.book_id === book.id && open.follow_mode) || "immersive";
  const budgetDone = !!(open && open.book_id === book.id && budgetExhausted(open));
  const locked = isDoorLocked();
  const hid = String(highlightId || "").trim();

  if ((retry || hid) && !locked) {
    const all = readAll();
    const list = all.byBook[book.id] || [];
    let cleared = false;
    for (const h of list) {
      if (!(h.follow_error && !h.follow)) continue;
      if (hid && h.id !== hid) continue;
      if (!hid && !retry) continue;
      delete h.follow_error;
      cleared = true;
    }
    if (cleared) {
      all.byBook[book.id] = list;
      writeAll(all);
    }
  }

  const { highlights } = getHighlights(book.id);
  let pending = [];
  if (budgetDone || locked) {
    pending = [];
  } else if (hid) {
    // 用户点「重试」：只跟这一条，不要求未暂停（含 kind===idea）
    const target = highlights.find((h) => h.id === hid);
    if (
      target &&
      shouldFollowHighlight(target, { paused: false, mode }) &&
      !(target.follow && target.follow.body)
    ) {
      pending = [target];
    }
  } else {
    pending = highlights
      .filter((h) => shouldFollowHighlight(h, { paused, mode }))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, Math.max(1, Math.min(limit, 5)));
  }

  const done = [];
  for (const h of pending) {
    const live = getOpenSession();
    if (live && live.book_id === book.id && budgetExhausted(live)) break;
    try {
      const follow = await followOne(book, h, { think, model });
      const updated = saveHighlightPatch(book.id, h.id, {
        follow,
        follow_error: null,
      });
      done.push(updated);
      if (live && live.book_id === book.id) {
        addOpenTokensUsed((follow.tokens_in || 0) + (follow.tokens_out || 0));
      }
    } catch (e) {
      const updated = saveHighlightPatch(book.id, h.id, {
        follow_error: e.message || "跟批失败",
      });
      done.push(updated);
    }
  }

  const openAfter = getOpenSession();
  return {
    book_id: book.id,
    followed: done.filter((h) => h && h.follow).length,
    failed: done.filter((h) => h && h.follow_error).length,
    follow_mode: mode,
    follow_paused: paused,
    door_locked: locked,
    budget_exhausted: !!(openAfter && openAfter.book_id === book.id && budgetExhausted(openAfter)),
    tokens_used: openAfter && openAfter.book_id === book.id ? openAfter.tokens_used || 0 : 0,
    budget_tokens: openAfter && openAfter.book_id === book.id ? openAfter.budget_tokens || 0 : 0,
    highlights: getHighlights(book.id).highlights,
  };
}

if (require.main === module) {
  const base = { kind: "highlight", text: "句", idea: null };
  console.assert(shouldFollowHighlight(base, { mode: "immersive" }));
  console.assert(!shouldFollowHighlight(base, { mode: "ideas" }));
  console.assert(shouldFollowHighlight({ ...base, idea: "想" }, { mode: "ideas" }));
  console.assert(!shouldFollowHighlight(base, { mode: "silent" }));
  console.assert(!shouldFollowHighlight(base, { paused: true, mode: "immersive" }));
  const orphan = { kind: "idea", text: "", idea: "本地想法" };
  console.assert(shouldFollowHighlight(orphan, { mode: "immersive" }));
  console.assert(shouldFollowHighlight(orphan, { mode: "ideas" }));
  console.assert(!shouldFollowHighlight(orphan, { mode: "silent" }));
  console.assert(!shouldFollowHighlight({ kind: "idea", idea: "  " }, { mode: "ideas" }));
  const withP = buildFollowSystem("叫我阿州");
  console.assert(withP.includes("叫我阿州"));
  console.assert(!buildFollowSystem("").includes("跟批人设"));
  const long = "卡".repeat(5000);
  const withCard = buildFollowSystem("短", long, { includeCard: true });
  console.assert(withCard.includes("短") && withCard.includes("已截断"));
  console.assert(!buildFollowSystem("短", long, { includeCard: false }).includes("完整角色卡"));
  const legacy = { body: "旧", think: "想", tokens_in: 1, tokens_out: 2, at: 1 };
  const n = normalizeFollowVariants(legacy);
  console.assert(n.variants.length === 1 && n.active === 0 && n.body === "旧");
  const two = applyFollowVariant(
    { ...n, variants: n.variants.concat([{ body: "新", think: null, tokens_in: 3, tokens_out: 4, at: 2 }]) },
    1
  );
  console.assert(two.active === 1 && two.body === "新" && two.tokens_in === 3);
  console.assert(applyFollowVariant(two, 0).body === "旧");
  const editedBase = {
    body: "旧",
    variants: [
      { body: "旧A", tokens_in: 1, tokens_out: 1, at: 1 },
      { body: "旧B", tokens_in: 2, tokens_out: 2, at: 2 },
    ],
    active: 1,
  };
  const overwritten = applyFollowVariant(
    {
      ...editedBase,
      variants: [
        editedBase.variants[0],
        { ...editedBase.variants[1], body: "手改B", edited: true, at: 3 },
      ],
      active: 1,
    },
    1
  );
  console.assert(overwritten.body === "手改B" && overwritten.edited === true, overwritten);
  console.assert(overwritten.active === 1 && overwritten.variants.length === 2, overwritten);
  const plain = buildFollowUserParts({ title: "测试" }, { text: "句", follow: { body: "旧批" } });
  console.assert(plain.join("\n").includes("划线原文") && !plain.join("\n").includes("踩"), plain);
  const down = buildFollowUserParts(
    { title: "测试" },
    { text: "句", follow: { body: "旧批" } },
    { feedback: "太说教" }
  );
  console.assert(down.join("\n").includes("先前跟批") && down.join("\n").includes("太说教"), down);
  const light = applySessionLore("base", { text: "线粒体" }, { lore_light: true }, "长剧情");
  console.assert(light.includes("少提设定") && !light.includes("长剧情") && !light.includes("相关设定"), light);
  const full = applySessionLore("base", { text: "线粒体与内共生" }, { lore_light: false }, "长剧情");
  console.assert(full.includes("长剧情") || full.includes("剧情摘要"), full);
  console.assert(appendFollowTone("base", "short") === "base");
  console.assert(appendFollowTone("base", "ask") === "base");
  console.assert(appendFollowTone("base", "empathy") === "base");
  console.assert(appendFollowTone("base", "") === "base");
  console.log("follow ok");
}

module.exports = {
  followPending,
  followOne,
  regenerateFollow,
  selectFollowVariant,
  editFollow,
  normalizeFollowVariants,
  applyFollowVariant,
  shouldFollowHighlight,
  buildFollowSystem,
  buildOpenFollowSystem,
  buildFollowUserParts,
  applySessionLore,
  appendFollowTone,
  PERSONA_CARD_FOLLOW_MAX,
};
