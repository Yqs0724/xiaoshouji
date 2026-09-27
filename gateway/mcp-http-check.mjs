/**
 * 远程 MCP 最小自检：起 HTTP → Streamable 连上 → listTools + health_check → 关。
 * 用法：node gateway/mcp-http-check.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "gateway", "mcp-http.mjs");
const PORT = 18788;
const TOKEN = "check-token-" + Date.now();
const base = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseTool(res) {
  const text = res.content && res.content[0] && res.content[0].text;
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text);
}

async function waitReady(child, ms = 8000) {
  const deadline = Date.now() + ms;
  let errBuf = "";
  child.stderr.on("data", (c) => {
    errBuf += String(c);
  });
  while (Date.now() < deadline) {
    if (errBuf.includes("MCP (HTTP)")) return;
    if (child.exitCode != null) throw new Error("server exited: " + errBuf);
    await sleep(50);
  }
  throw new Error("server start timeout: " + errBuf);
}

async function main() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      MCP_HTTP_PORT: String(PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitReady(child);

    const denied = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{}",
    });
    if (denied.status !== 401) throw new Error("expected 401 without token, got " + denied.status);

    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + TOKEN },
      },
    });
    const client = new Client({ name: "coread-mcp-http-check", version: "0.0.1" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["health_check", "list_notes", "search_notes"]) {
      if (!names.includes(n)) throw new Error("missing " + n);
    }

    const health = parseTool(await client.callTool({ name: "health_check", arguments: {} }));
    if (!health.ok) throw new Error("health_check failed");

    await client.close();
    console.log("mcp-http ok", base + "/mcp", names.length, "tools");
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
