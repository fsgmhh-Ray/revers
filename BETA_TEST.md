# 内测指南（BETA）

> 版本：插件 `0.1.0` · 桌面端 `0.2.1`
> 目标：在**不发布到 Chrome 商店**的前提下，把两条本机链路（插件 / 桌面端）跑通并收集问题。
> 上架（Chrome Web Store）押后到本指南的验证清单全部通过之后。
> 0.2.0 新增：**分镜逆向拆解**（本机 FFmpeg 抽帧）、**下载目录自选**、下载位置可见。
> 0.2.1 新增：**导入 cookies.txt 提供登录态**（短剧 / 限区 / 需登录内容）、yt-dlp 报错翻译成人话。

---

## 0. 一分钟决定装哪个

| 你的诉求 | 装哪个 | 代价 |
| --- | --- | --- |
| 只是想解析得快、不折腾 | **Chrome 插件** | 30 秒装完，最高约 720p |
| 要 1080p+ 画质 / **分镜逆向拆解** | **桌面端** | 装一次，188MB |
| 两个都装 | 没问题 | 桌面端优先级更高，会自动接管 |

引擎优先级：**桌面端 > 插件 > 云端**。三个都可用时不冲突，业务层只用一个。

> ⚠️ **分镜拆解只有桌面端能做**。它需要本机 FFmpeg 抽帧与本地文件读写权限，
> 插件和云端链路拿不到这些能力，页面会如实提示。这不是 bug。

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
C:\Users\Administrator\WorkBuddy\2026-09-11-12-52-39\reverse.cineflowing.com\desktop\dist\Cineflowing Reverse Setup 0.2.1.exe
```

### 2.2 验证清单

**基本链路**

- [ ] **双击能打开窗口**（标题栏 `Cineflowing Reverse`），窗口内加载出站点首页
- [ ] 顶部引擎胶囊显示 **「本地桌面端 · 本地」**
- [ ] 顶部右侧显示 **「已连接 · Ns」**，秒数每秒跳动（主站心跳，45s 一轮拉取）
- [ ] 粘贴 **YouTube** 链接 → 解析出 **1080p+** 画质选项（yt-dlp + 内置 FFmpeg 合并音视频）
- [ ] 断网 10 秒 → 连接点变 **「离线」**；恢复网络后自动回到「已连接」

**下载位置（0.2.0 新增）**

- [ ] 右上角齿轮 → 「下载位置」显示当前目录，默认是 `C:\Users\Administrator\Downloads\Cineflowing`
- [ ] 点 **选择目录…** → 弹出系统目录选择框，选一个别的目录后设置立即生效
- [ ] 点 **打开文件夹** → 资源管理器定位到该目录
- [ ] 下载一个视频 → 文件出现在你选的目录里
- [ ] 下载完成后，任务卡片显示**本地完整路径**，点 **打开所在文件夹** 能定位到文件

**分镜逆向（0.2.0 新增，核心功能）**

- [ ] 先下载一个视频到本机（分镜需要本地文件）
- [ ] 点任务卡片的 **分镜** → 打开拆解抽屉，左侧显示「本地文件：已就绪」
- [ ] 点 **一键拆解** → 进度条走到 100%，右侧出现分镜卡片网格
- [ ] 每个卡片有：关键帧缩略图、`#序号 · 时间码`、时长、景别、运镜、`起 → 止`
- [ ] 顶部统计显示镜头数 / 平均镜头时长 / 总时长 / 分辨率，并给出剪辑节奏判定
- [ ] 调整 **场景灵敏度** 后重新拆解 → 镜头数量随之变化（值越小切得越多）
- [ ] 点 **导出 Markdown / CSV / JSON** → 浏览器下载出文件，内容与界面一致
- [ ] 未下载就点「一键拆解」→ 给出"请先下载到本机"的提示，而不是静默失败

**短剧 / 需登录内容（0.2.1 新增）**

TikTok 短剧（`dramaInfo` 剧集）、限区内容、年龄限制内容，**匿名请求拿不到播放地址** ——
TikTok 只把 `playAddr` 发给有权限的账号（实测抓到的剧集页 `playAddr` / `downloadAddr` / `bitrateInfo` 全为空，
但 `statusCode` 仍是 0，即"内容正常但不对你开放"）。要下载这类内容必须提供登录态。

- [ ] 未导入 cookies.txt 时解析短剧 → 报错**不再是**光秃秃的 `No video formats found!`，
      而是中文说明（指出是短剧/限权内容 + 给出下一步）
- [ ] 用浏览器扩展（如 "Get cookies.txt LOCALLY"）导出**已登录 TikTok** 的 cookies.txt
- [ ] 右上角齿轮 → 「登录态（cookies.txt）」→ **导入 cookies.txt…** → 显示「有效 · N 条 Cookie」
- [ ] 若提示「不含 tiktok.com」→ 说明导出时没在 TikTok 域下，回去重新导出
- [ ] 再次解析该短剧 → 能出画质选项即登录态生效
- [ ] **清除** → 回到未导入状态

### 2.3 已知限制（内测期）

**链路相关**

- ⚠️ **Chrome / Edge 的 Cookie 直接读取在本机已失效**，是双重原因：
  ① 浏览器运行时独占锁定 Cookies 数据库（连复制都失败，yt-dlp #7271）；
  ② Local State 里存在 `app_bound_encrypted_key`，即启用了 App-Bound 加密，密文在浏览器进程外解不开。
  **关掉浏览器只能绕过 ①，绕不过 ②。** 所以「读取登录态的浏览器」只作兜底，
  需要登录态时请用「导入 cookies.txt」。
- 安装包未做代码签名，SmartScreen 会拦一次，属预期。
- **「双击能开窗」这一环在无桌面环境里无法验收**，逻辑层（二进制定位、
  yt-dlp/ffmpeg 可执行、IPC 契约、分镜管线、cookies.txt 校验）已全部自动化验证通过。
- cookies.txt 会过期（尤其 `sessionid`）。解析突然又失败时，先重新导出一次再排查其它原因。
- 导入 cookies.txt 后，**浏览器登录态不会被自动同步**，需要重新导出导入。

**分镜相关（重要，别误判成 bug）**

- 现在的分镜是**「物理分镜」**：镜头切分、起止时间、关键帧、镜头时长、剪辑节奏都是真实算出来的。
- **景别与运镜是由剪辑时长推断的**（例如 < 1.2s 判为特写），卡片上标了「由剪辑时长推断」。
- **台词与画面描述目前是空的**，Flux.1 / Wan2.1 的 Prompt 也是空位 ——
  这一层需要多模态大模型读画面，属于下一步（占用的是同一套数据结构，接入后自动填充，不用改 UI）。
- 长视频场景检测需要解码全片，10 分钟以上会明显变慢（单次调用有 10 分钟硬超时保护）。
- 单次最多输出 48 个镜头，超出的会等间隔抽稀，避免一次抽几百帧把内存打满。

### 2.4 无头自检（可选，CI 用）

```bash
cd desktop
npm run smoke            # 35 项契约断言，含 yt-dlp/ffmpeg 探测、cookies.txt 校验、报错翻译
npm run storyboard       # 合成三场景视频，真跑场景切分 + 抽帧（13 项）
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
| 桌面端安装包 | `desktop/dist/Cineflowing Reverse Setup 0.2.1.exe` |
| 插件商店文案 | `extension/STORE_LISTING.md` |
| 隐私政策页 | `public/privacy.html` → <https://reverse.cineflowing.com/privacy.html> |

重新生成插件 zip：

```bash
cd extension && node scripts/pack.mjs
```
