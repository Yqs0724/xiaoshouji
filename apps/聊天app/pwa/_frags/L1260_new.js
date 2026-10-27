  function openHist() {
    const hist = document.getElementById("chatHist");
    if (!hist) return;
    setPanels(null);
    dismissKeyboard();
    hist.hidden = false;
    histKind = "all";
    histDay = "";
    paintHistGrid();
    const q = document.getElementById("chatHistQ");
    if (q) q.value = "";
    showHistHome();
  }

  function closeHist(opts) {
    const hist = document.getElementById("chatHist");
    if (hist) hist.hidden = true;
    if (histTimer) {
      clearTimeout(histTimer);
      histTimer = null;
    }
    if (opts && opts.skipReturn) {
      histReturnTo = null;
      return;
    }
    const ret = histReturnTo;
    histReturnTo = null;
    if (ret === "peer") openPeerPage();
  }