# 共听 App（Apple Music · 连接搁置）

播控 / 本场吐槽 / 场次 / 收藏与历史 / 本场歌单。产品真源见母仓 `PRD.md` §6.6。  
勾选：[`落地进度.md`](./落地进度.md)。

## 目录

```
apps/共听app/
  gateway/listen.js
  pwa/
    colisten.js      ← /assets-colisten/colisten.js
    colisten.css     ← /app-ui/共听app/colisten.css
    view.html        ← 注入壳 index
  data/listen.json
  落地进度.md
```

**素材不在本目录**：运行时皮 → 母仓 `assets/colisten/`（URL `/assets/colisten/`）；源库 → 母仓 `素材/共听/`。

## API（挂共读网关）

见 [`落地进度.md`](./落地进度.md)。启动：母仓 / 共读 `npm start` → `http://127.0.0.1:8787`。
