/**
 * 共读小屋 MCP · 远程 HTTP（Streamable HTTP + 旧版 SSE）
 *
 * 默认：127.0.0.1:8788 —— 仅本机。手机/异地请走 Tailscale，并设：
 *   MCP_HTTP_HOST=0.0.0.0   （或 Tailscale IP）
 *   MCP_HTTP_PORT=8788
 *   MCP_HTTP_TOKEN=随机长串 （强烈建议；客户端带 Authorization: Bearer …）
 *
 * 勿把未设 token 的 0.0.0.0 暴露到公网。
 *
 * 端点：
 *   POST/GET/DELETE  /mcp       Streamable HTTP（新客户端）
 *   GET              /sse       旧版 SSE
 *   POST             /messages  旧版消息（?sessionId=）
 */
import { randomUUID } from "node:crypto";
import { createServer as createMcp } from "./mcp-server.mjs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

const PORT = Number(process.env.MCP_HTTP_PORT) || 8788;
const HOST = (process.env.MCP_HTTP_HOST || "127.0.0.1").trim() || "127.0.0.1";
const TOKEN = (process.env.MCP_HTTP_TOKEN || "").trim();

const transports = Object.create(null);

function authOk(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || "");
  if (h === "Bearer " + TOKEN) return true;
  const q = req.query && req.query.token;
  return String(q || "") === TOKEN;
}

function rejectAuth(res) {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: need Bearer MCP_HTTP_TOKEN" },
    id: null,
  });
}

const app = createMcpExpressApp({ host: HOST });

app.use((req, res, next) => {
  if (!authOk(req)) {
    rejectAuth(res);
    return;
  }
  next();
});

app.get("/", (_req, res) => {
  res.type("text").send(
    [
      "coread-cabin MCP (HTTP)",
      "",
      "Streamable HTTP:  /mcp",
      "Legacy SSE:       /sse  +  POST /messages?sessionId=…",
      TOKEN ? "Auth: Bearer token required" : "Auth: none (set MCP_HTTP_TOKEN if exposed)",
      "",
    ].join("\n")
  );
});

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      const existing = transports[sessionId];
      if (!(existing instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: session uses a different transport",
          },
          id: null,
        });
        return;
      }
      transport = existing;
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) delete transports[sid];
      };
      const server = createMcp();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: no valid session (POST initialize first)",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP /mcp error", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/sse", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => {
      delete transports[transport.sessionId];
    };
    const server = createMcp();
    await server.connect(transport);
  } catch (error) {
    console.error("MCP /sse error", error);
    if (!res.headersSent) res.status(500).end("sse failed");
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const existing = transports[sessionId];
  if (!(existing instanceof SSEServerTransport)) {
    res.status(400).send("No SSE transport for sessionId");
    return;
  }
  await existing.handlePostMessage(req, res, req.body);
});

const server = app.listen(PORT, HOST, () => {
  const base =
    HOST === "0.0.0.0" || HOST === "::"
      ? `http://<本机局域网或TailscaleIP>:${PORT}`
      : `http://${HOST}:${PORT}`;
  console.error(`coread-cabin MCP (HTTP) ${HOST}:${PORT}`);
  console.error(`  Streamable: ${base}/mcp`);
  console.error(`  Legacy SSE: ${base}/sse`);
  if (!TOKEN && (HOST === "0.0.0.0" || HOST === "::")) {
    console.error("  WARN: 无 MCP_HTTP_TOKEN 且监听全网卡 — 勿对公网开放");
  }
});

process.on("SIGINT", async () => {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch (_) {}
    delete transports[sid];
  }
  server.close(() => process.exit(0));
});
