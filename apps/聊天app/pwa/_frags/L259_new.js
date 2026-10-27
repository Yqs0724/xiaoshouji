  function searchPlaceholderForCat(cat) {
    if (cat === "chat") return "搜聊天记录";
    if (cat === "contacts") return "搜联系人";
    if (cat === "moments") return "搜朋友圈";
    return "搜索";
  }

  function paintSearchEmpty() {
    const box = document.getElementById("chatShellSearchHits");
    const qEl = document.getElementById("chatShellSearchQ");
    if (qEl) qEl.placeholder = searchPlaceholderForCat(shellSearchCat);
    if (!box) return;
    const cats = [
      { id: "chat", lab: "聊天记录" },
      { id: "contacts", lab: "联系人" },
      { id: "moments", lab: "朋友圈" },
    ];
    const catRow = `<div class="chat-search-cats">${cats
      .map(
        (c) =>
          `<button type="button" class="chat-search-cat${
            shellSearchCat === c.id ? " on" : ""
          }" data-search-cat="${c.id}">${c.lab}</button>`
      )
      .join("")}</div>`;
    if (shellSearchCat) {
      box.innerHTML =
        catRow +
        `<p class="chat-hint-line">输入关键词搜索${
          shellSearchCat === "chat"
            ? "聊天记录"
            : shellSearchCat === "contacts"
              ? "联系人"
              : "朋友圈"
        }</p>`;
    } else {
      box.innerHTML =
        catRow + `<p class="chat-hint-line">输入关键词 · 或先选一类</p>`;
    }
  }

  function matchContactHits(qq) {
    const peer = deps.getPeerName() || "家机";
    const keys = [peer, "家机", "同居"];
    if (!keys.some((k) => k.toLowerCase().includes(qq) || qq.includes(k.toLowerCase()))) {
      /* 子串：查询落在名字里 */
      const hit = keys.some((k) => String(k).toLowerCase().includes(qq));
      if (!hit && !peer.toLowerCase().includes(qq) && qq !== "家") return [];
    }
    if (
      !peer.toLowerCase().includes(qq) &&
      !String("家机").includes(qq) &&
      qq.length > 0 &&
      !["家", "机", "家机"].some((k) => k.includes(qq) || qq.includes(k))
    ) {
      /* 宽松：名字包含查询，或查询包含名字片段 */
      const pl = peer.toLowerCase();
      if (!pl.includes(qq) && !qq.includes(pl) && !pl.includes(qq.slice(0, 1))) {
        return [];
      }
    }
    const pl = peer.toLowerCase();
    if (!(pl.includes(qq) || qq.includes(pl) || "家机".includes(qq) || qq.includes("家"))) {
      return [];
    }
    return [{ name: peer, sub: "联系人 · 同居日常" }];
  }

  function matchMomentHits(qq) {
    const posts = Array.isArray(momPosts) ? momPosts : [];
    const out = [];
    for (const p of posts) {
      const blob = String((p && p.txt) || "") + " " + String((p && p.name) || "");
      if (blob.toLowerCase().includes(qq)) out.push(p);
      if (out.length >= 20) break;
    }
    return out;
  }

  async function runShellSearch(q) {
    const box = document.getElementById("chatShellSearchHits");
    if (!box) return;
    const qq = String(q || "").trim().toLowerCase();
    if (!qq) {
      paintSearchEmpty();
      return;
    }
    const wantChat = !shellSearchCat || shellSearchCat === "chat";
    const wantContacts = !shellSearchCat || shellSearchCat === "contacts";
    const wantMoments = !shellSearchCat || shellSearchCat === "moments";

    let chatHits = [];
    if (wantChat) {
      try {
        const params = new URLSearchParams();
        params.set("q", String(q || "").trim());
        params.set("kind", "all");
        const res = await fetch("/api/v1/chat/search?" + params.toString(), {
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        chatHits = Array.isArray(data.messages) ? data.messages : [];
      } catch (_) {
        chatHits = [];
      }
    }

    if (wantMoments && !(momPosts && momPosts.length)) {
      try {
        await refreshMoments();
      } catch (_) {}
    }

    const contactHits = wantContacts ? matchContactHits(qq) : [];
    const momentHits = wantMoments ? matchMomentHits(qq) : [];

    const parts = [];
    if (wantContacts) {
      parts.push(`<div class="chat-sec-lab">联系人</div>`);
      if (!contactHits.length) {
        parts.push(`<p class="chat-hint-line">无联系人</p>`);
      } else {
        for (const c of contactHits) {
          parts.push(
            `<button type="button" class="chat-hit-item" data-jump-contact="1">
              <div><div class="t">${escapeHtml(c.name)}</div><div class="meta">${escapeHtml(c.sub)}</div></div>
            </button>`
          );
        }
      }
    }
    if (wantMoments) {
      parts.push(`<div class="chat-sec-lab">朋友圈</div>`);
      if (!momentHits.length) {
        parts.push(`<p class="chat-hint-line">无动态</p>`);
      } else {
        for (const p of momentHits) {
          parts.push(
            `<button type="button" class="chat-hit-item" data-jump-mom="${escapeHtml(p.id)}">
              <div><div class="t">${escapeHtml(p.txt || "")}</div><div class="meta">${escapeHtml(
                (p.name || "家机") + " · " + (p.time || "")
              )}</div></div>
            </button>`
          );
        }
      }
    }
    if (wantChat) {
      parts.push(`<div class="chat-sec-lab">聊天记录</div>`);
      if (!chatHits.length) {
        parts.push(`<p class="chat-hint-line">无聊天记录</p>`);
      } else {
        for (const m of chatHits.slice(0, 40)) {
          const preview = histPreview(m);
          const meta = sessTimeLabel(m.ts);
          const mid = m && m.id ? String(m.id) : "";
          parts.push(
            `<button type="button" class="chat-hit-item" data-jump-msg="${escapeHtml(mid)}">
              <div><div class="t">${escapeHtml(preview)}</div><div class="meta">${escapeHtml(meta)}</div></div>
            </button>`
          );
        }
      }
    }

    const any =
      contactHits.length || momentHits.length || chatHits.length;
    if (!any) {
      box.innerHTML = `<p class="chat-hint-line">无结果</p>`;
      return;
    }
    box.innerHTML = parts.join("");
  }
