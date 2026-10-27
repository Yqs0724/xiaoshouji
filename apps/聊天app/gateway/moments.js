/**
 * 朋友圈本地时间线（H1.2 / H1.11′ / H1.12 / H9）：发/赞/评/删/分享范围/图；
 * H9：TA 工具发/翻/评（授权；确认或自动）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const MOMENTS_PATH = path.join(DATA_DIR, "moments.json");
const TEXT_MAX = 200;
const TEXT_MAX_BOT = 800;
const CMT_MAX = 200;
const IMG_MAX = 9;
const LIKE_WHO = "你";
const BOT_LIKE_WHO = "家机";
const SCOPES = new Set(["public", "private", "partial"]);
/* 可见名单里的联系人 id；AI 侧统一用 bot */
const PEER_IDS = new Set(["bot"]);
const PENDING_MAX = 24;
const POST_MAX_PER_REPLY = 1;
const COMMENT_MAX_PER_REPLY = 2;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MOMENTS_PATH)) {
    fs.writeFileSync(
      MOMENTS_PATH,
      JSON.stringify({ posts: [], pending: [] }, null, 2),
      "utf8"
    );
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(MOMENTS_PATH, "utf8"));
    const posts = Array.isArray(raw.posts) ? raw.posts.map(normalizePost).filter(Boolean) : [];
    posts.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    const pending = Array.isArray(raw.pending)
      ? raw.pending.map(normalizePending).filter(Boolean)
      : [];
    return { posts, pending };
  } catch (_) {
    return { posts: [], pending: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(
    MOMENTS_PATH,
    JSON.stringify(
      {
        posts: Array.isArray(data.posts) ? data.posts : [],
        pending: Array.isArray(data.pending) ? data.pending : [],
      },
      null,
      2
    ),
    "utf8"
  );
}

function normalizePending(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").trim();
  if (kind !== "post" && kind !== "comment" && kind !== "like") return null;
  const id = String(raw.id || "").trim() || randomUUID();
  const payload =
    raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  return {
    id,
    kind,
    payload,
    preview: String(raw.preview || "").trim().slice(0, 160),
    peerId: String(raw.peerId || "daily").trim().slice(0, 32) || "daily",
    created_at: Number(raw.created_at) || Date.now(),
  };
}

function normalizeComment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const txt = String(raw.txt || raw.text || "").trim().slice(0, CMT_MAX);
  if (!txt) return null;
  return {
    id: String(raw.id || randomUUID()),
    who: String(raw.who || "你").trim().slice(0, 16) || "你",
    txt,
    ts: Number(raw.ts) || Date.now(),
  };
}

