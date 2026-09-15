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
npm run icon          # 生成 build/icon.ico（打包用）
npm start             # 默认加载 https://reverse.cineflowing.com
```

本地联调前端时指向 dev server：

```bash
REVERSE_URL=http://localhost:5173 npm start
```

打包分发：

```bash
npm run dist          # 产出 Windows nsis 安装包
npm run pack          # 只产出免安装目录 dist/win-unpacked
```

## 自测（不依赖外网，几秒出结果）

```bash
npm run check          # node --check 全部脚本语法
npm run smoke          # 无头窗口跑通 preload 桥接 + IPC 契约（21 项断言）
npm run parse          # 真实走一遍 yt-dlp 解析链路
npm run parse -- "https://www.tiktok.com/@user/video/123..."   # 用真实链接
npm run selfcheck      # 自检：随包二进制可定位、可执行（写 %TEMP%）
npm run dist           # 打包 Windows nsis 安装包
npm run probe:packaged # 验证打包产物（关键：仅需 Node，不需要桌面会话）
npm run ci             # 一键：安装→二进制→图标→语法→冒烟→打包→验证产物
```

| 命令 | 通过标志 | 退出码 |
| ---- | -------- | ------ |
| `npm run smoke` | `SMOKE_OK` | 0 |
| `npm run parse` | `PARSE_OK` | 0 |
| `npm run selfcheck` | `SELF_CHECK_OK` | 0 |
| `npm run probe:packaged` | `PROBE_OK` | 0 |

### 打包产物一定要验（重要）

开发环境的 `npm run smoke` **永远不会**暴露 asar 打包问题——它跑的是源目录。
所以打完包务必跑一次产物验证：

```bash
npm run dist
npm run probe:packaged
```

它会用打包后的客户端以 Node 模式运行探针，验证 `binDir` 是否落在
`app.asar.unpacked\bin`、以及随包的 `yt-dlp` / `ffmpeg` 能否**真的被拉起来**
（打印版本号）。之所以走 Node 模式而不是正常 GUI 启动，是因为 CI / 无头服务器
没有桌面会话，GUI 起不来；Node 模式绕开这个依赖，且 stdout 可用。

正常 GUI 启动的验证请在带桌面的机器上双击安装包完成（1 分钟）。

> 若要在装机后排查环境问题，也可以让已安装的客户端自检：
> ```bat
> set CINEFLOW_SELF_CHECK=1
> "Cineflowing Reverse.exe"
> type "%LOCALAPPDATA%\Programs\Cineflowing Reverse\cineflowing-self-check.json"
> ```
> 报告里的 `packed` 应为 `true`、`binDir` 应指向 `app.asar.unpacked\bin`、
> `ytDlpVersion` 应有值，任何一项不对客户端都拉不起解析。
> （用环境变量而不是命令行参数触发，是因为打包后的可执行文件会把未知的 `--xxx`
> 当作 Chromium 开关校验并直接报 `bad option` 退出。）

> ⚠️ 若环境里存在 `ELECTRON_RUN_AS_NODE=1`（某些 IDE / 沙箱会注入），
> Electron 会退化成纯 Node，表现为 `require('electron')` 返回路径字符串、
> `ipcMain` 为 `undefined`，紧接着在注册 IPC 时抛异常。开发态请统一用
> `npm start` / `npm run smoke`（它们走 `scripts/run-electron.js`，会先清掉该变量）。

## 目录结构

```
desktop/
├── main.js                     # 启动层：窗口 + 生命周期（含 --self-check 自检分支）
├── ipc.js                      # 能力层：解析 / 下载 / 主站长连接的全部 IPC 处理器
├── config.js                   # 共享配置：APP_URL / VERSION / BIN_DIR
├── preload.js                  # 注入 window.electronAPI
├── smoke.test.js               # 无头冒烟自测（契约）
├── parse.test.js               # 真实解析自测（链路）
├── scripts/fetch-binaries.js   # 拉取 yt-dlp / FFmpeg
├── scripts/make-icon.js        # 生成 build/icon.ico
├── scripts/run-electron.js     # Electron 启动包装（清掉 ELECTRON_RUN_AS_NODE）
├── scripts/probe-packaged.cjs  # 产物探针（由打包后的 exe 以 Node 模式执行）
├── scripts/run-probe.js        # 产物验证器（npm run probe:packaged）
├── build/icon.ico              # 安装包图标（npm run icon 生成）
└── bin/                        # 二进制目录（gitignore，npm run binaries 生成）
```

**为什么把 `main.js` 拆出 `ipc.js`：** Electron 主进程里 `require.main` 是 `undefined`，
没法用 `require.main === module` 判断"是否作为入口启动"。只有把能力层拆成独立模块，
冒烟自测才能直接复用**真实的**处理器，测到的是真契约而不是另写的假桩。

## IPC 契约

| 通道                    | 入参                                              | 说明                          |
| ----------------------- | ------------------------------------------------- | ----------------------------- |
| `cineflow:hello`        | —                                                 | 探测 yt-dlp / FFmpeg / 浏览器 / Cookie 可用性 |
| `cineflow:parse`        | `{ url, platform }`                               | 返回统一 `VideoMetadata`      |
| `cineflow:download`     | `{ id, url, sourceUrl, filename, cookieBrowser }` | 流式执行并回报进度            |
| `cineflow:cancel`       | `{ id }`                                          | 终止对应 yt-dlp 进程          |
| `cineflow:reveal`       | `{ path }`                                        | 在文件管理器中显示            |
| `cineflow:pick-dir`     | —                                                 | 弹系统目录选择框              |
| `cineflow:feed`         | —                                                 | 取运营投放内容（升级/广告/推广） |
| `cineflow:feed-state`   | —                                                 | 主站连接状态 `{ online, lastSync, interval }` |
| `cineflow:download-progress` | 主进程 → 渲染进程 `{ id, percent, done, error }` | 进度事件             |

## 几个实现取舍

1. **下载时用原始页面链接而非直链** —— 直链带签名且会过期，重新对原始地址跑
   yt-dlp 才能拿到 `bestvideo+bestaudio` 并用 FFmpeg 合并，画质和稳定性都更好。
   `ipc.js` 里 `isPlatformUrl(sourceUrl)` 就是干这个的。
2. **Cookie 是"尽力而为"，绝不让它拖垮解析** —— 见下一节。
3. **下载目录固定** `~/Downloads/Cineflowing`，避免与浏览器下载混在一起。
4. **打包时二进制必须解包** —— 见"打包注意事项"。

## Cookie 策略：带降级，绝不因读不到登录态而整体失败

读本机浏览器 Cookie 是桌面端的核心优势，但**它并不总能成功**：

- Chrome / Edge 正在运行时，Cookie 数据库被锁定；
- Chrome 127+ 引入 App-Bound Encryption，跨进程解密会失败（yt-dlp issue #7271）；
- 该浏览器从未登录过对应平台。

早期实现无条件加 `--cookies-from-browser`，结果**连不需要登录的普通解析都会整体报错**。
现在的策略是：

1. 平台链接才尝试读 Cookie（普通直链直接跳过，省掉一次无谓失败）；
2. 命中 Cookie 类错误 → 记住该浏览器本次会话不可用 → **去掉 Cookie 重试**；
3. 解析结果会带上 `cookieUsed` / `cookieWarning`，前端可据此提示用户；
4. 下载路径同样降级：带 Cookie 失败则自动去掉 Cookie 重跑一次。

`hello()` 返回的 `cookies` 字段给出快照：`{ installed, usable, failed, active }`。

> 若你的 YouTube / Instagram 解析失败而 TikTok 正常，通常是"没读上登录态"。
> 可尝试：关掉 Chrome 后再试；或改用 Firefox（其 Cookie 无 App-Bound 加密，最易读取）。

## 打包注意事项

| 坑 | 说明 |
| -- | ---- |
| **二进制必须解包** | Electron 无法从 `app.asar` 归档里 `spawn` 子进程（asar 不是真实文件系统，会 ENOENT）。因此 `package.json` 里配了 `"asarUnpack": ["bin/**"]`，`config.js` 会把 `BIN_DIR` 重写到 `app.asar.unpacked/bin`。少了这一步，装完客户端会完全找不到 yt-dlp / FFmpeg。 |
| **图标** | `npm run dist` 前先 `npm run icon`，否则安装包用 Electron 默认图标。 |
| **跨平台** | macOS 的 `.dmg` 与 Linux 的 `.AppImage` 必须在对应系统上打包，electron-builder 不支持跨平台输出这两种格式。 |
| **`ELECTRON_RUN_AS_NODE`** | 某些 IDE / 沙箱会注入该变量，使 `electron.exe` 退化为纯 Node，表现为 `require('electron')` 只返回路径字符串、`app` 为 `undefined`。`scripts/run-electron.js` 会在启动前清掉它，请统一用 `npm start` / `npm run smoke` 而不是直接调 electron。 |

## 客户粘性：主站长连接 + 运营投放

桌面端启动后会以 `heartbeatIntervalSec`（默认 45s，服务端可调控）为周期向
`https://reverse.cineflowing.com/api/client-feed` 发起心跳，并广播：

