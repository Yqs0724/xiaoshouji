/**
 * 外接 MCP（Streamable HTTP）薄客户端：listTools / callTool。
 * H1.25：同 url+token 空闲内复用连接，避免一轮多调反复握手。
 * 依赖本包 @modelcontextprotocol/sdk；失败时抛错给上层降级。
 */
const MCP_TOOL_CAP = 32;
const CACHE_TTL_MS = 30_000;
/** 空闲多久关掉复用连接；开保活心跳时会周期性探测续命 */
const SESSION_IDLE_MS = 60_000;
const HEARTBEAT_MS = 5 * 60 * 1000;

let cache = { key: "", at: 0, tools: null };

/** @type {{ key: string, client: object, idleTimer: ReturnType<typeof setTimeout> | null } | null} */
let session = null;
/** 串行化同进程内 MCP 调用，避免双连 */
let gate = Promise.resolve();
/** @type {{ ok: boolean, at: number, label: string, count: number, error: string } | null} */
let lastStatus = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {(() => object) | null} */
let heartbeatGetSettings = null;

function mcpCacheKey(url, token) {
  return String(url || "").trim() + "\0" + String(token || "").trim();
}

async function dropSession() {
  const s = session;
  session = null;
  if (!s) return;
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  try {
    await s.client.close();
  } catch {
    /* ignore */
  }
}

function bumpIdle() {
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    gate = gate.then(() => dropSession(), () => dropSession());
  }, SESSION_IDLE_MS);
  if (typeof session.idleTimer.unref === "function") session.idleTimer.unref();
}

function clearMcpToolsCache() {
  cache = { key: "", at: 0, tools: null };
  gate = gate.then(() => dropSession(), () => dropSession());
}

function sanitizeToolName(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) s = "tool";
  if (!/^[a-zA-Z_]/.test(s)) s = "t_" + s;
  return s.slice(0, 64);
}

async function loadSdk() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  return { Client, StreamableHTTPClientTransport };
}

function parseEndpoint(url) {
  const endpoint = String(url || "").trim();
  if (!endpoint) {
    const err = new Error("未填 MCP URL");
    err.code = "mcp_no_url";
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    const err = new Error("MCP URL 无效");
    err.code = "mcp_bad_url";
    throw err;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const err = new Error("MCP URL 须为 http(s)");
    err.code = "mcp_bad_url";
    throw err;
  }
  return parsed;
}

async function connectClient(url, token) {
  const parsed = parseEndpoint(url);
  const { Client, StreamableHTTPClientTransport } = await loadSdk();
  const headers = {};
  const tok = String(token || "").trim();
  if (tok) headers.Authorization = "Bearer " + tok;
  const transport = new StreamableHTTPClientTransport(parsed, {
    requestInit: { headers },
  });
  const client = new Client({ name: "ariadne-phone", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function withMcpClient({ url, token }, fn) {
  parseEndpoint(url);
  const key = mcpCacheKey(url, token);
  const run = async () => {
    if (!session || session.key !== key) {
      await dropSession();
      const client = await connectClient(url, token);
      session = { key, client, idleTimer: null };
    }
    try {
      const out = await fn(session.client);
      bumpIdle();
      return out;
    } catch (e) {
      await dropSession();
      throw e;
    }
  };
  const p = gate.then(run, run);
  gate = p.catch(() => {});
  return p;
}

function toolResultText(res) {
  if (!res) return "";
  if (typeof res === "string") return res;
  const parts = Array.isArray(res.content) ? res.content : [];
  const texts = parts
    .map((p) => {
      if (!p) return "";
      if (p.type === "text") return String(p.text || "");
      try {
        return JSON.stringify(p);
      } catch {
        return String(p.type || "part");
      }
    })
    .filter(Boolean);
  if (texts.length) return texts.join("\n");
  if (res.structuredContent != null) {
    try {
      return JSON.stringify(res.structuredContent);
    } catch {
      /* fall */
    }
  }
  try {
    return JSON.stringify(res);
  } catch {
    return String(res);
  }
}

/** @returns {Promise<{ name: string, description: string, inputSchema: object }[]>} */
async function fetchMcpTools({ url, token, force } = {}) {
  const key = mcpCacheKey(url, token);
  const now = Date.now();
  if (!force && cache.key === key && cache.tools && now - cache.at < CACHE_TTL_MS) {
    return cache.tools;
  }
  const tools = await withMcpClient({ url, token }, async (client) => {
    const listed = await client.listTools();
    const raw = Array.isArray(listed.tools) ? listed.tools : [];
    return raw.slice(0, MCP_TOOL_CAP).map((t) => ({
      name: String(t.name || "").trim(),
      description: String(t.description || "").trim(),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} },
    })).filter((t) => t.name);
  });
  cache = { key, at: now, tools };
  return tools;
}

async function callMcpTool({ url, token }, name, args) {
  const remoteName = String(name || "").trim();
  if (!remoteName) {
    const err = new Error("工具名为空");
    err.code = "mcp_bad_name";
    throw err;
  }
  const arguments_ =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};
  return withMcpClient({ url, token }, async (client) => {
    const res = await client.callTool({
      name: remoteName,
      arguments: arguments_,
    });
    if (res && res.isError) {
      const err = new Error(toolResultText(res) || "MCP 工具报错");
      err.code = "mcp_tool_error";
      throw err;
    }
    return toolResultText(res) || JSON.stringify({ ok: true });
  });
}

/**
 * 主 URL + 备用 URL（settings.mcp_url / mcp_url_2）
 * @returns {{ url: string, token: string, label: string }[]}
 */