function normalizeImages(raw) {
  const src = Array.isArray(raw) ? raw : Array.isArray(raw && raw.images) ? raw.images : [];
  const out = [];
  for (const item of src) {
    const u = String(item || "").trim().slice(0, 512);
    if (!u) continue;
    if (!/^\/api\/v1\/chat\/media\//.test(u) && !/^https?:\/\//i.test(u)) continue;
    out.push(u);
    if (out.length >= IMG_MAX) break;
  }
  return out;
}

function normalizeScope(raw) {
  const s = String(raw || "public").trim().toLowerCase();
  return SCOPES.has(s) ? s : "public";
}

function normalizeVisibleTo(raw, scope) {
  if (scope !== "partial") return [];
  const src = Array.isArray(raw)
    ? raw
    : Array.isArray(raw && raw.visibleTo)
      ? raw.visibleTo
      : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const id = String(item || "").trim().slice(0, 32);
    if (!id || !PEER_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyVisibility(postLike, scopeRaw, visibleRaw) {
  let scope = normalizeScope(scopeRaw);
  let visibleTo = normalizeVisibleTo(visibleRaw, scope);
  if (scope === "partial" && !visibleTo.length) {
    scope = "private";
    visibleTo = [];
  }
  postLike.scope = scope;
  postLike.visibleTo = visibleTo;
}

function normalizePost(raw) {
  if (!raw || typeof raw !== "object") return null;
  const author = raw.author === "bot" ? "bot" : "you";
  const txt = String(raw.txt || raw.text || "")
    .trim()
    .slice(0, textMaxForAuthor(author));
  const images = normalizeImages(raw.images || raw.imgs);
  if (!txt && !images.length) return null;
  const likes = Array.isArray(raw.likes)
    ? raw.likes.map((x) => String(x || "").trim().slice(0, 16)).filter(Boolean)
    : [];
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map(normalizeComment).filter(Boolean)
    : [];
  const post = {
    id: String(raw.id || randomUUID()),
    author,
    name: String(raw.name || (author === "bot" ? "家机" : "你")).trim().slice(0, 32),
    txt,
    images,
    scope: "public",
    visibleTo: [],
    ts: Number(raw.ts) || Date.now(),
    likes,
    comments,
  };
  applyVisibility(post, raw.scope, raw.visibleTo);
  return post;
}

function listMoments() {
  return { ok: true, posts: readAll().posts };
}

function textMaxForAuthor(author) {
  return author === "bot" ? TEXT_MAX_BOT : TEXT_MAX;
}

function createPost(patch) {
  const author = (patch && patch.author) === "bot" ? "bot" : "you";
  const txt = String((patch && (patch.txt || patch.text)) || "")
    .trim()
    .slice(0, textMaxForAuthor(author));
  const images = normalizeImages(patch && (patch.images || patch.imgs));
  if (!txt && !images.length) {
    const err = new Error("写点文字或加一张图");
    err.code = "empty_text";
    throw err;
  }
  const post = normalizePost({
    id: randomUUID(),
    author,
    name: (patch && patch.name) || (author === "bot" ? "家机" : "你"),
    txt,
    images,
    scope: patch && patch.scope,
    visibleTo: patch && patch.visibleTo,
    ts: Date.now(),
    likes: [],
    comments: [],
  });
  const all = readAll();
  all.posts.unshift(post);
  writeAll(all);
  return { ok: true, post };
}

/** viewer: "you" | "bot" —— TA 翻圈时看不到仅自己 / 未点名 TA 的部分可见 */
function postVisibleTo(post, viewer) {
  if (!post) return false;
  const v = viewer === "bot" ? "bot" : "you";
  if (v === "you") return true;
  if (post.author === "bot") return true;
  const scope = post.scope || "public";
  if (scope === "public") return true;
  if (scope === "private") return false;
  if (scope === "partial") {
    return Array.isArray(post.visibleTo) && post.visibleTo.includes("bot");
  }
  return true;
}

function listMomentsForViewer(viewer) {
  const all = listMoments().posts || [];
  return {
    ok: true,
    viewer: viewer === "bot" ? "bot" : "you",
    posts: all.filter((p) => postVisibleTo(p, viewer)),
  };
}

function findPost(all, id) {
  const sid = String(id || "");
  return all.posts.find((p) => p && p.id === sid) || null;
}

function deletePost(postId, opts) {
  const all = readAll();
  const post = findPost(all, postId);
  if (!post) {
    const err = new Error("动态不存在");
    err.code = "not_found";
    throw err;
  }
  const asBot = opts && opts.asBot;
  if (asBot) {
    if (post.author !== "bot") {
      const err = new Error("只能删自己的动态");
      err.code = "forbidden";
      throw err;
    }
  } else if (post.author !== "you") {
    const err = new Error("只能删自己的动态");
    err.code = "forbidden";
    throw err;
  }
  all.posts = all.posts.filter((p) => p && p.id !== post.id);
  writeAll(all);
  return { ok: true, id: post.id };
}

function updatePost(postId, patch) {
  const all = readAll();
  const post = findPost(all, postId);
  if (!post) {
    const err = new Error("动态不存在");
    err.code = "not_found";
    throw err;
  }
  if (post.author !== "you") {
    const err = new Error("只能改自己的动态");
    err.code = "forbidden";
    throw err;
  }
  if (
    patch &&
    (Object.prototype.hasOwnProperty.call(patch, "scope") ||
      Object.prototype.hasOwnProperty.call(patch, "visibleTo"))
  ) {
    applyVisibility(
      post,
      Object.prototype.hasOwnProperty.call(patch, "scope") ? patch.scope : post.scope,
      Object.prototype.hasOwnProperty.call(patch, "visibleTo")
        ? patch.visibleTo
        : post.visibleTo
    );
  }
  writeAll(all);
  return { ok: true, post };
}

function toggleLike(postId, who) {
  const liker = String(who || LIKE_WHO).trim().slice(0, 16) || LIKE_WHO;
  const all = readAll();
  const post = findPost(all, postId);
  if (!post) {
    const err = new Error("动态不存在");
    err.code = "not_found";
    throw err;
  }
  const i = post.likes.indexOf(liker);
  if (i >= 0) post.likes.splice(i, 1);
  else post.likes.unshift(liker);
  writeAll(all);
  return { ok: true, post };
}

function addComment(postId, patch) {
  const txt = String((patch && (patch.txt || patch.text)) || "").trim().slice(0, CMT_MAX);
  if (!txt) {
    const err = new Error("评论为空");
    err.code = "empty_text";
    throw err;
  }
  const all = readAll();
  const post = findPost(all, postId);
  if (!post) {
    const err = new Error("动态不存在");
    err.code = "not_found";
    throw err;
  }
  const cmt = normalizeComment({
    id: randomUUID(),
    who: (patch && patch.who) || "你",
    txt,
    ts: Date.now(),
  });
  post.comments.push(cmt);
  writeAll(all);
  return { ok: true, post };
}

function enqueuePending(kind, payload, opts) {
  const all = readAll();
  if ((all.pending || []).length >= PENDING_MAX) {
    const err = new Error("待确认太多，先处理几条");
    err.code = "pending_full";
    throw err;
  }
  const preview =
    kind === "post"
      ? String((payload && (payload.txt || payload.text)) || "").trim().slice(0, 80)
      : kind === "comment"
        ? String((payload && (payload.txt || payload.text)) || "").trim().slice(0, 80)
        : "赞";
  const row = normalizePending({
    id: randomUUID(),
    kind,
    payload: payload || {},
    preview,
    peerId: (opts && opts.peerId) || "daily",
    created_at: Date.now(),
  });
  all.pending = all.pending || [];
  all.pending.unshift(row);
  writeAll(all);
  return {
    ok: true,
    needs_confirm: true,
    pending_id: row.id,
    kind: row.kind,
    preview: row.preview,
    message: "需你同意后才会发布",
  };
}

function listPending() {
  return { ok: true, pending: readAll().pending || [] };
}

function rejectPending(id) {
  const all = readAll();
  const sid = String(id || "").trim();
  const before = (all.pending || []).length;
  all.pending = (all.pending || []).filter((p) => p && p.id !== sid);
  if (all.pending.length === before) {
    const err = new Error("待确认不存在");
    err.code = "pending_missing";
    throw err;
  }
  writeAll(all);
  return { ok: true, id: sid, rejected: true };
}

function confirmPending(id) {
  const all = readAll();
  const sid = String(id || "").trim();
  const idx = (all.pending || []).findIndex((p) => p && p.id === sid);
  if (idx < 0) {
    const err = new Error("待确认不存在");
    err.code = "pending_missing";
    throw err;
  }
  const row = all.pending[idx];
  all.pending.splice(idx, 1);
  writeAll(all);
  const p = row.payload || {};
  if (row.kind === "post") {
    return createPost({
      author: "bot",
      name: p.name || "家机",
      text: p.txt || p.text,
      images: p.images,
      scope: "public",
    });
  }
  if (row.kind === "comment") {
    return addComment(p.post_id || p.postId, {
      who: p.who || BOT_LIKE_WHO,
      text: p.txt || p.text,
    });
  }
  if (row.kind === "like") {
    return toggleLike(p.post_id || p.postId, p.who || BOT_LIKE_WHO);
  }
  const err = new Error("未知待确认类型");
  err.code = "bad_pending";
  throw err;
}

/**
 * H9 工具入口：mode=auto|confirm
 * quotas: { postsUsed, commentsUsed }
 */
function runMomentsAi(action, args, opts) {
  const mode = String((opts && opts.mode) || "confirm").toLowerCase() === "auto"
    ? "auto"
    : "confirm";
  const peerId = String((opts && opts.peerId) || "daily").trim() || "daily";
  const botName = String((opts && opts.botName) || "家机").trim().slice(0, 32) || "家机";
  const act = String(action || "").trim();
  const a = args || {};

  if (act === "list") {
    const lim = Math.max(1, Math.min(30, Math.floor(Number(a.limit) || 12)));
    const listed = listMomentsForViewer("bot");
    const posts = (listed.posts || []).slice(0, lim).map((p) => ({
      id: p.id,
      author: p.author,
      name: p.name,
      txt: String(p.txt || "").slice(0, 120),
      scope: p.scope,
      likes: (p.likes || []).length,
      comments: (p.comments || []).slice(-3).map((c) => ({
        who: c.who,
        txt: String(c.txt || "").slice(0, 60),
      })),
      ts: p.ts,
    }));
    return { ok: true, posts, count: posts.length };
  }

  if (act === "post") {
    const used = Number(opts && opts.postsUsed) || 0;
    if (used >= POST_MAX_PER_REPLY) {
      return {
        ok: false,
        error: "moments_post_limit",
        message: "本轮发动态已达上限（" + POST_MAX_PER_REPLY + "）",
      };
    }
    const txt = String(a.txt || a.text || "").trim();
    if (!txt) {
      return { ok: false, error: "empty_text", message: "正文不能为空" };
    }
    const payload = { txt, name: botName };
    if (mode === "confirm") {
      return enqueuePending("post", payload, { peerId });
    }
    const r = createPost({ author: "bot", name: botName, text: txt, scope: "public" });
    return { ok: true, post: r.post };
  }

  if (act === "comment") {
    const used = Number(opts && opts.commentsUsed) || 0;
    if (used >= COMMENT_MAX_PER_REPLY) {
      return {
        ok: false,
        error: "moments_comment_limit",
        message: "本轮评论已达上限（" + COMMENT_MAX_PER_REPLY + "）",
      };
    }
    const postId = String(a.post_id || a.postId || "").trim();
    const txt = String(a.txt || a.text || "").trim();
    if (!postId || !txt) {
      return { ok: false, error: "bad_args", message: "需要 post_id 与正文" };
    }
    const post = findPost(readAll(), postId);
    if (!post || !postVisibleTo(post, "bot")) {
      return { ok: false, error: "not_found", message: "动态不存在或不可见" };
    }
    const payload = { post_id: postId, txt, who: botName };
    if (mode === "confirm") {
      return enqueuePending("comment", payload, { peerId });
    }
    const r = addComment(postId, { who: botName, text: txt });
    return { ok: true, post: { id: r.post.id, comments: r.post.comments.slice(-3) } };
  }

  if (act === "like") {
    const postId = String(a.post_id || a.postId || "").trim();
    if (!postId) {
      return { ok: false, error: "bad_args", message: "需要 post_id" };
    }
    const post = findPost(readAll(), postId);
    if (!post || !postVisibleTo(post, "bot")) {
      return { ok: false, error: "not_found", message: "动态不存在或不可见" };
    }
    const payload = { post_id: postId, who: botName };
    if (mode === "confirm") {
      return enqueuePending("like", payload, { peerId });
    }
    const r = toggleLike(postId, botName);
    return {
      ok: true,
      liked: (r.post.likes || []).includes(botName),
      likes: (r.post.likes || []).length,
    };
  }

  return { ok: false, error: "unknown_action", message: "未知动作" };
}

module.exports = {
  listMoments,
  listMomentsForViewer,
  createPost,
  deletePost,
  updatePost,
  toggleLike,
  addComment,
  enqueuePending,
  listPending,
  confirmPending,
  rejectPending,
  runMomentsAi,
  postVisibleTo,
  POST_MAX_PER_REPLY,
  COMMENT_MAX_PER_REPLY,
  TEXT_MAX,
  TEXT_MAX_BOT,
  MOMENTS_PATH,
};

if (require.main === module) {
  const stamp = "moments-selfcheck-" + Date.now();
  const created = createPost({ text: stamp, scope: "private" });
  console.assert(created.ok && created.post && created.post.txt === stamp);
  console.assert(created.post.scope === "private");
  const id = created.post.id;
  console.assert(!postVisibleTo(created.post, "bot"));
  const scoped = updatePost(id, { scope: "public" });
  console.assert(scoped.post.scope === "public");
  console.assert(postVisibleTo(scoped.post, "bot"));
  const part = updatePost(id, { scope: "partial", visibleTo: ["bot"] });
  console.assert(part.post.scope === "partial" && part.post.visibleTo[0] === "bot");
  const emptyPart = createPost({
    text: stamp + "-empty",
    scope: "partial",
    visibleTo: [],
  });
  console.assert(emptyPart.post.scope === "private");
  deletePost(emptyPart.post.id);
  const liked = toggleLike(id, "你");
  console.assert(liked.post.likes.includes("你"));
  const unliked = toggleLike(id, "你");
  console.assert(!unliked.post.likes.includes("你"));
  const cmt = addComment(id, { text: "自检评" });
  console.assert(cmt.post.comments.some((c) => c.txt === "自检评"));
  console.assert(listMoments().posts.some((p) => p.id === id));
  const imgOnly = createPost({
    text: "",
    images: ["/api/v1/chat/media/selfcheck.png"],
  });
  console.assert(imgOnly.ok && imgOnly.post.images.length === 1);
  const delImg = deletePost(imgOnly.post.id);
  console.assert(delImg.ok);
  const pending = enqueuePending("post", { txt: "待确认发" }, { peerId: "daily" });
  console.assert(pending.needs_confirm && pending.pending_id);
  const confirmed = confirmPending(pending.pending_id);
  console.assert(confirmed.post && confirmed.post.author === "bot");
  deletePost(confirmed.post.id, { asBot: true });
  const auto = runMomentsAi(
    "post",
    { text: stamp + "-ai" },
    { mode: "auto", botName: "家机" }
  );
  console.assert(auto.ok && auto.post && auto.post.author === "bot");
  deletePost(auto.post.id, { asBot: true });
  const del = deletePost(id);
  console.assert(del.ok);
  console.assert(!listMoments().posts.some((p) => p.id === id));
  console.log("moments selfcheck ok");
}
