/**
 * 资产 App：壳只开洞，UI 原样为 pwa/wealth.html（双钥 DEMO）。
 * 回桌面：iframe postMessage { type: "ariadne-wallet-home" }
 */
(function (global) {
  let deps = { showView: function () {} };
  let bound = false;

  function onMessage(ev) {
    const d = ev && ev.data;
    if (!d || d.type !== "ariadne-wallet-home") return;
    deps.showView("home");
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    if (!bound) {
      bound = true;
      window.addEventListener("message", onMessage);
    }
  }

  function onShow() {
    const frame = document.getElementById("walletFrame");
    if (!frame) return;
    const want = "/app-ui/资产app/pwa/wealth.html?v=w7";
    if ((frame.getAttribute("src") || "").indexOf("v=w7") < 0) {
      frame.src = want;
    }
  }

  global.WalletApp = { mount, onShow };
})(typeof window !== "undefined" ? window : global);