function endpointsFromSettings(settings) {
  const s = settings || {};
  const out = [];
  const primary = String(s.mcp_url || "").trim();
  if (primary) {
    out.push({
      url: primary,
      token: String(s.mcp_token || "").trim(),
      label: "主",
    });
  }
  const backup = String(s.mcp_url_2 || "").trim();
  if (backup) {
    out.push({
      url: backup,
      token: String(s.mcp_token_2 || "").trim(),
      label: "备",
    });
  }
  return out;
}

function getMcpStatus() {
  return lastStatus ? Object.assign({}, lastStatus) : null;
}

function setMcpStatus(partial) {
  lastStatus = Object.assign(
    {
      ok: false,
      at: Date.now(),
      label: "",
      count: 0,
      error: "",
    },
    partial || {}
  );
  return getMcpStatus();
}

/**
 * 按主→备依次拉工具表；成功则记下 lastStatus。
 * @returns {Promise<{ tools: object[], endpoint: object }>}
 */
async function fetchMcpToolsMulti(endpoints, { force } = {}) {
  const list = Array.isArray(endpoints) ? endpoints.filter((e) => e && e.url) : [];
  if (!list.length) {
    const err = new Error("未填 MCP URL");
    err.code = "mcp_no_url";
    throw err;
  }
  const errs = [];
  for (const ep of list) {
    try {
      const tools = await fetchMcpTools({
        url: ep.url,
        token: ep.token,
        force,
      });
      setMcpStatus({
        ok: true,
        at: Date.now(),
        label: ep.label || ep.url,
        count: (tools || []).length,
        error: "",
      });
      return { tools, endpoint: ep };
    } catch (e) {
      errs.push(
        (ep.label || ep.url) + "：" + ((e && e.message) || "失败")
      );
    }
  }
  const msg = errs.join(" · ") || "MCP 全部失败";
  setMcpStatus({
    ok: false,
    at: Date.now(),
    label: "",
    count: 0,
    error: msg,
  });
  const err = new Error(msg);
  err.code = "mcp_all_failed";
  throw err;
}

/** 调用：先试当前缓存会话对应端，再主→备 */
async function callMcpToolMulti(endpoints, name, args) {
  const list = Array.isArray(endpoints) ? endpoints.filter((e) => e && e.url) : [];
  if (!list.length) {
    const err = new Error("未填 MCP URL");
    err.code = "mcp_no_url";
    throw err;
  }
  const ordered = list.slice();
  if (session && session.key) {
    const live = ordered.find((ep) => mcpCacheKey(ep.url, ep.token) === session.key);
    if (live) {
      ordered.splice(ordered.indexOf(live), 1);
      ordered.unshift(live);
    }
  }
  const errs = [];
  for (const ep of ordered) {
    try {
      const text = await callMcpTool(
        { url: ep.url, token: ep.token },
        name,
        args
      );
      setMcpStatus({
        ok: true,
        at: Date.now(),
        label: ep.label || ep.url,
        count: (lastStatus && lastStatus.count) || 0,
        error: "",
      });
      return text;
    } catch (e) {
      errs.push((ep.label || ep.url) + "：" + ((e && e.message) || "失败"));
    }
  }
  const msg = errs.join(" · ") || "MCP 调用失败";
  setMcpStatus({
    ok: false,
    at: Date.now(),
    label: "",
    count: 0,
    error: msg,
  });
  const err = new Error(msg);
  err.code = "mcp_all_failed";
  throw err;
}

function stopMcpHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatGetSettings = null;
}

/** 保活：约 5 分钟强制拉一次工具表（仅 mcp_enabled + mcp_heartbeat） */
function startMcpHeartbeat(getSettings) {
  stopMcpHeartbeat();
  if (typeof getSettings !== "function") return;
  heartbeatGetSettings = getSettings;
  heartbeatTimer = setInterval(() => {
    let s;
    try {
      s = heartbeatGetSettings();
    } catch (_) {
      return;
    }
    if (!s || !s.mcp_enabled || !s.mcp_heartbeat) return;
    const eps = endpointsFromSettings(s);
    if (!eps.length) return;
    fetchMcpToolsMulti(eps, { force: true }).catch(() => {});
  }, HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

function hasLiveSession() {
  return !!(session && session.client);
}

if (require.main === module) {
  console.assert(sanitizeToolName("list.notes!") === "list_notes");
  console.assert(sanitizeToolName("9bad").startsWith("t_"));
  console.assert(sanitizeToolName("") === "tool");
  console.assert(SESSION_IDLE_MS === 60_000);
  console.assert(HEARTBEAT_MS === 5 * 60 * 1000);
  const eps = endpointsFromSettings({
    mcp_url: "http://127.0.0.1:9/mcp",
    mcp_url_2: "http://127.0.0.1:8/mcp",
    mcp_token_2: "t",
  });
  console.assert(eps.length === 2 && eps[0].label === "主" && eps[1].label === "备");
  console.assert(endpointsFromSettings({}).length === 0);
  clearMcpToolsCache();
  console.assert(!hasLiveSession());
  console.log("mcp-remote ok");
}

module.exports = {
  MCP_TOOL_CAP,
  SESSION_IDLE_MS,
  HEARTBEAT_MS,
  sanitizeToolName,
  clearMcpToolsCache,
  fetchMcpTools,
  callMcpTool,
  fetchMcpToolsMulti,
  callMcpToolMulti,
  endpointsFromSettings,
  getMcpStatus,
  startMcpHeartbeat,
  stopMcpHeartbeat,
  withMcpClient,
  hasLiveSession,
};
