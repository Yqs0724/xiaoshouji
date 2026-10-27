  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  global.ChatApp = {
    mount: mount,
    onShow: onShowChatShell,
    refreshThread: refreshChatThread,
  };
})(typeof window !== "undefined" ? window : globalThis);