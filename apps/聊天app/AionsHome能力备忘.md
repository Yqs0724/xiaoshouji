# AionsHome → Ariadne 能力备忘

完整愿望清单（用户个人店同步）：Cursor Agent Store `ariadne-aionshome-wishlist.md`  
源项目：https://github.com/death34018-hue/AionsHome

## 记忆库切片

| 刀 | 内容 | 状态 |
|----|------|------|
| **M1** | 记忆库工作台 CRUD + 搜索 + 待办钉 | [x] 2026-10-20 |
| **M2** | 手动「总结新记忆」+ 锚点 | [x] 2026-10-20 |
| **M3** | 关键词召回 + 待办优先注入 | [x] 2026-10-20 |
| **M4** | 即时哨兵路由（规则版） | [x] 2026-10-20 |
| **M5** | Embedding 向量综合评分 | [x] 2026-10-20 |

已有：H2.2～M5 记忆轨齐；H2.4 启发式抽记仍作补充。  
用向量：设定里填 Embedding Model（如硅基 `BAAI/bge-m3`），与 LLM Base/Key 同端点。

## 在场感切片（视觉 / 主动找你）

对照 AionsHome「三、视觉与在场感」。已有：`POST …/poke` 模板主动短讯（非双脑）。

| 刀 | 内容 | 状态 |
|----|------|------|
| **V1** | Sentinel/Core 骨架：开关+间隔；定时截主屏（失败则纯文本态）；轻量模型 JSON 是否唤醒；唤醒则 Core 写一条家机主动话+未读 | [x] 2026-10-20 |
| **V2** | `cam_check` 工具：接话可主动看主屏（提示音 + 5s 缓冲再截；真摄像头后置） | [x] 2026-10-21 |
| **V3** | 监控日志 JSONL（按日、3 天清理）+ 设定页列表 + SSE 实时推（无独立 WS） | [x] 2026-10-21 |
| **V4** | 设备活动摘要（PC 前台窗）喂哨兵 | [x] 2026-10-21 |
| **V4b** | 安静时段：设定起止；时段内不截屏、不唤醒（可跨午夜；`force` tick 仍可测） | [x] 2026-10-21 |
| **V4c** | 聊天工具 `view_activity`：slots 1～12≈10～120 分前台摘要（不截屏）；需已开活动采样 | [x] 2026-10-21 |
| **V4d** | 定时监控 `schedule_monitor`：minutes/at 预约；到点活动或截屏→主动短讯；非闹钟 | [x] 2026-10-21 |
| **V4e** | 点歌 `share_music`：音乐卡（歌名/艺人或共听当前曲）；不播放、不接网易云 | [x] 2026-10-21 |
| **V4f** | Apple 降级共听：iTunes Search；真卡=官方链+可选试听；共同状态；无开发者账号 | [x] 2026-10-21 |
| **V4g** | 网易云整曲：NeteaseCloudMusicApi；流代理；Cookie 仅服务端；点歌优先 | [x] 2026-10-21 |
| **V4h** | Cove 阶段 A 收尾：共听拖进度；歌曲详情 API；分码错误文案 | [x] 2026-10-21 |
| **V4i** | Cove 阶段 B：共同状态/租约/阶段总结/AI 上下文 | [x] 2026-10-21 |
| **V4j** | Cove 阶段 C：导歌单/队列/音质音量 | [x] 2026-10-21 |
| **V5** | ESP32 / App 桥帧 · 生图 · 壁纸 · 桌宠 — 后置 | 待 |
| **A1** | Android 壳 MVP：WebView + 双地址；摄像头占位不取帧；网关可 `HOST=0.0.0.0` | [x] 2026-10-21 |

### 与 AionsHome 教程对齐（诚实账）

| 点 | 教程 | Ariadne 现状 |
|----|------|----------------|
| Sentinel→JSON→可选 Core | ✓ | ✓（字段兼容 `call_core` / `monitoringlog`） |
| 监控 JSONL + 3 天清理 | ✓ | ✓ `data/monitor_logs/` |
| 日志实时推 | WebSocket `/ws` | ✓ 同端口 `ws://…/ws` 推 `monitor_log`（SSE 仍作回落） |
| 看屏前提示 | `monitor_alert` + mp3 | ✓ WS `monitor_alert` + 壳提示音（非原版 mp3 文件） |
| CAM_CHECK | 回复里 `[CAM_CHECK]` → 前端 strip → 播 mp3 → 5s → POST 触发 | 工具 `cam_check` + SSE 提示 + **服务端**等 5s 再截（同效果，接线不同） |
| 帧来源 | 摄像头 / ESP32 / App 桥 | **主屏截图**（真摄像头后置） |
| 原图不进主脑 | 便宜模型转文字 | ✓ 描述文本回灌 |
| PC 活动日志 | pywin32 前台窗 | ✓ PowerShell 采样 → `activity_logs/`；摘要喂哨兵（无 pywin32） |
| 聊天内查看动态 | `[查看动态:n]` | ✓ 工具 `view_activity`（slots=n；非标签路径） |
| 定时监控 | `[Monitor:]` | ✓ 工具 `schedule_monitor`（预约看护；非闹钟） |
| 点歌 | `[MUSIC:]` | ✓ `share_music` → Apple/iTunes 真卡（链+试听；Cove 降级） |

**V1 不做**：真摄像头设备枚举、ESP32、手机桥、生图、壁纸、桌宠。
