# Cineflowing Reverse 桌面端（Electron）

把 `reverse.cineflowing.com` 包装成桌面应用，**解析与下载全部在你本机完成**。

## 为什么需要它

| 维度           | 云端内核（VPS）        | 浏览器插件             | 桌面端                     |
| -------------- | ---------------------- | ---------------------- | -------------------------- |
| 出口 IP        | 机房 IP，被 YT/IG 风控 | 你的 IP                | 你的 IP                    |
| 登录态         | 需手动导出 Cookie      | 自动带浏览器 Cookie    | `--cookies-from-browser`   |
| 最高画质       | 取决于直链             | 720p 左右（不解密签名）| **1080p+ 音视频合并**     |
| FFmpeg 抽帧    | 无                     | 无                     | 有（第二阶段分镜逆向）     |
| 分发门槛       | 无                     | Chrome 商店审核        | 免签名的免安装/安装包      |

## 快速开始

```bash
cd desktop
npm install
npm run binaries      # 下载 yt-dlp + FFmpeg 到 bin/
npm start             # 默认加载 https://reverse.cineflowing.com
```

本地联调前端时指向 dev server：

```bash
REVERSE_URL=http://localhost:5173 npm start
```

打包分发：

```bash
npm run dist          # 产出 win nsis / mac dmg / linux AppImage
```

## 目录结构

```
desktop/
├── main.js                     # 主进程：窗口 + IPC + yt-dlp 调度
├── preload.js                  # 注入 window.electronAPI
├── scripts/fetch-binaries.js   # 拉取 yt-dlp / FFmpeg
└── bin/                        # 二进制目录（gitignore，运行 npm run binaries 生成）
```

## IPC 契约

| 通道                    | 入参                                              | 说明                          |
| ----------------------- | ------------------------------------------------- | ----------------------------- |
| `cineflow:hello`        | —                                                 | 探测 yt-dlp / FFmpeg / 浏览器 |
| `cineflow:parse`        | `{ url, platform }`                               | 返回统一 `VideoMetadata`      |
| `cineflow:download`     | `{ id, url, sourceUrl, filename, cookieBrowser }` | 流式执行并回报进度            |
| `cineflow:cancel`       | `{ id }`                                          | 终止对应 yt-dlp 进程          |
| `cineflow:reveal`       | `{ path }`                                        | 在文件管理器中显示            |
| `cineflow:download-progress` | 主进程 → 渲染进程 `{ id, percent, done, error }` | 进度事件             |

## 几个实现取舍

1. **下载时用原始页面链接而非直链** —— 直链带签名且会过期，重新对原始地址跑
   yt-dlp 才能拿到 `bestvideo+bestaudio` 并用 FFmpeg 合并，画质和稳定性都更好。
   `main.js` 里 `isPlatformUrl(sourceUrl)` 就是干这个的。
2. **Cookie 浏览器自动探测** —— 设置里选 `auto` 时会按
   chrome → edge → brave → firefox → vivaldi 的顺序挑一个本机已安装的。
3. **下载目录固定** `~/Downloads/Cineflowing`，避免与浏览器下载混在一起。

## 后续：第二阶段

本地已有 FFmpeg，分镜逆向可以直接在客户端做：

```bash
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',showinfo" -vsync vfr -frame_pts true out_%06d.jpg
```

提取的关键帧 + 音频交给多模态大模型，即可产出 `StoryboardNode[]`（契约见 `src/types/storyboard.ts`）。
这样做的好处是算力不出本机，服务器成本为零。
