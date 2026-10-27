  function threadLayerOpen() {
    const layer = document.getElementById("chatThreadLayer");
    return !!(layer && layer.classList.contains("active"));
  }

  function closeThreadLayer() {
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    layer.classList.remove("active");
    layer.hidden = true;
    closeHist();
    setPanels(null);
    setTyping(false);
    refreshSessionList();
  }

  function openThreadLayer() {
    closeShellOverlays();
    const layer = document.getElementById("chatThreadLayer");
    if (!layer) return;
    layer.hidden = false;
    layer.classList.add("active");
    refreshChatThread();
  }

  function shellToast(msg) {
    const el = document.getElementById("chatShellToast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(shellToastTimer);
    shellToastTimer = setTimeout(() => {
      el.hidden = true;
    }, 1700);
  }

  function closeShellOverlays() {
    document.querySelectorAll("#view-chat .chat-overlay").forEach((el) => {
      el.classList.remove("active");
      el.hidden = true;
    });
  }

  function openShellOverlay(id) {
    closeThreadLayer();
    document.querySelectorAll("#view-chat .chat-overlay").forEach((el) => {
      const on = el.id === id;
      el.classList.toggle("active", on);
      el.hidden = !on;
    });
  }

  function goChatTab(name) {
    closeShellOverlays();
    closeThreadLayer();
    document.querySelectorAll("#view-chat .chat-tab").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-chat-tab") === name);
    });
    document.querySelectorAll("#view-chat .chat-dock [data-chat-go]").forEach((b) => {
      b.classList.toggle("on", b.getAttribute("data-chat-go") === name);
    });
  }

  function sessTimeLabel(ts) {
    const d = new Date(Number(ts) || Date.now());
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes());
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yest.getFullYear() &&
      d.getMonth() === yest.getMonth() &&
      d.getDate() === yest.getDate()
    ) {
      return "昨天";
    }
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  async function fetchUnreadCount() {
    try {
      const res = await fetch("/api/v1/chat/unread", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return 0;
      return Math.max(0, Math.floor(Number(data.count) || 0));
    } catch (_) {
      return 0;
    }
  }

  function paintShellUnread(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const badge = document.getElementById("chatSessBadge");
    const dot = document.getElementById("chatDockDot");
    if (badge) {
      if (n > 0) {
        badge.hidden = false;
        badge.textContent = n > 99 ? "99+" : String(n);
      } else {
        badge.hidden = true;
      }
    }
    if (dot) dot.hidden = n <= 0;
  }

  function syncShellAvatars() {
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const you = deps.getAvatarYou() || "/assets/cafe/avatar-you.png";
    const peer = deps.getPeerName() || "家机";
    [
      ["chatSessAv", bot],
      ["chatContactAv", bot],
      ["chatProfileAv", bot],
      ["chatMomYouAv", you],
      ["chatMeAv", you],
    ].forEach(([id, src]) => {
      const el = document.getElementById(id);
      if (el) el.src = src;
    });
    ["chatSessName", "chatContactName", "chatProfileName"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = peer;
    });
  }

  async function refreshSessionList() {
    syncShellAvatars();
    const preview = document.getElementById("chatSessPreview");
    const timeEl = document.getElementById("chatSessTime");
    try {
      const msgs = await fetchChatMessages();
      if (!msgs.length) {
        if (preview) preview.textContent = "还没有短讯";
        if (timeEl) timeEl.textContent = "";
      } else {
        const last = msgs[msgs.length - 1];
        if (preview) preview.textContent = histPreview(last) || "…";
        if (timeEl) timeEl.textContent = sessTimeLabel(last.ts || last.created_at);
      }
    } catch (_) {
      if (preview) preview.textContent = "加载失败";
    }
    paintShellUnread(await fetchUnreadCount());
  }

  function ensureMomPosts() {
    if (momPosts) return momPosts;
    const bot = deps.getAvatarBot() || "/assets/cafe/avatar-bot.png";
    const peer = deps.getPeerName() || "家机";
    momPosts = [
      {
        id: 1,
        name: peer,
        av: bot,
        txt: "今日份薄巧：窗台晒到一半的薄荷叶，和没写完的日历便签。",
        time: "2小时前",
        liked: true,
        likes: ["你"],
        comments: [{ who: "你", txt: "叶子别晒焦了" }],
      },
      {
        id: 2,
        name: peer,
        av: bot,
        txt: "正式朋友圈：本地时间线示意；落库后置。",
        time: "昨天",
        liked: false,
        likes: [],
        comments: [],
      },
    ];
    return momPosts;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  function renderMomFeed() {
    const feed = document.getElementById("chatMomFeed");
    if (!feed) return;
    const posts = ensureMomPosts();
    feed.innerHTML = posts
      .map((p) => {
        const likes = p.likes.length
          ? `<div class="chat-post-likes">${p.likes.map(escapeHtml).join("、")}</div>`
          : "";
        const cmts = p.comments.length
          ? `<div class="chat-post-comments">${p.comments
              .map(
                (c) =>
                  `<div class="c"><b>${escapeHtml(c.who)}</b> ${escapeHtml(c.txt)}</div>`
              )
              .join("")}</div>`
          : "";
        return `<article class="chat-post" data-id="${p.id}">
          <div class="chat-post-h">
            <img class="chat-post-av" src="${p.av}" alt="" />
            <div class="chat-post-main">
              <div class="chat-post-name">${escapeHtml(p.name)}</div>
              <div class="chat-post-txt">${escapeHtml(p.txt)}</div>
              <div class="chat-post-meta">
                <span>${escapeHtml(p.time)}</span>
                <span class="chat-post-acts">
                  <button type="button" class="chat-post-act ${p.liked ? "on" : ""}" data-mom-like="${p.id}">赞</button>
                  <button type="button" class="chat-post-act" data-mom-cmt="${p.id}">评</button>
                </span>
              </div>
              ${likes}
              ${cmts}
              <div class="chat-cmt-row" data-mom-cmt-row="${p.id}">
                <input type="text" maxlength="80" placeholder="评论…" />
                <button type="button" data-mom-cmt-send="${p.id}">发送</button>
              </div>
            </div>
          </div>
        </article>`;
      })
      .join("");
  }

  function renderFavList() {
    const box = document.getElementById("chatFavList");
    if (!box) return;
    box.innerHTML = shellFavs
      .map(
        (f) =>
          `<button type="button" class="chat-fav-item">
            <div><div class="t">${escapeHtml(f.t)}</div><div class="meta">${escapeHtml(f.meta)}</div></div>
          </button>`
      )
      .join("");
    box.querySelectorAll(".chat-fav-item").forEach((el) => {
      el.addEventListener("click", () => shellToast("正式可跳回原消息"));
    });
  }

  async function runShellSearch(q) {
    const box = document.getElementById("chatShellSearchHits");
    if (!box) return;
    const qq = String(q || "").trim();
    try {
      const params = new URLSearchParams();
      if (qq) params.set("q", qq);
      params.set("kind", "all");
      const res = await fetch("/api/v1/chat/search?" + params.toString(), {
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      const hits = Array.isArray(data.messages) ? data.messages : Array.isArray(data.hits) ? data.hits : [];
      if (!hits.length) {
        box.innerHTML = `<p class="chat-hint-line">无结果</p>`;
        return;
      }
      box.innerHTML = hits
        .slice(0, 40)
        .map((m) => {
          const preview = histPreview(m);
          const meta = sessTimeLabel(m.ts || m.created_at);
          return `<button type="button" class="chat-hit-item" data-open-thread="1">
            <div><div class="t">${escapeHtml(preview)}</div><div class="meta">${escapeHtml(meta)}</div></div>
          </button>`;
        })
        .join("");
      box.querySelectorAll("[data-open-thread]").forEach((el) => {
        el.addEventListener("click", () => openThreadLayer());
      });
    } catch (_) {
      box.innerHTML = `<p class="chat-hint-line">搜索失败</p>`;
    }
  }

  function onShowChatShell() {
    goChatTab("chat");
    refreshSessionList();
    renderMomFeed();
  }

  async function refreshChatThread() {
    const box = document.getElementById("chatThread");
    if (!box) return;
    closeHist();
    setPanels(null);
    setTyping(false);
    const peer = document.getElementById("chatPeerName");
    if (peer) {
      peer.classList.remove("is-typing");
      delete peer.dataset.peerName;
      peer.textContent = deps.getPeerName() || "家机";
    }
    const clearRead = document.getElementById("chatTogRead");
    if (!clearRead || clearRead.classList.contains("on")) {
      await markChatRead();
      paintShellUnread(0);
    }
    box.replaceChildren();
    lastTimeBucket = -1;