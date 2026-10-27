  function paintMomPost(raw) {
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const you = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const peer = deps.getPeerName() || "家机";
    const author = raw.author === "bot" ? "bot" : "you";
    const likes = Array.isArray(raw.likes) ? raw.likes.slice() : [];
    const images = Array.isArray(raw.images)
      ? raw.images.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 9)
      : [];
    return {
      id: String(raw.id || ""),
      author,
      name: raw.name || (author === "bot" ? peer : "你"),
      av: author === "bot" ? bot : you,
      txt: String(raw.txt || ""),
      images,
      scope: raw.scope === "private" ? "private" : "public",
      time: momRelTime(raw.ts),
      liked: likes.indexOf("你") >= 0,
      likes,
      comments: Array.isArray(raw.comments)
        ? raw.comments.map((c) => ({
            who: c.who || "你",
            txt: c.txt || "",
          }))
        : [],
    };
  }

  function momImgsHtml(images) {
    const list = Array.isArray(images) ? images : [];
    if (!list.length) return "";
    const n = Math.min(9, list.length);
    return (
      `<div class="chat-post-imgs n${n}">` +
      list
        .slice(0, 9)
        .map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy" />`)
        .join("") +
      `</div>`
    );
  }

  function momOwnFootHtml(p) {
    if (!p || p.author !== "you") return "";
    const priv = p.scope === "private";
    return `<div class="chat-post-foot">
      <button type="button" class="chat-post-ico" data-mom-del="${escapeHtml(p.id)}" aria-label="删除" title="删除">${SVG_MOM_TRASH}</button>
      <button type="button" class="chat-post-ico ${priv ? "is-private" : ""}" data-mom-scope="${escapeHtml(p.id)}" aria-label="分享范围" title="分享范围">${priv ? SVG_MOM_PRIVATE : SVG_MOM_PUBLIC}</button>
      <span class="chat-post-scope-lab">${priv ? "仅自己" : "公开"}</span>
    </div>`;
  }

  function resetComposeDraft() {
    composeDraft = { images: [], scope: "public" };
    const ta = document.getElementById("chatComposeTxt");
    if (ta) ta.value = "";
    paintComposeDraft();
  }

  function paintComposeDraft() {
    const box = document.getElementById("chatComposeImgs");
    const lab = document.getElementById("chatComposeScopeLab");
    if (lab) lab.textContent = composeDraft.scope === "private" ? "仅自己" : "公开";
    if (!box) return;
    const imgs = composeDraft.images || [];
    if (!imgs.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = imgs
      .map(
        (u, i) =>
          `<div class="chat-compose-thumb"><img src="${escapeHtml(u)}" alt="" /><button type="button" class="x" data-compose-rm="${i}" aria-label="去掉">×</button></div>`
      )
      .join("");
  }

  async function uploadComposeImage(file) {
    if (!file) return null;
    const res = await fetch("/api/v1/chat/media", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || "上传失败");
    if (!data.url) throw new Error("上传失败");
    return data.url;
  }

  async function deleteMomentUi(id) {
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id), {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "删除失败");
      await refreshMoments();
      shellToast("已删除");
    } catch (err) {
      shellToast((err && err.message) || "删除失败");
    }
  }

  async function toggleMomentScopeUi(id) {
    const cur = (momPosts || []).find((p) => p.id === id);
    const next = cur && cur.scope === "private" ? "public" : "private";
    try {
      const res = await fetch("/api/v1/moments/" + encodeURIComponent(id), {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "改范围失败");
      await refreshMoments();
      shellToast(next === "private" ? "仅自己可见" : "公开");
    } catch (err) {
      shellToast((err && err.message) || "改范围失败");
    }
  }