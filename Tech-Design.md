# Ariadne 小手机 · Tech-Design

> 2026-10-01 · 阶段 E。怎么实现。对齐 [`PRD.md`](./PRD.md)。  
> API / 工具名为**建议名**，可改；**不可**偷加 PRD 没有的产品能力。  
> 共读网关现状以 `apps/共读app/Tech-Design.md` + 现行代码为准；本文描述**扩展**，不另起第二网关。  
> **2026-10-11 补丁**：日常聊天工具循环与外接 MCP **客户端**已落地（见下 §3.3 / §5 注）。  
> **2026-10-20 补丁**：`kind:sys` 灰字回执（含 list 时补种）；红包竖版 GIF 开箱；转账 `payload.is_receipt`；相册多图 `noreply`+末条 SSE；`maybeBotMoney` 语境触发与 bot 余额不足补发；位置底表；文件 `payload.text` 摘录；音乐 `fromPresence`；`POST …/transcribe` → `{llm_base}/audio/transcriptions`；语音气泡外挂转文字；聊天记录在会话 ···；字段以实现与 [`apps/聊天app/落地进度.md`](./apps/聊天app/落地进度.md) 为准。

---

## 1. 架构总览

```
┌──────────── 小手机 PWA ─────────────────────┐
│ 壳：锁屏 / 桌面 / 设置 / 资料                  │
│ Apps：共读(挂载) · 聊天 · 日历 · 共看 · 共听…   │
│ ←→ REST / WS → 网关                           │
└────────────────────┬────────────────────────┘
                     │ LAN / Tailscale
┌────────────────────▼────────────────────────┐
│ 电脑网关（扩展现有共读进程，勿双开真相库）        │
│  · HTTP API（PWA）                            │
│  · MCP Server（Chatbox 桌面）                 │
│  · SQLite WAL + 文件仓                        │
│  · LLM（跟批 / 日常聊 / 本场吐槽 / 注入旁路）   │
│  · 片库索引（路径+元数据；不含备份原片）         │
│  · Apple Music / MusicKit 相关令牌与代理（若需） │
└───────────┬──────────────────┬──────────────┘
            │                  │
     Chatbox 剧情号等      （可选）外部：MusicKit / 微信 API
```

**原则**：一个网关写入口；共读代码剥离挂载而非重写；PWA 不直连微信；影片文件只活在用户盘，备份库只存元数据。

---

## 2. 推荐栈（可替换，契约优先）

| 层 | 建议 | 备注 |
|----|------|------|
| 网关 | 延续共读现有 Node（或团队熟栈） | 同进程挂新路由/MCP |
| DB | SQLite WAL | 新表加前缀或 migration；勿平行第二库 |
| 文件 | `data/` 下分模块目录 | `media/library` 索引；`backups/` |
| PWA | 静态或轻量；壳 DOM 现状见壳契约 | 物理外提壳须单独立项 |
| 共听 | Apple MusicKit JS / 官方允许桥 | 需开发者账号与用户授权；**现行连接搁置**，mock 骨架见 `apps/共听app` |
| 共看 | 浏览器 `<video>` + 本地/网关文件流 | 大文件勿塞备份 zip |
| 日历 see | 可选 html2canvas / 服务端截图 | 成本中；可后做 |
| 部署 | 本机 + Tailscale | 不做公网多租户 |

---

## 3. 数据模型（逻辑）

### 3.1 身份

```
Person { id: you | home, displayName, avatar, decoInventory[] }
```

### 3.2 日历

```
CalEvent { id, start, end?, allDay, title, owners[], status: confirmed|proposed, source }
CalNote  { id, bind: date|eventId, body, liked?, createdBy }
CycleLog { …经期相关字段 }  // 完整可读，仅本机库
```

### 3.3 聊天（日常）

