# parser-core —— 自建解析内核

以 **Cobalt 兼容协议**对外提供服务，内部用 `yt-dlp` 解析。部署在独立 VPS 上，
规避 Cloudflare / 数据中心出口 IP 被 YouTube、Instagram 封禁的问题。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health`、`/` | 健康检查 |
| POST | `/api/json` | `{ "url": "..." }` → `{ "status": "redirect", "url": "<直链>", "meta": {...} }` |
| GET | `/api/fetch?url=<直链>` | **源站流式下载代理**，用于绕过直链的出口 IP 绑定 |

所有接口（`/health` 除外）在设置了 `API_KEY` 时需带请求头 `Authorization: Api-Key <key>`。

### 为什么需要 `/api/fetch`

YouTube / Instagram / 抖音 返回的视频直链通常**绑定首次解析的出口 IP** 且带时效签名。
如果让 Cloudflare 边缘节点去拉，会因为 IP 不一致被判 403。
所以直链下载也走内核：边缘 →（Tunnel）→ 内核 → 源站 CDN。
边缘网关 `proxy-download` 会在直连失败时自动回退到该接口。

## 部署（Oracle VPS + Cloudflare Tunnel）

推荐 Tunnel 架构：不开放任何公网端口，无需 iptables / 安全列表，自带 HTTPS。

```bash
# 1. 拉取代码
git clone https://github.com/fsgmhh-Ray/revers.git && cd revers/parser-core

# 2. 一键部署（自动生成 API_KEY 并打印）
chmod +x deploy.sh && ./deploy.sh

# 3. 安装 Tunnel 连接器（TOKEN 从 Zero Trust 隧道页复制）
./deploy.sh --tunnel eyJhIjoiXXXX...
```

Zero Trust 侧的路由配置：

| 字段 | 值 |
| --- | --- |
| Subdomain | `api-reverse` |
| Domain | `cineflowing.com` |
| Service Type | `HTTP` |
| URL | `localhost:9000` |

完成后 `https://api-reverse.cineflowing.com/health` 应返回 `{"ok":true,...}`。

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `9000` |
| `API_KEY` | 密钥，设后所有接口需 `Authorization: Api-Key <key>` | 空 |
| `ALLOWED_ORIGIN` | CORS 白名单 | `*` |
| `YTDLP_PATH` | yt-dlp 可执行文件路径 | `yt-dlp` |
| `CACHE_TTL` | 解析结果缓存秒数 | `300` |

## 关于平台风控（重要）

数据中心 IP（Oracle / Hetzner 等）普遍被 YouTube、TikTok 风控，实测表现：

| 平台 | 无 cookies | 有 cookies |
| --- | --- | --- |
| YouTube | ❌ `This video is unavailable`（所有 player_client 均失败） | ✅ 需 Google 账号 cookies |
| Instagram | ❌ 多数内容需登录 | ✅ 需 IG 账号 cookies |
| TikTok | ❌ 网页抓取与直链均 403 | 走 TikWM 更稳（见下） |

**TikTok 建议不要走内核**：前端 `resolveVideo` 已把 TikWM 排在内核前面，
TikWM 返回的 `*.tiktokcdn-us.com` / `*.tiktok.com` 直链可由 Cloudflare 边缘直接下载（实测 200 / 3.3MB）。

**为 YouTube / Instagram 配 cookies**：

```bash
# 本机浏览器装 "Get cookies.txt LOCALLY" 扩展，导出 youtube.com 的 cookies（Netscape 格式）
scp cookies.txt ubuntu@<VPS>:~/revers-src/parser-core/cookies.txt

# VPS 上启用挂载：编辑 docker-compose.yml 取消注释 volumes 两行
sudo docker compose up -d --build
curl -s http://127.0.0.1:9000/health      # "cookies": true 表示已加载
```

## 故障排查：`/health` 返回 502

Cloudflare 返回 502（带 CF 错误页）说明 **Tunnel 通了、但源站没连上**，按顺序查：

```bash
# 1. 容器是否在运行
docker ps | grep parser-core
docker compose logs --tail 50

# 2. 内核本身是否健康（在 VPS 上执行）
curl -i http://127.0.0.1:9000/health        # 期望 200 {"ok":true,...}

# 3. cloudflared 是否连接
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50 --no-pager

# 4. Tunnel 路由的 Service URL 必须是 http://localhost:9000
#    Zero Trust → Networks → Tunnels → 你的隧道 → Configure → Published application routes

# 5. 若容器在但 9000 端口无响应：确认 docker-compose.yml 的 ports 映射未被改动
```

常见原因：容器没启动（最常见）、cloudflared 服务未装、路由里 URL 写成了 `https://localhost:9000`（应为 HTTP）。

## 更新

```bash
cd parser-core
git pull && ./deploy.sh     # 会复用 .env 里已有的 API_KEY
```
