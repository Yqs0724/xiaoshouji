const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

async function callWeread(apiKey, apiName, params = {}) {
  const res = await fetch(GATEWAY, {
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
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("微信读书返回无法解析");
    err.code = "weread_bad_response";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`微信读书 HTTP ${res.status}`);
    err.code = "weread_http";
    err.status = res.status;
    throw err;
  }
  const code = data.errCode ?? data.errcode;
  if (code) {
    const err = new Error(data.errMsg || data.errmsg || "微信读书接口错误");
    err.code = "weread_api";
    err.errCode = code;
    throw err;
  }
  return data;
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

module.exports = {
  fetchBookshelf,
  fetchProgress,
  fetchBookmarks,
  fetchMyReviews,
  callWeread,
  GATEWAY,
  SKILL_VERSION,
};
