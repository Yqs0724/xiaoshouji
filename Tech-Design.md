# 共读小屋 · Tech-Design

> 技术设计。对齐 [`PRD.md`](./PRD.md)。实现未开工前可调整栈，但边界与数据模型应稳定。

## 1. 架构总览

```
┌──────────── PWA（静态壳 + JS）────────────┐
│  待机 / Tab枢纽 / 共读中 UI                 │
│  ←→ REST/WS 调网关                          │
└──────────────────┬─────────────────────────┘
                   │ LAN / Tailscale
┌──────────────────▼─────────────────────────┐
│              电脑网关（常开进程）              │
│  · HTTP API（PWA）                           │
│  · MCP Server（Chatbox 双助手）              │
│  · WeRead 同步轮询                           │
│  · LLM 客户端（跟批 / 小结 / 空闲自读）       │
│  · SQLite + 本地文件仓                       │
└────────────────────────────────────────────┘
         ▲                    ▲
    Chatbox 共读号        Chatbox 剧情号
```

**原则**：网关是唯一写入口；PWA 不直连微信 API；Chatbox 不持有第二份共读库。

## 2. 推荐栈（可替换，契约优先）

| 层 | 建议 | 备注 |
|----|------|------|
| 网关 | Node 或 Python（FastAPI）单进程 | 选团队熟的；MCP SDK 成熟即可 |
| DB | SQLite（WAL） | 本机单用户足够 |
| 文件 | `data/books/` `data/world/` `data/backups/` | 正文、世界书、备份 |
| PWA | 静态 HTML/CSS/JS 或轻量 Vite | 首版可无框架；共读 UI 按 UI-Design 复刻 DEMO |
| LLM | OpenAI 兼容 HTTP | 默认 flash 级；模型可配 |
| 部署 | 本机 + Tailscale | 不做公网多租户 |

## 3. 数据模型（逻辑）

### 3.1 实体关系

```
Book 1──* Pass（刷次）
Pass 1──* Session（本场）
Pass 1──* Message（对话气泡，属刷次）
Book 1──* Highlight（划线底库，书级）
Highlight *──? Pass（归因刷次，可空/可改）
Session 1──0..1 SummaryCard
Book 0..1 LocalFile（导入正文）
```

### 3.2 关键表（示意）

**books**  
`id, weread_id?, title, author, cover, progress, source(wechat|local|both), default_mode, created_at`

**passes**  
`id, book_id, ordinal(1=一刷), status(active|archived), started_at, note`

**sessions**  
`id, pass_id, started_at, ended_at?, mode, duration_sec, token_in, token_out, cost_est, status(open|closed)`

**messages**  
`id, pass_id, session_id?, role(user|assistant|system), kind(highlight|chat|summary|notice), body, think?, tokens?, parent_id?, variant_group?, created_at`

**highlights**  
`id, book_id, weread_mark_id?, chapter?, text, idea?, image_path?, pass_id?, deleted_at?, synced_at`

**summaries**  
`id, session_id, payload_json, promoted_to_lore(bool), created_at`

**settings**  
单行或 KV：`llm_*, weread_key, budget_default, show_clock, lock_*, persona_path, …`

**world_entries / lore_chunks**  
世界书条目与分层剧情摘要（可文件+索引表）

## 4. 线程与滤镜规则

| 概念 | 存储 | UI |
|------|------|-----|
| 刷次 Pass | `passes` + 其下全部 `messages` | 一条 Chatbox 对话 |
| 本场 Session | `sessions`；消息带 `session_id` | 默认只显示当前 session；可关滤镜 |
| 划线 | 书级 `highlights` | 归因到当前 Pass；可手动改 `pass_id` |

**开下一刷**：插入新 `passes.ordinal+1`，不自动；进度骤降仅通知。

## 5. 网关 API（PWA）

前缀建议 `/api/v1`。鉴权：可选房间钥匙 Header / 本机免鉴权。  
**下表路径名为实现建议**，可改名；能力须覆盖 [`PRD.md`](./PRD.md) 需求 ID，禁止用新路径偷加产品功能。

| 方法 | 路径（建议） | 对应能力 |
|------|--------------|----------|
| GET | `/health` | A2 |
| GET/PATCH | `/settings` | S5 |
| GET | `/books` | S1 |
| POST | `/books/import` | S2 |
| GET | `/books/:id/toc` | S1b 目录只读 |
| GET | `/books/:id/passes` | T2 |
| POST | `/books/:id/passes` | T3 |
| GET | `/passes/:id/messages` | C1/C11（`session_id` / `before` 分页） |
| POST | `/sessions` | 开场/恢复 |
| POST | `/sessions/:id/end` | R1 |
| GET | `/sessions/:id/summary` | R1/R4 |
| POST | `/chat` | 短聊 / 就此展开聊 |
| POST | `/messages/:id/regen` | C7 |
| POST | `/sessions/:id/idle-read` | C15 空闲自读（有正文） |
| GET | `/notes` | S3 |
| GET | `/stats` | S4 |
| WS/SSE | `/events` | C4/C12 推送（实现可选轮询替代） |

