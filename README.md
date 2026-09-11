# REVERSE · 爆款短剧反向工程工坊

> `reverse.cineflowing.com` —— cineflowing.com 矩阵的引流与生产力子站点。
> 输入 TikTok / Instagram Reels / YouTube Shorts 链接 → 批量下载无水印高清原片 →（Stage 2）逆向拆解为影视分镜剧本与 AI 生图 / 视频 Prompt → 一键导入主站。

技术栈：**React 18 + TypeScript + Tailwind CSS + Vite**，前端与 API 部署在 **Cloudflare Pages**（Pages Functions 作为边缘网关）。

---

## 1. 架构拓扑

```
[ 浏览器 React SPA (Cloudflare Pages) ]
        │  POST /api/parse
        ▼
[ Cloudflare Pages Functions —— 边缘网关 ]
        ├── normalize & detectPlatform
        ├── parser-core 自建内核  ──(Cloudflare Tunnel)──> [ Oracle VPS · yt-dlp ]
        │       解析 IG / YT / 抖音 / 小红书，规避 CF 出口 IP 封禁
        └── TikWM 公共源           (TikTok 兜底，零配置可用)
        │
        ▼  返回统一 VideoMetadata（无水印直链）
[ 客户端 ] ──GET /api/proxy-download──> Blob 保存 / ZIP 打包
                    │
                    ├── 边缘直连上游 CDN（快，命中缓存时）
                    └── 回退：源站代拉 /api/fetch（YT / IG 直链绑定 IP 时必须走这条）
```

**为什么需要自建内核**：YouTube 与 Instagram 会封禁 Cloudflare 数据中心网段（403 / CAPTCHA），
仅靠 Worker 原生 `fetch` 无法长期稳定抓取。因此 IG / YT 必须走独立 VPS 上的 `parser-core`。

**为什么下载也要过内核**：YT / IG 的视频直链绑定了首次解析时的出口 IP 且带时效签名，
Cloudflare 边缘回源拉取会被判 403。`proxy-download` 会先尝试边缘直连，失败自动回退到
内核的 `/api/fetch` 由 VPS 代拉（对 `googlevideo.com`、`fbcdn.net`、`douyinvod.com` 等域名默认直接走源站）。

### 1.1 三擎分发（Progressive Matrix Architecture）

服务端解析的天花板是**机房 IP 被风控**。因此解析与下载按能力分三层，
页面启动时自动嗅探，取第一个就绪的引擎，业务代码全程只面对同一个 `Engine` 接口：

| 优先级 | 引擎 | 出口 IP | 登录态 | 最高画质 | 分发门槛 |
| --- | - | --- | --- | --- | --- |
| 1 | **桌面端** `desktop/`（Electron + yt-dlp） | 用户本机 | `--cookies-from-browser` 直读 | 1080p+ 音视频合并 | 免安装/安装包 |
| 2 | **浏览器插件** `extension/`（MV3） | 用户本机 | 浏览器现成 Cookie | 720p 左右 | Chrome 商店审核 |
| 3 | **云端内核** `parser-core/`（VPS） | 机房 IP | 需导出 cookies.txt | 取决于直链 | 无 |

```
                     ┌─ window.CINEFLOW_RUNTIME === 'electron' ?  →  electronBridge (IPC)
页面点击「解析」──►  ├─ <html data-cineflow-extension> ?           →  extensionBridge (postMessage)
  resolveEngine()    └─ 否则                                        →  cloudBridge (fetch /api/parse)
```

相关源码：`src/services/engineRouter.ts`（路由）、`src/services/types.ts`（`Engine` 契约）、
`src/hooks/useEngine.ts`（React 状态）、`src/components/EngineBadge.tsx`（状态胶囊 + 升级引导）。

## 2. 目录结构

```
.
├── extension/                       # Chrome MV3 插件（用户本机 IP 解析 + downloads 落盘）
├── desktop/                         # Electron 桌面端（内置 yt-dlp + FFmpeg）
├── functions/                       # Cloudflare Pages Functions（边缘网关）
│   ├── _lib/
│   │   ├── types.ts                 # Env / ApiContext 契约
│   │   ├── http.ts                  # JSON 响应、平台识别、文件名消毒
│   │   └── providers.ts             # Mock / Cobalt / yt-dlp / TikWM 解析链
│   └── api/
│       ├── parse.ts                 # POST 解析分发；GET 健康检查
│       └── proxy-download.ts        # 流式中转（防 CORS / 防盗链 / SSRF 白名单）
├── parser-core/                     # 自建解析内核（yt-dlp，Cobalt 协议兼容）
│   ├── src/server.js
│   ├── Dockerfile
│   └── docker-compose.yml
├── src/
│   ├── components/                  # Header / UrlBatchInput / Toolbar / VideoPreviewCard / ...
│   ├── services/                    # 三擎分发：types / engineRouter / *_Bridge
│   ├── hooks/
│   │   ├── useTaskManager.ts        # 任务队列调度状态机（解析 + 下载并发控制）
│   │   ├── useEngine.ts             # 引擎探测与就绪状态
│   │   └── useSettings.ts           # 本地偏好（引擎、并发数、ZIP、文件名规则）
│   ├── types/                       # parser.ts / storyboard.ts（Stage 2 契约）
│   └── utils/                       # platform.ts / downloader.ts / id.ts
├── vite-plugin-dev-api.ts           # 本地复用 functions/ 的 Vite 中间件（单一代码源）
└── wrangler.toml
```

## 3. 本地开发

