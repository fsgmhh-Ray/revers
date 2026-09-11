# Cineflowing Reverse 助手（Chrome 插件）

让 `reverse.cineflowing.com` 用**你自己的 IP 和浏览器登录态**去解析和下载视频。

机房 IP（Cloudflare / VPS）会被 YouTube 与 Instagram 风控拦截，这是纯服务端方案绕不过去的天花板。
插件把这个环节下放到浏览器：请求从你的本机网络发出，Cookie 直接用你已登录的会话，
既不触发风控，也不需要导出 Cookie 文件。

## 安装（开发者模式，30 秒）

1. 打开 `chrome://extensions/`，右上角开启 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本目录（`extension/`）。
3. 打开 <https://reverse.cineflowing.com>，顶部状态胶囊应显示「浏览器插件」。

> Chrome 已全面禁用 `chrome://extensions` 之外来源的扩展安装（Google 不再接受外部 CRX）。
> 分发给普通用户需要提交 Chrome 应用商店；开发者模式仅供自用与内部测试。

## 工作原理

```
网页 (React)                content.js                 background.js
   │  postMessage              │  chrome.runtime           │
   └─────────────────────────► │ ────────────────────────► │ fetch(credentials: include)
   │                           │                           │ chrome.downloads.download()
   ◄────────────────────────── │ ◄──────────────────────── │
```

- `content.js` 给 `<html>` 打上 `data-cineflow-extension="true"`，页面据此嗅探到插件；
  随后作为双向中继转发 RPC（`HELLO` / `PARSE` / `DOWNLOAD` / `DOWNLOAD_STATE` / `DOWNLOAD_CANCEL`）。
- `background.js`（Service Worker）拥有 `host_permissions`，可以跨域请求
  youtube.com / instagram.com / tiktok.com，且 `credentials: 'include'` 会自动带上你的登录 Cookie。

## 各平台解析策略

| 平台       | 策略                                                                 | 是否需要登录 |
| ---------- | -------------------------------------------------------------------- | ------------ |
| YouTube    | 抓取 watch 页 → 解析 `ytInitialPlayerResponse` → 取未加密的 mp4 直链 | 登录可解年龄/会员限制 |
| Instagram  | 先试 `/api/v1/media/<code>/info/`（画质最好），失败回退 embed 端点   | 私有内容必须登录 |
| TikTok     | TikWM 公共 API（由你的 IP 发起，成功率高于机房 IP）                  | 否           |

**关于画质**：YouTube 只对带签名的流提供 1080p+，扩展不做播放器 JS 解密，
因此只取 `url` 字段已存在（未加密）的 mp4，通常最高到 720p 渐进式（含音轨）。
需要 4K / 1080p 合并流请用桌面端（内置 yt-dlp + FFmpeg）。

## 权限说明

| 权限              | 用途                                       |
| ----------------- | ------------------------------------------ |
| `downloads`       | 用浏览器下载管理器落盘，支持断点续传       |
| `cookies`         | 仅用于探测你是否已登录某平台（只读判断）   |
| `host_permissions`| 跨域请求各平台接口，绕过 CORS              |

插件**不会**上传你的 Cookie 到任何服务器，所有请求只发往对应平台自己的域名与视频 CDN。