## 6. MCP 工具集（双助手共用）

Chatbox 共读号与剧情号挂**同一 Server**；权限相同，提示词不同（见 Agents）。

建议工具（**名称可改**；语义对齐 PRD，不另发明产品能力）：

| 工具（建议名） | 作用 | PRD |
|----------------|------|-----|
| `health_check` | 连接状态 | A2 |
| `list_bookshelf` | 同步/列出书架 | S1 |
| `open_book` | 选书；返回微信深链 + PWA 深链 | A4 |
| `start_coread` / `resume_coread` | 开场或恢复 | 5.1/5.2 |
| `end_coread` | 结束本场 → 摘要 | R1 |
| `get_progress` | 当前书进度 | 消歧·进度 |
| `update_progress_note` | 小屋展示备注（不覆盖微信进度） | 消歧 |
| `get_last_session` / `get_session_summary` | 摘要卡 | R4 |
| `list_notes` / `search_notes` | 笔记 | S3 |
| `get_recent_coread_context` | 当前刷次/上场要点（剧情号接戏；原草稿名 `get_pass_thread_hint`） | 5.4 |
| `set_mode` / `set_budget` | 改本场或默认 | C5/C8 |
| `ask_idle_read` | 查询空闲自读日志（有正文时） | C15 |

**关门锁开启时**：上述读书类工具返回明确错误；划线入库 API 仍可写。

## 7. 同步与跟批管道

```
WeRead API ──轮询 3–15s──► highlights upsert
                              │
                              ▼
                     模式/锁/预算 闸门
                              │
              ┌───────────────┼───────────────┐
              │跳过跟批        │生成           │仅收录
              ▼               ▼               ▼
           notice 气泡    LLM(think+body)   入库划线
                              │
                              ▼
                         messages + events → PWA
```

- **进度**：定时拉微信进度写 `books.progress`。  
- **失败**：消息级可见错误 + 重试；API 限流指数退避。  
- **空闲自读**（有正文时）：后台任务写日志；可被 Chatbox 询问。

## 8. LLM 调用约定

| 场景 | 谁调 | 模型配置 |
|------|------|----------|
| 跟批 / 小结 / 空闲自读 | 网关 | `settings.llm_*` |
| Chatbox 普通闲聊气泡 | Chatbox 客户端 | 用户当前模型 |
| MCP 工具执行 | 网关 | 工具本身不「扮演」；摘要生成用网关 LLM |

跟批 Prompt 装配顺序（概念）：系统人设 → 分层剧情 → 命中世界书（静默）→ 本章/近文（有正文时）→ 划线/想法 → 输出格式（think + 正文）。

**候选变体**：同一 `variant_group` 多条 assistant；UI `‹ n / m ›` 切换。

## 9. PWA 深链

| 意图 | 示例 |
|------|------|
| 进共读中 | `/#/coread?book=&pass=&session=` |
| 进书架 | `/#/cabin/shelf` |
| 健康 | `/#/cabin/settings?focus=health` |

Chatbox `open_book` 同时返回微信读书 scheme/url（平台可得范围内）。

## 10. 安全

- 钥匙：可选；无钥匙时仅监听局域网/Tailscale 接口。  
- 密钥存本机 settings（文件权限收紧）；不进 Git。  
- 备份不含明文 Key 的导出选项（或加密包）。  
- 锁状态持久化；重启保持。

## 11. 备份

- 热路径：复制 `data/` 目录。  
- 面板：导出 zip、列表、预览元数据后恢复（恢复前确认）。  

## 12. 分阶段落地

| 阶段 | 交付 |
|------|------|
| M0 | 网关 health + settings + 假数据 PWA 壳（UI 按 UI-Design） |
| M1 | 书架同步 + 划线轮询 + 跟批写入时间线 |
| M2 | MCP 开场/结束 + 摘要卡 + 双助手验证 |
| M3 | 刷次模型完整 + 预算/锁 + 记录统计 |
| M4 | 导入正文 + 沉浸共读 + 备份面板 |
| M5 | 主题素材包（非阻塞） |

## 13. 风险

| 风险 | 缓解 |
|------|------|
| 微信 API 不稳/限流 | 退避、队列、人话错误；降频选项 |
| 上下文过长 | 分层摘要 + 近文窗口；UI 显示上下文体量 |
| 单机断电 | 锁与开场状态落库；启动恢复 open session |
| UI 漂移 | UI-Design 锁定共读稿；以 DEMO 为视觉回归基准 |
