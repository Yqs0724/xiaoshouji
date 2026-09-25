# 共读小屋

本机网关 + PWA。网关是唯一数据源。

## 密钥（DeepSeek 等）

复制或直接编辑仓库根目录 [`.env`](./.env)：

```env
DEEPSEEK_API_KEY=sk-你的密钥
LLM_BASE=https://api.deepseek.com
LLM_MODEL=deepseek-flash
```

填好后**重启** `npm start`。环境变量优先于设定页；`.env` 已在 `.gitignore`。

## 启动网关

```powershell
npm start
```

默认：`http://127.0.0.1:8787`（可用环境变量 `PORT` 改）。

浏览器打开待机页：<http://127.0.0.1:8787/>

健康检查：

```powershell
curl.exe http://127.0.0.1:8787/api/v1/health
```

# 应看到 "llm":"configured"（密钥填对并重启后）

## Chatbox · MCP（只读）

共读号 / 剧情号挂**同一** MCP。在 Chatbox MCP 配置里（路径按本机改）：

| 项 | 值 |
|----|-----|
| command | `node` |
| args | `d:\cursor-projects\共读室\gateway\mcp-server.mjs` |
| cwd | `d:\cursor-projects\共读室` |

或：`npm run mcp`（cwd 同上）。

当前工具：`health_check` · `list_bookshelf` · `get_last_session`（均只读本地数据；书架同步仍用 PWA / `npm start`）。

自检：`npm run check:mcp`
