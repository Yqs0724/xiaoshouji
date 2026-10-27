  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  global.ChatApp = {
    mount: mount,
    refreshThread: refreshChatThread,
  };
})(typeof window !== "undefined" ? window : globalThis);