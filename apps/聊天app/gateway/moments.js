/**
 * 朋友圈本地时间线（H1.2 / H1.11′ / H1.12）：发/赞/评/删/分享范围(可指定谁)/图；非公开社交。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const MOMENTS_PATH = path.join(DATA_DIR, "moments.json");
const TEXT_MAX = 200;
const CMT_MAX = 80;
const IMG_MAX = 9;
const LIKE_WHO = "你";
const SCOPES = new Set(["public", "private", "partial"]);
/* 现有联系人 id；多 peer 后再扩 */
const PEER_IDS = new Set(["bot"]);

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MOMENTS_PATH)) {
    fs.writeFileSync(
      MOMENTS_PATH,
      JSON.stringify({ posts: [] }, null, 2),
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
    return { posts };
  } catch (_) {
    return { posts: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(
    MOMENTS_PATH,
    JSON.stringify({ posts: Array.isArray(data.posts) ? data.posts : [] }, null, 2),
    "utf8"
  );
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
  const txt = String(raw.txt || raw.text || "").trim().slice(0, TEXT_MAX);
  const images = normalizeImages(raw.images || raw.imgs);
  if (!txt && !images.length) return null;
  const author = raw.author === "bot" ? "bot" : "you";
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

function createPost(patch) {
  const txt = String((patch && (patch.txt || patch.text)) || "").trim().slice(0, TEXT_MAX);
  const images = normalizeImages(patch && (patch.images || patch.imgs));
  if (!txt && !images.length) {
    const err = new Error("写点文字或加一张图");
    err.code = "empty_text";
    throw err;
  }
  const author = (patch && patch.author) === "bot" ? "bot" : "you";
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

function findPost(all, id) {
  const sid = String(id || "");
  return all.posts.find((p) => p && p.id === sid) || null;
}

function deletePost(postId) {
  const all = readAll();
  const post = findPost(all, postId);
  if (!post) {
    const err = new Error("动态不存在");
    err.code = "not_found";
    throw err;
  }
  if (post.author !== "you") {
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

module.exports = {
  listMoments,
  createPost,
  deletePost,
  updatePost,
  toggleLike,
  addComment,
  MOMENTS_PATH,
};

if (require.main === module) {
  const stamp = "moments-selfcheck-" + Date.now();
  const created = createPost({ text: stamp, scope: "private" });
  console.assert(created.ok && created.post && created.post.txt === stamp);
  console.assert(created.post.scope === "private");
  const id = created.post.id;
  const scoped = updatePost(id, { scope: "public" });
  console.assert(scoped.post.scope === "public");
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
  const del = deletePost(id);
  console.assert(del.ok);
  console.assert(!listMoments().posts.some((p) => p.id === id));
  console.log("moments selfcheck ok");
}
