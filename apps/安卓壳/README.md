# Ariadne 安卓壳（A1）

最小 WebView 壳：打开家里 Ariadne 网关。**摄像头仅占位**（不申请权限、不取帧）。

## 你需要

1. 安装 [Android Studio](https://developer.android.com/studio)（本机当前未检测到 SDK，用 Studio 打开本目录即可自动拉 Gradle）。
2. 电脑网关允许局域网访问：

```bat
set HOST=0.0.0.0
set PORT=8787
npm start
```

（在 `apps/共读app` 或母仓根目录按你平时的启动方式；关键是环境变量 `HOST=0.0.0.0`。）

3. 查电脑局域网 IP（例如 `ipconfig` → 无线/以太网 IPv4），手机填：

`http://192.168.x.x:8787`

手机与电脑同一 Wi‑Fi；或填 Tailscale IP 用第二条入口。

4. 建议开着小屋**访问密码**（门禁），因网关会暴露在局域网。

## 打开工程

1. Android Studio（`D:\安卓studio`）→ Open → 选 `apps/安卓壳` → Trust Project  
2. Android SDK 本机路径（已用官网 cmdline-tools 装好）：**`D:\Android\Sdk`**  
   （含 platform-tools / platforms;android-34 / build-tools;34.0.0；`local.properties` 已写 `sdk.dir`）  
   Studio 若再问 Select SDK，填这一路径。  
3. 等 Gradle Sync（工程已带 Wrapper + 腾讯云 Gradle 镜像 / 阿里云 Maven；若仍超时点 **Try Again**）  
4. 连真机或模拟器 → Run  
5. 也可 Build → Build APK，把 apk 拷进**隐私系统**安装

### Sync 报 `gradle-*.zip` Read timed out

官方源常超时。本仓库 `gradle/wrapper` 已指向腾讯云镜像的 **Gradle 8.2**。在 Studio 点 **Try Again**；或本机终端：

```bat
cd /d d:\cursor-projects\Ariadne\apps\安卓壳
gradlew.bat --version
```

## A1 范围

| 有 | 无 |
|----|----|
| 双地址（家庭 / Tailscale）记住 | 真摄像头 / 麦克风预申请 |
| WebView 全屏小手机 | 前台 App 使用情况 |
| 摄像头按钮 → Toast 占位 | ESP32 / 推送保活 |

## 包名

`com.ariadne.shell`