- `cineflow:connection` —— 在线 / 离线（跟随系统网络 + 心跳成败）
- `cineflow:feed` —— 运营投放内容（升级 / 广告 / 推广）

网页端与插件端走同一套前端通道（`src/services/clientChannel.ts`），直接请求同源
`/api/client-feed`，无需区分运行环境。

**运营如何投放广告 / 推广 / 升级公告：** 编辑 `functions/api/client-feed.ts` 里的 `FEED`
配置即可，无需改代码、无需重新打包客户端：

| 字段 | 作用 |
| ---- | ---- |
| `latestVersion` / `minVersion` | 升级与强制升级判定（带 `?v=` 上报的客户端版本比对） |
| `upgrade` | 升级公告标题 / 说明 / 下载页 |
| `banner` | 常驻推广条（主站 / 活动 / 广告位），可置 `null` 关闭 |
| `promos[]` | 推广 / 广告队列，支持 `startAt` / `endAt` 控制上下架 |

界面呈现见 `src/components/ClientFeed.tsx`：顶部推广条 + 升级提示（可关闭，
`localStorage` 记忆），顶栏「已连接主站 · Xs」状态点来自 `Header.tsx`。

## 后续：第二阶段

本地已有 FFmpeg，分镜逆向可以直接在客户端做：

```bash
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',showinfo" -vsync vfr -frame_pts true out_%06d.jpg
```

提取的关键帧 + 音频交给多模态大模型，即可产出 `StoryboardNode[]`（契约见 `src/types/storyboard.ts`）。
这样做的好处是算力不出本机，服务器成本为零。
