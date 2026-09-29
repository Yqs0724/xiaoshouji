# 薄巧弹窗皮

## 现行结构（`pwa/index.html` 的 `.sheet-panel` / 门禁卡）

1. **屏边留白**：`.sheet` 左右 padding；面板 `max-width: 420px`，不贴满屏
2. **外框**：与共读中同款墙纸 `assets/cafe/wall.jpg` 平铺（`background-size: 220px`）；**不加**半透明淡罩（罩会把边框染色）；右上角巧克力斜条为 CSS 渐变点缀
3. **顶/底长条**：`sheet-top.png` / `sheet-bot.png`（黑底已抠透明；CSS `background-size: 100% 100%` 拉满框宽；略降饱和）
4. **内卡**：`.sheet-card` 奶油底，选项落在内卡里；标题类 `.sum-head` 可放在内卡外（如「更多」）免与可点行混淆
5. **全屏遮罩**：仅 `.sheet` 为中性淡黑 `rgba(20, 18, 16, .28)`。门禁 `#gateOverlay` 全屏底仍是偏绿 `rgba(45, 62, 56, .5)`（与弹窗 sheet 分开）

长短只撑高内卡；墙纸不变形。

## 目录里其它文件

| 文件 | 现状 |
|------|------|
| `sheet-top.png` / `sheet-bot.png` | **在用** · 弹窗顶/底长条 |
| `frame-grid-tile.jpg` / `sheet-dot-tile.jpg` | 曾试薄荷绿格外框；**现行外框已改 wall.jpg**，文件仍留在目录 |
| `corner-*.png`、`sheet-skin*.jpg`、`sheet-inner.jpg` 等 | 早期试皮素材；**现行 CSS 未引用** |
| `sheet-bot-sweet.png` | 备用底条；现行用 `sheet-bot.png` |
