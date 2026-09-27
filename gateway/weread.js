const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

const RETRY_MAX = 2;
const RETRY_BASE_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把微信读书 HTTP / errCode 翻成人话（PRD D4）。
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
function explainWereadFailure({ status, errCode, errMsg } = {}) {
  const st = Number(status) || 0;
  const code = errCode != null && errCode !== "" ? errCode : null;
  const raw = String(errMsg || "").trim();
  const lower = raw.toLowerCase();

  if (st === 429 || code === 429 || /rate.?limit|too many|限流|频繁/.test(lower)) {
    return {
      code: "weread_rate_limited",
      message: "微信读书在限流，稍后再同步",
      retryable: true,
    };
  }
  if (st === 401 || st === 403 || /unauthorized|invalid.?token|invalid.?key|api.?key|未授权|无效|过期/.test(lower)) {
    return {
      code: "weread_auth",
      message: "微信读书 Key 无效或已过期，请到设定里检查",
      retryable: false,
    };
  }
  if (
    /upgrade|skill.?version|版本|升级/.test(lower) ||
    code === "upgrade_required" ||
    code === -2014
  ) {
    return {
      code: "weread_upgrade",
      message: "微信读书接口要升级技能版本，稍后再试或更新小屋",
      retryable: false,
    };
  }
  if (st >= 500) {
    return {
      code: "weread_http",
      message: "微信读书服务暂时不可用，稍后再试",
      retryable: true,
    };
  }
  if (st >= 400) {
    return {
      code: "weread_http",
      message: raw || "微信读书请求失败（HTTP " + st + "）",
      retryable: false,
    };
  }
  if (code) {
    return {
      code: "weread_api",
      message: raw || "微信读书接口错误（" + code + "）",
      retryable: false,
    };
  }
  return {
    code: "weread_api",
    message: raw || "微信读书接口错误",
    retryable: false,
  };
}

function throwExplained(parts) {
  const exp = explainWereadFailure(parts);
  const err = new Error(exp.message);
  err.code = exp.code;
  if (parts.status != null) err.status = parts.status;
  if (parts.errCode != null) err.errCode = parts.errCode;
  err.retryable = exp.retryable;
  throw err;
}

async function callWereadOnce(apiKey, apiName, params = {}) {
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_name: apiName,
        skill_version: SKILL_VERSION,
        ...params,
      }),
    });
  } catch (e) {
    const err = new Error("连不上微信读书，请检查网络");
    err.code = "weread_network";
    err.cause = e;
    throw err;
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (!res.ok) {
      throwExplained({ status: res.status, errMsg: text.slice(0, 80) });
    }
    const err = new Error("微信读书返回无法解析");
    err.code = "weread_bad_response";
    throw err;
  }

  if (!res.ok) {
    throwExplained({
      status: res.status,
      errCode: data.errCode ?? data.errcode,
      errMsg: data.errMsg || data.errmsg || data.message,
    });
  }

  const code = data.errCode ?? data.errcode;
  if (code) {
    throwExplained({
      status: res.status,
      errCode: code,
      errMsg: data.errMsg || data.errmsg || data.message,
    });
  }
  return data;
}

async function callWeread(apiKey, apiName, params = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      return await callWereadOnce(apiKey, apiName, params);
    } catch (e) {
      last = e;
      if (!e.retryable || attempt === RETRY_MAX) throw e;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
  throw last;
}

/** 拉取微信读书书架（电子书列表；专辑/公众号入口本步不入库） */
function fetchBookshelf(apiKey) {
  return callWeread(apiKey, "/shelf/sync");
}

/** 单书阅读进度与累计时长 */
function fetchProgress(apiKey, bookId) {
  return callWeread(apiKey, "/book/getprogress", { bookId: String(bookId) });
}

/** 单书划线列表（非书签） */
function fetchBookmarks(apiKey, bookId) {
  return callWeread(apiKey, "/book/bookmarklist", { bookId: String(bookId) });
}

/** 单书个人想法/点评（注意参数名 bookid 小写） */
function fetchMyReviews(apiKey, bookId) {
  return callWeread(apiKey, "/review/list/mine", {
    bookid: String(bookId),
    count: 50,
    synckey: 0,
  });
}

if (require.main === module) {
  const r429 = explainWereadFailure({ status: 429 });
  console.assert(r429.code === "weread_rate_limited" && r429.retryable && /限流/.test(r429.message), r429);
  const r401 = explainWereadFailure({ status: 401 });
  console.assert(r401.code === "weread_auth" && /Key/.test(r401.message), r401);
  const rUp = explainWereadFailure({ errMsg: "please upgrade skill_version" });
  console.assert(rUp.code === "weread_upgrade" && /升级/.test(rUp.message), rUp);
  const rApi = explainWereadFailure({ errCode: 10001, errMsg: "something" });
  console.assert(rApi.code === "weread_api" && rApi.message === "something", rApi);
  const bare = explainWereadFailure({ status: 418 });
  console.assert(bare.code === "weread_http" && /418/.test(bare.message), bare);
  console.log("weread explain ok");
}

module.exports = {
  fetchBookshelf,
  fetchProgress,
  fetchBookmarks,
  fetchMyReviews,
  callWeread,
  explainWereadFailure,
  GATEWAY,
  SKILL_VERSION,
};