```
ChatThread { id, peer }           // 现行单线程 daily；与共看场会话分离
ChatMessage {
  id, threadId, from, kind, body, ts, read,
  // kind: text|sticker|image|voice|call|redpacket|transfer|location|file|music|tool|pat|sys
  think?, think_sec?,             // 深思（挂家机 text）
  payload?,                       // 红包/转账/位置等；钱可含 status/receipt/is_receipt
                                  // voice: durationMs, transcript?, transcriptStub?, voiceStub?
                                  // file: name, text?；music: name, artist?, fromPresence?
  tools?: [{ name, label, summary, ok }]  // 本轮工具摘要（挂家机 text）
}
// sys：居中灰字（领取回执等），落库；不进 LLM prior
// 发图多张：前 N−1 条 POST noreply:true，末条走 SSE 接话
// 语音转写：POST …/transcribe → llm.transcribeAudio（复用 llm_base/key；可选 asr_model）
// 零花：红包/转账 ↔ apps/资产app/gateway/wallet.js；≠ 额度 tokens
```

模块：`apps/聊天app/gateway/daily-chat.js` + `chat-tools.js`；外接 MCP 客户端 `apps/共读app/gateway/mcp-remote.js`；ASR `apps/共读app/gateway/llm.js#transcribeAudio`。  
设定：`chat_tools_enabled` / `chat_tool_labels` / `mcp_enabled|url|token` / `asr_model`（`settings.json`）。

### 3.4 共看

```
Title { id, name, pathOrUri, poster?, meta }
WatchPass { id, titleId, status: active|ended, progress }
WatchMsg { id, passId, from, body, ts }   // 本场吐槽；≠ 日常 ChatMessage
```

### 3.5 共听

```
ListenPass { id, status, engaged, track_title?, spit_count?, … }
ListenMsg { id, passId, from: you|bot, body, ts }
Favorite { id, title, artist, cover?, ts }  // 网关侧收藏元数据
MusicAuth { token/state }  // 现行 connection=shelved；备份导出剔令牌
playback { playing, trackIndex }  // mock 曲目表；非真 MusicKit 队列
```

模块真源：`apps/共听app/gateway/listen.js` + `data/listen.json`；PWA 逻辑 `pwa/colisten.js`，DOM 暂挂共读 `#view-colisten`。

### 3.6 剧情摘要卡

```
LoreCard { id, body, source: mcp|paste, ts }  // 短卡；非向量库
```

### 3.7 共读

- 既有 Book / Pass / Session / Message… → 见共读 Tech；本仓只消费其 API / 备份钩子。

### 3.8 注册表与备份清单

```
AppRegistry { appId, visible, order }
BackupManifest { modules[], media: metadata-only }
```

---

## 4. HTTP API（建议分组）

| 前缀 | 用途 |
|------|------|
| `/api/health` | 网关 / LLM / Music 授权态 |
| `/api/shell/*` | 相识日、头像装饰、「正在做什么」、胶囊 |
| `/api/cal/*` | 事件 / 便签 / 经期 / 提议确认 |
| `/api/chat/*` | 日常线程与消息 |
| `/api/watch/*` | 片库索引、场次、吐槽、进度 |
| `/api/v1/listen/*` | 场次、presence/engage、收藏/历史、播控（含 select）、吐槽 SSE、提议、auth（现行 shelved） |
| `/api/lore/*` | 摘要卡读写 |
| `/api/backup/*` | 导出/预览（排除原片） |
| 共读既有 | 保持；壳只调入口级 |

具体字段以实现切片为准；上表防乱加域。

---

## 5. MCP / 工具两路（勿混）

### 5.1 Chatbox 桌面 · 网关作 MCP **Server**（建议名 · 对齐 PRD C5 等）

| 工具 | 对齐 PRD |
|------|----------|
| `cal_list` / `cal_create` / `cal_update` / `cal_delete` / `cal_comment`（共读 `mcp-server.mjs`） | C5 · 2026-10-27（`see` 未做） |
| `lore_*` / 共读既有 | X1 / 共读 |
| 共看/共听只读或提议类 | 实现期按需；**播控真源在 PWA 你侧** |

移动 Chatbox 无工作模式 MCP → 不把「手机侧扫消息入历」当主路径。

