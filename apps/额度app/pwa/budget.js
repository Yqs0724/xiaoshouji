/**
 * 额度 App 前端。DOM 由壳注入 view.html。
 */
(function (global) {
  let deps = { showView: function () {} };
  let bound = false;

  function fmtRmb(n) {
    const x = Number(n) || 0;
    return "¥" + x.toFixed(2);
  }

  function fmtTokens(n) {
    const x = Math.max(0, Math.floor(Number(n) || 0));
    if (x >= 10000) return (x / 10000).toFixed(1).replace(/\.0$/, "") + " 万 token";
    return x + " token";
  }

  async function refresh() {
    const list = document.getElementById("budAppList");
    const rmbEl = document.getElementById("budTotalRmb");
    const metaEl = document.getElementById("budTotalMeta");
    const foot = document.getElementById("budFoot");
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await fetch("/api/v1/budget/summary", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      if (rmbEl) rmbEl.textContent = fmtRmb(data.rmb);
      if (metaEl) metaEl.textContent = fmtTokens(data.tokens_used);
      for (const app of data.apps || []) {
        const li = document.createElement("li");
        const name = document.createElement("div");
        name.className = "name";
        name.append(document.createTextNode(app.lab || app.id));
        if (app.note) {
          const sm = document.createElement("small");
          sm.textContent = app.note;
          name.append(sm);
        }
        const amt = document.createElement("div");
        amt.className = "amt";
        amt.append(document.createTextNode(fmtRmb(app.rmb)));
        const sm2 = document.createElement("small");
        sm2.textContent = fmtTokens(app.tokens_used);
        amt.append(sm2);
        li.append(name, amt);
        list.append(li);
      }
      if (foot) {
        const rate = (data.rate && data.rate.rmb_per_m_token) || 2.5;
        const cap =
          Number(data.default_budget_rmb) > 0
            ? "默认场预算约 ¥" + Number(data.default_budget_rmb).toFixed(2)
            : "默认场预算：不限";
        foot.textContent =
          "粗算 " + rate + " 元/百万 token · " + cap + " · 改档与流水以后再接";
      }
    } catch (e) {
      if (rmbEl) rmbEl.textContent = "—";
      if (metaEl) metaEl.textContent = (e && e.message) || "加载失败";
      if (foot) foot.textContent = "";
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const back = document.getElementById("btnBudgetBack");
    if (back) back.addEventListener("click", () => deps.showView("home"));
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
  }

  function onShow() {
    refresh();
  }

  global.BudgetApp = {
    mount: mount,
    onShow: onShow,
    refresh: refresh,
  };
})(typeof window !== "undefined" ? window : globalThis);
