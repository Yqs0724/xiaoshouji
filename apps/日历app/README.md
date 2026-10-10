# 日历 App

```
apps/日历app/
  gateway/calendar.js
  pwa/
    cal.js       ← /app-ui/日历app/pwa/cal.js（CalApp.mount）
    cal.css
    view.html
  data/calendar.json
  落地进度.md
```

桌面「今日列表」经 `CalApp.fetchEvents` 读同 API。素材用母仓 `assets/cafe/`。
