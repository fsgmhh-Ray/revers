# 内测指南（BETA）

> 版本：插件 `0.1.0` · 桌面端 `0.1.0`
> 目标：在**不发布到 Chrome 商店**的前提下，把两条本机链路（插件 / 桌面端）跑通并收集问题。
> 上架（Chrome Web Store）押后到本指南的验证清单全部通过之后。

---

## 0. 一分钟决定装哪个

| 你的诉求 | 装哪个 | 代价 |
| --- | --- | --- |
| 只是想解析得快、不折腾 | **Chrome 插件** | 30 秒装完，最高约 720p |
| 要 1080p+ 画质 / 本地 FFmpeg 抽帧 / 第三阶段分镜 | **桌面端** | 装一次，188MB |
| 两个都装 | 没问题 | 桌面端优先级更高，会自动接管 |

引擎优先级：**桌面端 > 插件 > 云端**。三个都可用时不冲突，业务层只用一个。

---

## 1. 插件内测（约 1 分钟）

### 1.1 加载

1. Chrome 地址栏输入 `chrome://extensions` 回车
2. 右上角打开 **开发者模式**（开关变蓝）
3. 左上角点 **加载已解压的扩展程序**
4. 选择目录（**就选这一层，不要再往里点**）：

```
C:\Users\Administrator\WorkBuddy\2026-09-11-12-52-39\reverse.cineflowing.com\extension
```

> ⚠️ 常见错误：进到 `icons` / `scripts` / `test` / `dist` 里再去选。
> Chrome 只认 `manifest.json` 所在的那一层目录。

5. 列表里应出现 **Cineflowing Reverse 助手 0.1.0**

如果不想用源码目录，也可以用分发包解压后加载：

```
C:\Users\Administrator\WorkBuddy\2026-09-11-12-52-39\reverse.cineflowing.com\extension\dist\cineflowing-reverse-0.1.0.zip
```

### 1.2 验证清单

- [ ] 点浏览器右上角扩展图标，弹出面板显示 **YouTube / Instagram / TikTok** 三行状态
      （圆点亮 = 检测到你已登录该平台，解析时会带上登录态）
- [ ] 打开 <https://reverse.cineflowing.com>，顶部引擎胶囊显示 **「浏览器插件 · 插件」**
- [ ] 若仍显示云端：点胶囊上的 **↻** 重新探测（装完插件刷新页面通常会自动切换）
- [ ] 粘贴一条 **TikTok** 链接 → 解析成功（云端也能，主要看链路是否走插件）
- [ ] 粘贴一条 **YouTube** 链接 → 解析成功（这是插件的核心价值：本机 IP + 登录态绕风控）

### 1.3 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面检测不到插件 | 站点不是 `reverse.cineflowing.com` / `localhost` | content script 只注入这两个域 |
| 胶囊一直显示云端 | 探测在装插件之前跑完了 | 刷新页面，或点 ↻ |
| popup 三个点全灰 | 未登录对应平台 | 正常，YouTube/IG 未登录时解析成功率会低 |

---

## 2. 桌面端内测（约 2 分钟）

### 2.1 安装

安装包（未签名，Windows 会提示"未知发布者"，允许即可）：

```
C:\Users\Administrator\WorkBuddy\2026-09-11-12-52-39\reverse.cineflowing.com\desktop\dist\Cineflowing Reverse Setup 0.1.0.exe
```

### 2.2 验证清单

- [ ] **双击能打开窗口**（标题栏 `Cineflowing Reverse`），窗口内加载出站点首页
- [ ] 顶部引擎胶囊显示 **「本地桌面端 · 本地」**
- [ ] 顶部右侧显示 **「已连接 · Ns」**，秒数每秒跳动（主站心跳，45s 一轮拉取）
- [ ] 粘贴 **YouTube** 链接 → 解析出 **1080p+** 画质选项（yt-dlp + 内置 FFmpeg 合并音视频）
- [ ] 点下载 → 文件落到系统下载目录且能正常播放
- [ ] 断网 10 秒 → 连接点变 **「离线」**；恢复网络后自动回到「已连接」

### 2.3 已知限制（内测期）

- 首次解析 YouTube 会尝试读 Chrome 的 Cookie。**Chrome 正在运行时**或
  Chrome 127+ 的 App-Bound 加密（yt-dlp #7271）可能导致读取失败 ——
  已做降级：自动去掉 Cookie 重试，只是成功率下降，不会整体报错。
- 安装包未做代码签名，SmartScreen 会拦一次，属预期。
- **「双击能开窗」这一环是在无桌面环境里无法验收的**，逻辑层（二进制定位、
  yt-dlp/ffmpeg 可执行、IPC 契约）已全部自动化验证通过。这是本次内测最主要要看的一条。

### 2.4 无头自检（可选，CI 用）

```bash
cd desktop
npm run smoke            # 21 项契约断言，含 yt-dlp/ffmpeg 探测
npm run probe:packaged   # 验证打包后二进制定位（asar 解包路径）
```

---

## 3. 反馈怎么给

把下面这段复制填一下发回来即可：

```text
环境：Windows ___ / Chrome ___
装的是：插件 / 桌面端 / 两个都装

[插件]
- 能否加载成功：
- 顶部胶囊显示：
- TikTok 解析：
- YouTube 解析：

[桌面端]
- 双击能否开窗：
- 胶囊显示：
- 右上角连接状态：
- YouTube 最高画质：
- 下载是否成功：

其他问题/报错原文：
```

---

## 4. 上架前的待办（内测通过后再动）

- [ ] **创建 GitHub Release `v0.1.0` 并上传安装包**（188MB）。
      目前 <https://github.com/fsgmhh-Ray/revers/releases> 是空的，
      网页上「下载桌面端」按钮会跳到一个空页面 —— 内测阶段请直接用上面的本机路径。
- [ ] Chrome 商店：账号 `hhuang.cm`，发布者 `peterslab`，配额 0/3
      - 隐私政策 URL：`https://reverse.cineflowing.com/privacy.html`（已部署）
      - 商店文案：`extension/STORE_LISTING.md`
- [ ] ⚠️ 视频下载类扩展 + `cookies` 权限 + YouTube 主机权限，
      在 Chrome 商店**被拒/下架风险高**。建议继续保持"内测分发"形态，
      或先提交为 **不公开（Unlisted）** 观察审核反馈。

---

## 5. 产物速查

| 产物 | 路径 |
| --- | --- |
| 插件源码（加载已解压用） | `extension/` |
| 插件分发包 zip | `extension/dist/cineflowing-reverse-0.1.0.zip` |
| 桌面端安装包 | `desktop/dist/Cineflowing Reverse Setup 0.1.0.exe` |
| 插件商店文案 | `extension/STORE_LISTING.md` |
| 隐私政策页 | `public/privacy.html` → <https://reverse.cineflowing.com/privacy.html> |

重新生成插件 zip：

```bash
cd extension && node scripts/pack.mjs
```
