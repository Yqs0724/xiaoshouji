/**
 * 最小自检：拉起 MCP、列工具、调三个只读工具。
 * 用法：node gateway/mcp-check.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "gateway", "mcp-server.mjs");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "coread-mcp-check", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const need = ["get_last_session", "health_check", "list_bookshelf"];
  for (const n of need) {
    if (!names.includes(n)) throw new Error("missing tool " + n);
  }

  for (const name of need) {
    const res = await client.callTool({ name, arguments: {} });
    const text = res.content && res.content[0] && res.content[0].text;
    if (!text) throw new Error(name + " empty");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(name + " not ok");
  }

  await client.close();
  console.log("mcp ok", names.join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
