/**
 * 共读小屋 · 只读 MCP（stdio）
 * Chatbox / Inspector：command = node，args = gateway/mcp-server.mjs，cwd = 仓库根
 * 勿往 stdout 打日志（会污染 JSON-RPC）。
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const require = createRequire(import.meta.url);
const { healthFlags } = require("./settings.js");
const { readBooks } = require("./books.js");
const { listSessions, formatDurationMs } = require("./sessions.js");

function jsonText(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function createServer() {
  const server = new McpServer({
    name: "coread-cabin",
    version: "0.2.1",
  });

  server.registerTool(
    "health_check",
    {
      description: "共读小屋网关连接健康：微信 Key / LLM 是否已配置（读本机设定，不测远端连通）",
    },
    async () => {
      const flags = healthFlags();
      return jsonText({
        ok: true,
        gateway: "data_ok",
        note: "本工具读本地设定文件；HTTP 网关需另开 npm start",
        ...flags,
      });
    }
  );

  server.registerTool(
    "list_bookshelf",
    {
      description: "列出本机已同步的书架（只读本地缓存，不触发微信同步）",
    },
    async () => {
      const { books } = readBooks();
      const slim = books.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        source: b.source,
        progress: b.progress,
        weread_progress: b.weread_progress,
        in_progress: !!b.in_progress,
        updated_at: b.updated_at,
      }));
      return jsonText({ ok: true, count: slim.length, books: slim });
    }
  );

  server.registerTool(
    "get_last_session",
    {
      description: "最近一场已结束共读的摘要卡（书名、时长、划线/跟批数、token）",
    },
    async () => {
      const { sessions } = listSessions();
      const last = sessions[0] || null;
      if (!last) {
        return jsonText({ ok: true, session: null, message: "还没有结束过的场次" });
      }
      return jsonText({
        ok: true,
        session: {
          ...last,
          duration_label: formatDurationMs(last.duration_ms),
        },
      });
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coread-cabin MCP (stdio) ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
