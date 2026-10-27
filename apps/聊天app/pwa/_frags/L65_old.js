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
    await markChatRead();
    box.replaceChildren();
    lastTimeBucket = -1;