```bash
npm install
npm run dev          # http://localhost:5173
```

`npm run dev` 会通过 `vite-plugin-dev-api.ts` 直接复用 `functions/api/*.ts`，
本地与生产行为一致，**不需要额外跑 wrangler**。环境变量写在 `.env.local`（已 gitignore）。

只想看 UI 效果、暂时不接解析源？在 `.env.local` 加一行：

```bash
MOCK_PARSER=1        # 返回示例素材，用于联调 UI 与下载链路
```

## 4. 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `COBALT_INSTANCE_URL` | 自建 parser-core 地址，如 `https://api-reverse.cineflowing.com`（IG / YT 必需） | 空 |
| `COBALT_API_KEY` | 内核密钥，请求头 `Authorization: Api-Key xxx` | 空 |
| `FORCE_ORIGIN_PROXY` | `1` 时所有下载一律由内核代拉（默认已按域名自动判断） | 空 |
| `YTDLP_SERVICE_URL` | 另一个 Cobalt 协议兼容服务（可选） | 空 |
| `TIKWM_API_URL` | TikTok 公共兜底源，设为 `off` 可关闭 | `https://www.tikwm.com/api/` |
| `ALLOWED_DOWNLOAD_HOSTS` | 追加允许中转的域名（逗号分隔） | 内置 CDN 白名单 |
| `MAX_DOWNLOAD_BYTES` | 单文件大小上限，0 为不限 | `0` |
| `MOCK_PARSER` | `1` 开启演示模式 | 空 |

> `ALLOW_ANY_HOST=1` 仅供本地调试，**生产环境切勿开启**（会有 SSRF 风险）。

## 5. 部署自建解析内核（VPS + Cloudflare Tunnel）

采用 **Cloudflare Tunnel（Zero Trust）** 架构：VPS 不开任何公网端口，
无需配置 Oracle 安全列表 / iptables，自带边缘 HTTPS，源站 IP 不暴露。

```bash
# 在 Oracle VPS 上
git clone https://github.com/fsgmhh-Ray/revers.git && cd revers/parser-core
chmod +x deploy.sh
./deploy.sh                      # 构建启动 + 健康检查 + 打印 API_KEY
./deploy.sh --tunnel eyJhIjoi…   # 安装 cloudflared 连接器（TOKEN 从 Zero Trust 隧道页复制）
```

Zero Trust 路由配置：Subdomain `api-reverse` · Domain `cineflowing.com` ·
Service `HTTP` → `localhost:9000`。详见 [`parser-core/README.md`](./parser-core/README.md)。

内核以 Cobalt 协议对外提供服务：`POST https://api-reverse.cineflowing.com/api/json`
body `{ "url": "..." }` → `{ "status": "redirect", "url": "<直链>", "meta": {...} }`，
内置 5 分钟结果缓存。

**连通性自检**（部署到 Pages 后直接访问）：

```bash
curl "https://reverse.cineflowing.com/api/parse?probe=1"
# probe.httpStatus = 200 即内核可达；502 说明 Tunnel 通了但源站没起来
```

## 6. 部署到 Cloudflare Pages

1. Pages → 创建项目 → 连接本仓库
2. 构建命令：`npm run build`；输出目录：`dist`
3. 环境变量 / Secrets：`COBALT_INSTANCE_URL`、`COBALT_API_KEY`
4. DNS：将 `reverse.cineflowing.com` CNAME 指向 Pages 项目

也可本地一键发布：

```bash
npx wrangler login
npm run deploy
```

## 6.1 三擎的本地运行

**浏览器插件**（最快的解风控手段）

```bash
# chrome://extensions 开启开发者模式 → 加载已解压的扩展程序 → 选择 extension/
# 打开站点后顶部胶囊显示「浏览器插件」即生效
```

**桌面端**（能力最完整，含 Stage 2 本地抽帧算力）

```bash
cd desktop
npm install
npm run binaries      # 拉取 yt-dlp + FFmpeg 到 desktop/bin/
npm start             # 或 REVERSE_URL=http://localhost:5173 npm start 联调本地前端
npm run dist          # 打包 win / mac / linux 安装包
```

## 7. 已验证（冒烟）

- [x] `tsc --noEmit` 类型检查通过、`vite build` 构建通过
- [x] `GET /api/parse` 返回网关与解析链状态，`?probe=1` 可探测内核连通性
- [x] `POST /api/parse` 正常解析；不支持的平台返回 `422`
- [x] TikTok 真实链接解析成功（TikWM 兜底源，返回标题 / 封面 / 时长 / 直链）
- [x] `/api/proxy-download` 全量下载 `200` + `Content-Disposition: attachment`
- [x] `/api/proxy-download` Range 请求 `206` + `Content-Range`
- [x] SSRF 防护：非白名单地址（含 `169.254.169.254`）返回 `403`
- [x] 边缘直连失败时自动回退内核 `/api/fetch` 代拉
- [x] 三擎路由：无插件 / 非桌面端环境下正确回落云端；`Engine` 接口对业务层透明
- [x] 插件与桌面端全部源文件语法校验通过（含 manifest JSON 解析）

## 8. Roadmap

- **Stage 2**：FFmpeg 场景切分 + 多模态大模型解析 → `StoryboardNode[]`（数据结构已在 `src/types/storyboard.ts` 定义，前端入口「分镜」抽屉已预留）
- 关键帧上传 Cloudflare R2，`thumbnailUrl` 直出
- 主站 `cineflowing.com` 一键导入（导入包结构已在「推送到主站」中生成）
