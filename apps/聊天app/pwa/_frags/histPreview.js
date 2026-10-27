  function histPreview(m) {
    if (!m) return "";
    if (m.recalled) return m.from === "bot" ? "对方撤回了一条消息" : "你撤回了一条消息";
    const p = m.payload || {};