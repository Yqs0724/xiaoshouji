# 日常聊天 App

```
apps/聊天app/
  gateway/daily-chat.js
  gateway/chat-tools.js   ← 内置日历工具 + 与 MCP 合并
  gateway/stickers.js
  pwa/
    chat.js      ← /app-ui/聊天app/pwa/chat.js（ChatApp.mount）
    chat.css
    view.html
  data/chat.json
  落地进度.md
```

≠ 共读短聊（`coreadChatInput`）/ 共看吐槽。皮：母仓 `assets/chat/`。  
外接 MCP 客户端在 `apps/共读app/gateway/mcp-remote.js`。进度只维护 `落地进度.md`。
