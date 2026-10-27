  async function recallChatMessageUi(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    setComposerBusy(true);
    let botBubble = null;
    let pendingToolRow = null;
    const paintFrame = () =>
      new Promise((r) => requestAnimationFrame(() => r()));
    try {
      const res = await fetch(
        "/api/v1/chat/messages/" + encodeURIComponent(sid) + "/recall",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "text/event-stream" },
        }
      );
      const ctype = String(res.headers.get("content-type") || "");
      if (!res.ok && !ctype.includes("event-stream")) {
        let data = {};
        try {
          data = await res.json();
        } catch (_) {
          data = {};
        }
        if (res.status === 404) throw new Error("接口未就绪：请重启 npm start");
        throw new Error(data.message || "撤回失败");
      }
      if (!res.body || !res.body.getReader) {
        throw new Error("浏览器不支持流式读取");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let already = false;
      const handleEvent = async (ev) => {
        if (!ev || !ev.type) return;
        if (ev.type === "you_recall" && ev.message) {
          already = !!ev.already;
          patchMessageBubble(ev.message);
          shellToast(already ? "已撤回过" : "已撤回");
          await paintFrame();
        } else if (ev.type === "bot_start") {
          pendingThink = { sec: 0, text: "" };
          thinkAttached = false;
          setTyping(true);
          await paintFrame();
        } else if (ev.type === "bot_think") {
          if (ev.text) {
            pendingThink.text = pendingThink.text
              ? pendingThink.text + "\n---\n" + ev.text
              : String(ev.text);
          }
          if (Number(ev.seconds) > 0) pendingThink.sec += Number(ev.seconds);
          if (botBubble) {
            ensureBunnyThink(botBubble, {
              think: pendingThink.text,
              think_sec: pendingThink.sec,
            });
          }
          await paintFrame();
        } else if (ev.type === "bot_tool" && ev.name) {
          pendingToolRow = appendToolChip(ev.name, ev.label);
          await paintFrame();
        } else if (ev.type === "bot_tool_done") {
          const row = finishToolChip(pendingToolRow, ev);
          if (row && ev.message && ev.message.id) row.dataset.msgId = ev.message.id;
          pendingToolRow = null;
          await paintFrame();
        } else if (ev.type === "bot_delta" && ev.text) {
          if (!botBubble) {
            setTyping(true);
            botBubble = appendChatBubble(
              "bot",
              "",
              Date.now(),
              takePendingThinkForFirstBubble()
            );
          }
          appendBubbleDelta(botBubble, ev.text);
          await paintFrame();
        } else if (ev.type === "bot_done" && ev.message) {
          setTyping(false);
          if (botBubble) patchMessageBubble(ev.message);
          else appendChatMessage(ev.message);
          botBubble = null;
          await paintFrame();
        } else if (ev.type === "bot_sticker" && ev.message) {
          appendChatMessage(ev.message);
          await paintFrame();
        } else if (ev.type === "bot_money" && ev.message) {
          appendChatMessage(ev.message);
          await paintFrame();
        } else if (ev.type === "bot_error") {
          setTyping(false);
          setChatErr(ev.message || "家机暂时接不上");
        } else if (ev.type === "done") {
          setTyping(false);
          if (ev.skip_reason === "mood_cold") {
            /* 冷战不回：保持安静，不 toast */
          }
        }
      };
      const consumeBlock = async (part) => {
        const lines = String(part || "").split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evObj = null;
          try {
            evObj = JSON.parse(raw);
          } catch (_) {
            continue;
          }
          await handleEvent(evObj);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() || "";
        for (const part of parts) await consumeBlock(part);
      }
      if (buf.trim()) await consumeBlock(buf);
      if (chatViewActive()) await markChatRead();
      else notifyUnread();
    } catch (err) {
      setTyping(false);
      shellToast((err && err.message) || "撤回失败");
    } finally {
      setTyping(false);
      setComposerBusy(false);
    }
  }