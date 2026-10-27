/**
 * 额度 App。主列表合计；··· 子页 = 账户余额 + 价卡（非弹窗）。
 */
(function (global) {
  let deps = { showView: function () {} };
  let bound = false;
  let lastSummary = null;
  let pane = "home";

  function $(id) {
    return document.getElementById(id);
  }

  function fmtRmb(n) {
    const x = Number(n) || 0;
    return "¥" + x.toFixed(2);
  }

  function fmtTokens(n) {
    const x = Math.max(0, Math.floor(Number(n) || 0));
    if (x >= 10000) return (x / 10000).toFixed(1).replace(/\.0$/, "") + " 万 token";
    return x + " token";
  }

  function showPane(name) {
    pane = name === "more" ? "more" : "home";
    const home = $("budHome");
    const more = $("budMore");
    const homeBar = $("budHomeBar");
    const moreBar = $("budMoreBar");
    if (home) home.classList.toggle("on", pane === "home");
    if (more) more.classList.toggle("on", pane === "more");
    if (homeBar) homeBar.hidden = pane !== "home";
    if (moreBar) moreBar.hidden = pane !== "more";
  }

  function renderRate(rate) {
    if (!rate) return "";
    const lab = rate.label || rate.model || "模型";
    const period = rate.period_lab || "";
    const perM = Number(rate.rmb_per_m_token) || 0;
    const off = rate.off || {};
    const fb = rate.fallback ? " · 无匹配卡，暂用 " + rate.model : "";
    const lines = [
      lab + " · 当前" + period + "混合约 " + perM + " 元/百万" + fb,
      "闲时 入未命中 " +
        (off.in_miss != null ? off.in_miss : "—") +
        " / 命中 " +
        (off.in_hit != null ? off.in_hit : "—") +
        " / 输出 " +
        (off.out != null ? off.out : "—") +
        (rate.peak_auto === false ? " · 高峰另设" : " · 高峰×2"),
    ];
    if (rate.blend && rate.blend.note) lines.push(rate.blend.note);
    return lines.join(" · ");
  }

  function renderBalance(bal) {
    const el = $("budBalance");
    if (!el) return;
    if (!bal) {
      el.textContent = "账户余额：—";
      return;
    }
    if (!bal.ok) {
      el.textContent = "账户余额：未取到（" + (bal.message || bal.error || "失败") + "）";
      return;
    }
    const cur = bal.currency || "";
    const total = bal.total_balance || "—";
    const grant = bal.granted_balance;
    const top = bal.topped_up_balance;
    let extra = "";
    if (grant != null && top != null) {
      extra = " · 赠送 " + grant + " · 充值 " + top;
    }
    el.textContent =
      "账户余额 " + cur + " " + total + extra + (bal.is_available ? "" : " · 余额可能不足");
  }

  function findCard(data, id) {
    return (data.cards || []).find((c) => c.id === id) || null;
  }

  function applyCardToInputs(card) {
    if (!card) return;
    const off = card.off || {};
    const miss = $("budInMiss");
    const hit = $("budInHit");
    const out = $("budOut");
    const peakAuto = $("budPeakAuto");
    if (miss) miss.value = off.in_miss != null ? off.in_miss : "";
    if (hit) hit.value = off.in_hit != null ? off.in_hit : "";
    if (out) out.value = off.out != null ? off.out : "";
    if (peakAuto) peakAuto.checked = card.peak_auto !== false;
  }

  function fillRateForm(data) {
    const sel = $("budRateModel");
    if (!sel) return;
    const cards = data.cards || [];
    const active = (data.rate && data.rate.model) || data.llm_model || "";
    sel.replaceChildren();
    for (const c of cards) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = (c.label || c.id) + " (" + c.id + ")";
      if (c.id === active) opt.selected = true;
      sel.append(opt);
    }
    if (active && ![...sel.options].some((o) => o.value === active)) {
      const opt = document.createElement("option");
      opt.value = active;
      opt.textContent = active;
      opt.selected = true;
      sel.append(opt);
    }
    applyCardToInputs(findCard(data, sel.value) || (data.rate && data.rate));
  }

  async function refresh() {
    const list = $("budAppList");
    const rmbEl = $("budTotalRmb");
    const metaEl = $("budTotalMeta");
    const foot = $("budFoot");
    const rateEl = $("budRate");
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await fetch("/api/v1/budget/summary", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "读取失败");
      lastSummary = data;
      if (rmbEl) rmbEl.textContent = fmtRmb(data.rmb);
      if (metaEl) {
        const period = (data.rate && data.rate.period_lab) || "";
        const model = data.llm_model || (data.rate && data.rate.model) || "";
        metaEl.textContent =
          fmtTokens(data.tokens_used) +
          (period ? " · 按" + period + "价" : "") +
          (model ? " · " + model : "");
      }
      renderBalance(data.balance);
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
      if (rateEl) rateEl.textContent = renderRate(data.rate);
      fillRateForm(data);
      const docs = $("budDocsLink");
      if (docs && data.rate && data.rate.source) docs.href = data.rate.source;
      if (foot) {
        const cap =
          Number(data.default_budget_rmb) > 0
            ? "默认场预算约 ¥" + Number(data.default_budget_rmb).toFixed(2)
            : "默认场预算：不限";
        foot.textContent = cap + " · 价卡与余额在右上角 ···";
      }
    } catch (e) {
      if (rmbEl) rmbEl.textContent = "—";
      if (metaEl) metaEl.textContent = (e && e.message) || "加载失败";
      if (rateEl) rateEl.textContent = "";
      if (foot) foot.textContent = "";
      renderBalance(null);
    }
  }

  async function saveRates() {
    const msg = $("budRateMsg");
    const sel = $("budRateModel");
    const model = sel && sel.value;
    if (!model) {
      if (msg) msg.textContent = "无模型";
      return;
    }
    const body = {
      model: model,
      peak_auto: !!($("budPeakAuto") || {}).checked,
      off: {
        in_miss: Number($("budInMiss").value),
        in_hit: Number($("budInHit").value),
        out: Number($("budOut").value),
      },
    };
    if (msg) msg.textContent = "保存中…";
    try {
      const res = await fetch("/api/v1/budget/rates", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "保存失败");
      if (msg) msg.textContent = "已保存";
      await refresh();
    } catch (e) {
      if (msg) msg.textContent = (e && e.message) || "保存失败";
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const back = $("btnBudgetBack");
    if (back) {
      back.addEventListener("click", () => {
        if (pane === "more") {
          showPane("home");
          return;
        }
        deps.showView("home");
      });
    }
    const more = $("btnBudgetMore");
    if (more) {
      more.addEventListener("click", () => {
        showPane("more");
        refresh();
      });
    }
    const moreBack = $("btnBudgetMoreBack");
    if (moreBack) moreBack.addEventListener("click", () => showPane("home"));
    const save = $("budSaveRates");
    if (save) save.addEventListener("click", () => saveRates());
    const sel = $("budRateModel");
    if (sel) {
      sel.addEventListener("change", () => {
        if (!lastSummary) return;
        applyCardToInputs(findCard(lastSummary, sel.value));
      });
    }
  }

  function mount(d) {
    deps = Object.assign(deps, d || {});
    bind();
    showPane("home");
  }

  function onShow() {
    showPane("home");
    refresh();
  }

  global.BudgetApp = {
    mount: mount,
    onShow: onShow,
    refresh: refresh,
  };
})(typeof window !== "undefined" ? window : globalThis);
