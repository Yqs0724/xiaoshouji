/**
 * 外接 MCP（Streamable HTTP）薄客户端：listTools / callTool。
 * H1.25：同 url+token 空闲内复用连接，避免一轮多调反复握手。
 * 依赖本包 @modelcontextprotocol/sdk；失败时抛错给上层降级。
 */
const MCP_TOOL_CAP = 32;
const CACHE_TTL_MS = 30_000;
/** 空闲多久关掉复用连接；无常驻心跳 */
const SESSION_IDLE_MS = 60_000;

let cache = { key: "", at: 0, tools: null };

/** @type {{ key: string, client: object, idleTimer: ReturnType<typeof setTimeout> | null } | null} */
let session = null;
/** 串行化同进程内 MCP 调用，避免双连 */
let gate = Promise.resolve();

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

function hasLiveSession() {
  return !!(session && session.client);
}

if (require.main === module) {
  console.assert(sanitizeToolName("list.notes!") === "list_notes");
  console.assert(sanitizeToolName("9bad").startsWith("t_"));
  console.assert(sanitizeToolName("") === "tool");
  console.assert(SESSION_IDLE_MS === 60_000);
  clearMcpToolsCache();
  console.assert(!hasLiveSession());
  console.log("mcp-remote ok");
}

module.exports = {
  MCP_TOOL_CAP,
  SESSION_IDLE_MS,
  sanitizeToolName,
  clearMcpToolsCache,
  fetchMcpTools,
  callMcpTool,
  withMcpClient,
  hasLiveSession,
};
