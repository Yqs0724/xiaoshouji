# Ariadne · shell（小手机壳）

> 壳屏归属与剥离边界。运行时入口仍在 `apps/共读app/pwa/`（单页、不重写 App）。  
> 真源契约见仓库根 [`壳契约.md`](../壳契约.md)。

## 壳拥有的屏（现行 DOM 仍在共读 PWA 内）

| 屏 | id | 素材（母仓 `assets/cafe/` 等） |
|----|-----|----------------------------------------|
| 锁屏 | `#view-standby` | `lock-wall.jpg` |
| 桌面 | `#view-home` | `home-wall.jpg`；图标多枚 cafe 贴纸 |
| 手机设置 | `#view-phone-settings` | 与小屋同框皮，内容属壳 |
| 资料 | `#view-profile` | 双头像；「正在做什么」可读共听 presence |
| 门禁 | `#gateOverlay` | 壳级 |

## App 不属本目录（模块真源在各 `apps/*`；UI 暂挂共读 pwa）

| App | 视图 id | 模块 |
|-----|---------|------|
| 共读小屋 / 共读中 | `#view-cabin` / `#view-coread` | `apps/共读app` |
| 日历 | `#view-cal` | `apps/日历app` |
| 日常聊天 | `#view-chat` | `apps/聊天app` |
| 共看 | `#view-cowatch` · `#view-cowatch-play` | `apps/共看app` |
| 共听 | `#view-colisten` | `apps/共听app/pwa`（逻辑 `/assets-colisten/colisten.js`；皮 `/assets/colisten/`） |
| 额度 | `#view-budget` | `apps/额度app` |
| 资产 | `#view-wallet` | `apps/资产app`（iframe→`wealth.html`；W.1 DEMO，真账暂缓 D40） |
| stub | `#view-app-stub` | 生活多图标 / 花宠 / 共漫 / 2.5D「小屋」等未开工入口 |

## 为何暂不把 HTML 拆进本目录

完整小手机设想未定；把单页拆成 iframe/第二套壳会丢细节（已失败过一次）。  
**本阶段迁移 = 目录分明 + 契约挂载**；物理抽文件等壳脑暴定案后再做，且必须对照现行 pwa / UI-Design **原样**搬，禁止重写。

## 导航（语义）

```
锁屏 ↔ 桌面 → 共读小屋 | 设置 | 日历 | 聊天 | 共看 | 共听 | …
```

桌面 App 显隐由 `settings.app_hidden`；图标写在 `pwa/index.html` 栅格 / Dock。
