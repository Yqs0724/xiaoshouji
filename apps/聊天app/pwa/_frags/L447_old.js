  async function recallChatMessageUi(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" + encodeURIComponent(sid) + "/recall",
        { method: "POST", credentials: "same-origin" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404) throw new Error("接口未就绪：请重启 npm start");
        throw new Error(data.message || "撤回失败");
      }
      if (data.message) patchMessageBubble(data.message);
      shellToast(data.already ? "已撤回过" : "已撤回");
    } catch (err) {
      shellToast((err && err.message) || "撤回失败");
    }
  }