/**
 * DeepSeek 账户余额：GET /user/balance（官方有；价表没有）。
 * 非 deepseek 基址会先试本基址，再回落 api.deepseek.com（同 Key 时）。
 */

function apiRoot(base) {
  let b = String(base || "").trim().replace(/\/$/, "");
  if (!b) return "https://api.deepseek.com";
  if (b.endsWith("/chat/completions")) b = b.slice(0, -"/chat/completions".length);
  if (b.endsWith("/v1")) b = b.slice(0, -"/v1".length);
  return b.replace(/\/$/, "") || "https://api.deepseek.com";
}

/**
 * @param {{ llm_base?: string, llm_key?: string }} settings
 * @returns {Promise<object>}
 */
async function fetchUserBalance(settings) {
  const key = String((settings && settings.llm_key) || "").trim();
  if (!key) {
    return { ok: false, error: "no_key", message: "未配置 LLM Key" };
  }
  const root = apiRoot(settings && settings.llm_base);
  const urls = [root + "/user/balance"];
  if (!/deepseek\.com/i.test(root)) {
    urls.push("https://api.deepseek.com/user/balance");
  }
  let lastErr = "余额查询失败";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        lastErr =
          (data && data.error && (data.error.message || data.error)) ||
          (data && data.message) ||
          "HTTP " + res.status;
        continue;
      }
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const cny = infos.find((x) => String(x.currency || "").toUpperCase() === "CNY");
      const usd = infos.find((x) => String(x.currency || "").toUpperCase() === "USD");
      const pick = cny || usd || infos[0] || null;
      return {
        ok: true,
        is_available: !!data.is_available,
        currency: pick ? String(pick.currency || "") : "",
        total_balance: pick ? String(pick.total_balance || "") : "",
        granted_balance: pick ? String(pick.granted_balance || "") : "",
        topped_up_balance: pick ? String(pick.topped_up_balance || "") : "",
        balance_infos: infos,
        url,
      };
    } catch (e) {
      lastErr = (e && e.message) || lastErr;
    }
  }
  return { ok: false, error: "balance_failed", message: String(lastErr) };
}

if (require.main === module) {
  console.assert(apiRoot("https://api.deepseek.com/v1") === "https://api.deepseek.com");
  console.assert(
    apiRoot("https://api.deepseek.com/chat/completions") === "https://api.deepseek.com"
  );
  console.log("deepseek-balance ok");
}

module.exports = { fetchUserBalance, apiRoot };
