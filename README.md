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
        ├── Cobalt / yt-dlp 自建内核  (IG / YT / 抖音 / 小红书，规避 CF 出口 IP 封禁)
        └── TikWM 公共源              (TikTok 兜底，零配置可用)
        │
        ▼  返回统一 VideoMetadata（无水印直链）
[ 客户端 ] ──GET /api/proxy-download（流式中转 + Referer/UA 补全）──> Blob 保存 / ZIP 打包
```

**为什么需要自建内核**：YouTube 与 Instagram 会封禁 Cloudflare 数据中心网段（403 / CAPTCHA），
仅靠 Worker 原生 `fetch` 无法长期稳定抓取。因此 IG / YT 必须走独立 VPS 上的 `parser-core`。

## 2. 目录结构

```
.
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
│   ├── hooks/
│   │   ├── useTaskManager.ts        # 任务队列调度状态机（解析 + 下载并发控制）
│   │   └── useSettings.ts           # 本地偏好（并发数、ZIP、文件名规则）
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
| `COBALT_INSTANCE_URL` | 自建 Cobalt / parser-core 地址（IG / YT 必需） | 空 |
| `COBALT_API_KEY` | 内核密钥，请求头 `Authorization: Api-Key xxx` | 空 |
| `YTDLP_SERVICE_URL` | 另一个 Cobalt 协议兼容服务（可选） | 空 |
| `TIKWM_API_URL` | TikTok 公共兜底源，设为 `off` 可关闭 | `https://www.tikwm.com/api/` |
| `ALLOWED_DOWNLOAD_HOSTS` | 追加允许中转的域名（逗号分隔） | 内置 CDN 白名单 |
| `MAX_DOWNLOAD_BYTES` | 单文件大小上限，0 为不限 | `0` |
| `MOCK_PARSER` | `1` 开启演示模式 | 空 |

> `ALLOW_ANY_HOST=1` 仅供本地调试，**生产环境切勿开启**（会有 SSRF 风险）。

## 5. 部署自建解析内核（VPS）

```bash
cd parser-core
docker compose up -d --build      # 暴露 9000 端口
curl http://127.0.0.1:9000/health # {"ok":true,...}
# 建议用 Nginx + Let's Encrypt 反代到 https://parser-core.yourdomain.com
```

内核以 Cobalt 协议对外提供服务：`POST https://parser-core.yourdomain.com/api/json`
body `{ "url": "..." }` → `{ "status": "redirect", "url": "<直链>", "meta": {...} }`，
内置 5 分钟结果缓存。

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

## 7. 已验证（冒烟）

- [x] `tsc --noEmit` 类型检查通过、`vite build` 构建通过
- [x] `GET /api/parse` 返回网关与解析链状态
- [x] `POST /api/parse` 正常解析；不支持的平台返回 `422`
- [x] `/api/proxy-download` 全量下载 `200` + `Content-Disposition: attachment`
- [x] `/api/proxy-download` Range 请求 `206` + `Content-Range`
- [x] SSRF 防护：非白名单地址（含 `169.254.169.254`）返回 `403`

## 8. Roadmap

- **Stage 2**：FFmpeg 场景切分 + 多模态大模型解析 → `StoryboardNode[]`（数据结构已在 `src/types/storyboard.ts` 定义，前端入口「分镜」抽屉已预留）
- 关键帧上传 Cloudflare R2，`thumbnailUrl` 直出
- 主站 `cineflowing.com` 一键导入（导入包结构已在「推送到主站」中生成）