### 5.2 小手机日常聊天 · 网关内工具循环（已实现主干）

| 来源 | 说明 |
|------|------|
| 内置 | `calendar_list/create/update/delete_events` → 调 `日历app/gateway/calendar.js` |
| 外接 | 设定开 MCP 时，Streamable HTTP **客户端**拉远端 `tools/list` 并 `tools/call` |
| 暴露给模型 | OpenAI 风格 `tools`；SSE `bot_tool` / `bot_tool_done` |

**不是**「日历 App 自己当 MCP server」；也**不是**替代 Chatbox 桌面挂共读 MCP。

---

## 6. LLM 与注入

| 通道 | 谁调模型 | 约束 |
|------|----------|------|
| 共读跟批 | 网关（既有） | 预算/锁 |
| 日常聊天家机回复 | 网关 | 短讯风；非正剧；可带 tools + 深思 |
| 共看/共听本场吐槽 | 网关 | 共看有额度闸门（可关）；**共听现行无额度闸**（见共听落地进度） |
| `[NOW]` `[TODAY]` `[NEW]` | system 旁路拼进相关生成 | 日历写后短暂 NEW |

未配 Key：UI 降级提示，不空转耗配额假成功。

---

## 7. 共听 · Apple Music（实现要点）

1. 设置页完成开发者/用户授权流，状态进 `/api/health` 与设置 UI。  
2. 播控以官方 SDK 允许的方式为准；网关可存「正在播」元数据供桌面装饰。  
3. 家机「切歌提议」= 数据对象 + PWA 确认钮，**不是**家机直连改队列绕过你。  
4. 酷狗方案不作代码路径。  
5. **现行（2026-10-10）**：连接配置**搁置**（`apple_music: "shelved"`）；mock 播控/歌单/收藏/历史/SSE 吐槽已挂网关；真 MusicKit / JWT **未接**。恢复真连接时扩展 auth，勿另起第二套共听前端。

---

## 8. 共看 · 本地媒体

1. 用户选目录或上传 → 索引元数据 + 可播路径。  
2. 播放优先浏览器直读或网关 Range 文件流（切片期二选一，选短的）。  
3. Backup zip：**禁止**打入原片；只 Title/进度/短评/场摘要。

---

## 9. 小屋

1. 一期：静态图 + 热区坐标 JSON + CSS/绝对定位气泡。  
2. 精灵走动：坐标状态本机即可。  
3. three.js：单独里程碑，不阻塞 M5 其它项。

---

## 10. 安全与隐私

- 门禁沿用共读壳。  
- 经期等敏感字段仅本机库；「家机可见」≠ 公网可见。  
- 照片墙/片库不默认上传公网。  
- 备份目录用户说删再删（壳契约）。

---

## 11. 与共读目录关系

| 路径 | 角色 |
|------|------|
| `Ariadne/` | 母仓；本文档；`UI-DEMO.html`；日后壳外提 |
| `apps/共读app/` | 共读真源；现行网关+pwa（壳 DOM 暂寄） |
| `apps/日历app/` `apps/聊天app/` `apps/共看app/` `apps/共听app/` | 各 App gateway+pwa+data+文档；由共读网关 require，不另起端口 |
| `assets/` · `素材/` | 运行时皮 / 源素材库（母仓集中；勿再放进 apps/*/assets） |
| `shell/` | 边界说明；壳 index 组装各 App view，勿平行第二套壳站点 |

扩展网关时：**在共读网关内加模块**，或按壳契约单独立项搬迁——禁止静默复制出第二套共读前端。

---

## 12. 风险与简策

| 风险 | 简策 |
|------|------|
| MusicKit Web 能力受限 | 先做授权态+元数据+手动确认提议；播控降级说明 |
| 大影片拖垮备份 | 清单硬规则 + 导出校验 |
| 壳改坏共读 | 每刀对照壳契约与落地进度；禁止顺手改共读皮 |
| DEMO 图标素材临时 | UI-Design 锁框不锁贴图文件名 |
