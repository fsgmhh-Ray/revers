# Chrome Web Store 上架材料（Cineflowing Reverse 助手）

> 开发者账号：`hhuang.cm`（发布者 **peterslab**，已发布 0/3）
> 扩展目录：`extension/`（打包成 zip 上传，`manifest.json` 必须在 zip 根目录）
> 版本：`0.1.0`

---

## ⚠️ 先看风险，再决定是否上架

本扩展属于**视频下载类**，且申请了 `cookies` 权限与 `youtube.com` / `instagram.com` 等宽泛主机权限。这类扩展在 Chrome 应用商店**被拒或上架后被下架的概率偏高**（Google 对"下载 YouTube 内容"较为敏感）。因此：

- **自用 / 内测 / 小范围分发** → 建议**不上架**，走"加载已解压的扩展程序"或分发 zip（见 `README.md`），零风险、零审核。
- **正式上架** → 材料我已在下方备齐，但请预期可能需要**多轮申诉**，且要有被下架的心理准备。

---

## 1. 上传前置检查（缺一不可）

- [ ] 跑一次 `node extension/scripts/make-icons.mjs` 生成 `icons/16|32|48|128.png`（**商店强制要求 128×128 PNG**）
- [ ] 把 `public/privacy.html` 随站点部署，得到可公网访问的隐私政策地址
- [ ] 准备 1–5 张截图（**1280×800** 或 **640×400**，PNG/JPG）
- [ ] 准备 1 张宣传图块（**440×280**，选填但建议）
- [ ] `extension/` 打包为 zip（根目录直接是 `manifest.json`，不要再套一层文件夹）

**打包命令（任选）：**
```powershell
# PowerShell
Compress-Archive -Path "extension\*" -DestinationPath "cineflowing-reverse-0.1.0.zip" -Force
```

---

## 2. 商店文案（可直接粘贴）

### 名称（≤45 字）
```
Cineflowing Reverse 助手
```

### 简短说明（≤132 字）
```
为 reverse.cineflowing.com 提供本机 IP 的短视频解析与下载通道，绕开机房 IP 风控，无需导出 Cookie。
```

### 详细说明
```
Cineflowing Reverse 助手是 reverse.cineflowing.com（爆款短剧反向工程工坊）的配套浏览器扩展。

【它解决什么问题】
云端服务器解析 YouTube / Instagram 时，会因为机房 IP 被平台风控而失败。本扩展让解析请求直接从你自己的浏览器发出，使用的是你的真实网络环境，因此命中率显著提升。

【主要功能】
· 一键解析 TikTok / Instagram Reels / YouTube Shorts 链接
· 复用你浏览器中已有的登录态，无需手动导出 cookie
· 通过浏览器自带下载管理器落盘，支持断点续传
· 解析结果自动回填到 reverse.cineflowing.com 的工作台，便于批量处理

【怎么用】
1. 安装本扩展
2. 打开 https://reverse.cineflowing.com
3. 粘贴视频链接，扩展会自动接管解析与下载

【说明】
· 请仅下载你有权保存的内容，并遵守各平台的服务条款与版权规定。
· 本扩展不收集、不上传你的任何数据到开发者服务器。
```

### 类别
```
生产工具（Productivity）
```

### 语言
```
中文（简体）
```

---

## 3. 权限用途说明（审核表单逐条填写）

| 权限 | 申请理由（直接粘贴） |
|---|---|
| `downloads` | 将用户请求解析出的视频文件保存到本机下载目录，走浏览器下载管理器以支持断点续传。不涉及任何自动下载。 |
| `cookies` | 仅用于让解析请求携带用户**自身**在目标平台的登录态（如 YouTube 的 SID、Instagram 的 sessionid），以解析需要登录才能访问的内容。扩展**不读取、不存储、不外传** cookie 内容。 |
| `*://*.youtube.com/*`, `*://*.youtu.be/*` | 在用户本机向 YouTube 发起视频元数据请求，获取下载直链。 |
| `*://*.googlevideo.com/*` | 访问 YouTube 的视频 CDN，用于下载实际媒体文件。 |
| `*://*.instagram.com/*`, `*://*.cdninstagram.com/*`, `*://*.fbcdn.net/*` | 在用户本机请求 Instagram 元数据与其 CDN 媒体文件。 |
| `*://*.tiktok.com/*`, `*://*.tiktokcdn.com/*`, `*://*.tiktokcdn-us.com/*`, `*://*.muscdn.com/*` | 在用户本机请求 TikTok 页面与 CDN 媒体文件。 |
| `*://*.tikwm.com/*` | 使用第三方公开解析接口作为 TikTok 的兜底解析源。 |
| `*://reverse.cineflowing.com/*`, `http://localhost:*/*` | 与配套网页应用通信（内容脚本注入与消息中继），使解析结果回填到工作台。 |

### 单一用途说明（Single Purpose）
```
本扩展的唯一用途是：为 reverse.cineflowing.com 提供以用户本机网络发起视频解析与下载的能力，从而规避机房 IP 风控。
```

### 数据使用披露（勾选项说明）
- 是否收集用户数据：**否**（不向开发者服务器传输任何用户数据）
- 是否出售/转让用户数据：**否**
- 是否用于与核心功能无关的用途：**否**
- 是否使用远程代码：**否**（全部逻辑随包分发，不加载远端脚本）

---

## 4. 隐私政策

部署 `public/privacy.html` 后，公网地址为：

```
https://reverse.cineflowing.com/privacy.html
```

（部署方式：随站点一起 `git push` 触发 Cloudflare Pages 构建，或者本地 `npm run build` 后重新发布。）

---

## 5. 截图清单（建议拍摄顺序）

1. 工作台首页（含引擎徽标显示"插件已接管"）
2. 粘贴链接 + 解析中的状态
3. 解析结果卡片（封面 / 标题 / 作者 / 画质）
4. 批量下载队列
5. 分镜逆向抽屉（如果已上线）

> 截图必须是**真实界面**，不能含虚假内容；尺寸统一 1280×800 最省事。

---

## 6. 上传步骤

1. 登录开发者后台：https://chromewebstore.google.com/devconsole
2. 右上角 **「上传新内容」**
3. 上传 `cineflowing-reverse-0.1.0.zip`
4. 依次填写：商店信息 → 隐私权 → 权限用途 → 分发范围
5. **分发范围**建议先选「不公开 / 私有」（仅测试者可见），跑通流程后再考虑公开
6. 提交审核（通常 1–3 个工作日）

---

## 7. 版本更新约定

改代码后必须**同时**递增两处版本号，否则商店会拒收：
- `extension/manifest.json` → `"version"`
- `src/config.ts` → `APP_VERSION`
