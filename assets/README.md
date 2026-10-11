# 母仓运行时素材

所有 **PWA 会加载的图片/皮** 集中在此，**不**再放在各 `apps/*/assets`。

| 路径 | URL 前缀 | 用途 |
|------|----------|------|
| `cafe/` | `/assets/cafe/` | 壳/共读薄巧皮（壁纸、图标、弹窗框等） |
| `chat/` | `/assets/chat/`（旧 `/assets-chat/` 仍兼容） | 日常聊天 / 共看吐槽 echoes 皮 |
| `colisten/` | `/assets/colisten/` | 共听播控皮 |
| `cal/` | `/assets/cal/` | 日历专用皮（壁纸/和纸/贴纸；勿复用壳与共听壁纸文件） |

源文件库（购买包、预览、试片等）在母仓 [`../素材/`](../素材/)，按 App 分子目录，亦不放在 App 代码树内。

各 App **代码**在 `apps/<名>/`（gateway / pwa 逻辑与 view CSS·HTML）；壳 DOM 组装见共读网关 `buildShellIndexHtml`。
