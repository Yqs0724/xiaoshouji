# 共读小屋

本机网关 + PWA。网关是唯一数据源。

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
