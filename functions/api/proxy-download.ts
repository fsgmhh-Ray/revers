import type { ApiHandler } from '../_lib/types';
import { corsPreflight, detectPlatform, json, safeFilename } from '../_lib/http';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** 默认允许中转的 CDN 域名（后缀匹配）——防止 SSRF 与盗刷 */
const DEFAULT_ALLOWED_HOSTS = [
  // TikTok
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'muscdn.com',
  'musical.ly',
  'byteoversea.com',
  'tikwm.com',
  // Instagram
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  // YouTube
  'googlevideo.com',
  'ytimg.com',
  'youtube.com',
  // 国内平台
  'douyinvod.com',
  'douyin.com',
  'iesdouyin.com',
  'xhscdn.com',
  'xiaohongshu.com',
  // 自建 / R2 / 演示素材
  'r2.dev',
  'r2.cloudflarestorage.com',
  'commondatastorage.googleapis.com',
];

function isAllowedHost(hostname: string, env: Record<string, string | undefined>): boolean {
  if (env.ALLOW_ANY_HOST === '1') return true;
  const host = hostname.toLowerCase();
  const extras = (env.ALLOWED_DOWNLOAD_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_HOSTS, ...extras].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * 这些平台的直链通常绑定首次解析时的出口 IP 并带时效签名，
 * 由 Cloudflare 边缘回源拉取会被判定为跨 IP 复用 → 403。
 * 因此只要配置了自建内核（经 Tunnel 内网），一律改由源站代拉。
 */
const ORIGIN_PROXY_HOSTS = [
  'googlevideo.com',
  'youtube.com',
  'ytimg.com',
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  'douyinvod.com',
  'iesdouyin.com',
  'xhscdn.com',
];

function buildReferer(target: URL): string {
  const platform = detectPlatform(target.href);
  switch (platform) {
    case 'tiktok':
      return 'https://www.tiktok.com/';
    case 'instagram':
      return 'https://www.instagram.com/';
    case 'youtube':
      return 'https://www.youtube.com/';
    case 'douyin':
      return 'https://www.douyin.com/';
    case 'xiaohongshu':
      return 'https://www.xiaohongshu.com/';
    default:
      return `${target.protocol}//${target.hostname}/`;
  }
}

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/**
 * GET /api/proxy-download?url=<直链>&inline=1
 * 边缘流式透明中转：补全 Referer/UA，绕过 CDN 的跨域与防盗链限制
 */
export const onRequestGet: ApiHandler = async (ctx) => {
  const params = new URL(ctx.request.url).searchParams;
  const raw = params.get('url');
  const inline = params.get('inline') === '1';

  if (!raw) return json({ error: '缺少 url 参数' }, 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'url 参数不合法' }, 400);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: '仅支持 http/https 协议' }, 400);
  }

  if (!isAllowedHost(target.hostname, ctx.env)) {
    return json(
      { error: `域名不在白名单：${target.hostname}（可在 ALLOWED_DOWNLOAD_HOSTS 中追加）` },
      403,
    );
  }

  const range = ctx.request.headers.get('range');
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: buildReferer(target),
  };
  if (range) headers.Range = range;

  const coreBase = (ctx.env.COBALT_INSTANCE_URL || '').replace(/\/+$/, '');
  const host = target.hostname.toLowerCase();
  const needsOrigin =
    Boolean(coreBase) &&
    (ctx.env.FORCE_ORIGIN_PROXY === '1' ||
      ORIGIN_PROXY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)));

  /** 路径 A：Cloudflare 边缘直连上游 CDN */
  const viaEdge = async (): Promise<Response | null> => {
    const res = await fetch(target.toString(), { headers, redirect: 'follow' });
    return res.ok || res.status === 206 ? res : null;
  };

  /** 路径 B：由自建内核（Tunnel 内网）代拉，规避直链 IP 绑定 */
  const viaOrigin = async (): Promise<Response | null> => {
    if (!coreBase) return null;
    const qs = new URLSearchParams({ url: target.toString() });
    const upstreamRes = await fetch(`${coreBase}/api/fetch?${qs.toString()}`, {
      headers: {
        ...(ctx.env.COBALT_API_KEY ? { Authorization: `Api-Key ${ctx.env.COBALT_API_KEY}` } : {}),
        ...(range ? { Range: range } : {}),
      },
      redirect: 'follow',
    });
    return upstreamRes.ok || upstreamRes.status === 206 ? upstreamRes : null;
  };

  const attempts = needsOrigin ? [viaOrigin, viaEdge] : [viaEdge, viaOrigin];
  let upstream: Response | null = null;
  let lastError = '';

  for (const attempt of attempts) {
    try {
      const res = await attempt();
      if (res) {
        upstream = res;
        break;
      }
      lastError = '上游返回非 2xx';
    } catch (err: any) {
      lastError = err?.message || 'unknown';
    }
  }

  if (!upstream) {
    return json({ error: `上游请求失败：${lastError || 'unknown'}（已尝试边缘直连与源站代理）` }, 502);
  }

  const maxBytes = Number(ctx.env.MAX_DOWNLOAD_BYTES || '0');
  const contentLength = Number(upstream.headers.get('content-length') || '0');
  if (maxBytes > 0 && contentLength > maxBytes) {
    return json({ error: `文件超过大小上限（${contentLength} > ${maxBytes}）` }, 413);
  }

  const responseHeaders = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Disposition',
    'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'private, max-age=60',
  });

  if (contentLength) responseHeaders.set('Content-Length', String(contentLength));
  if (upstream.headers.get('content-range')) {
    responseHeaders.set('Content-Range', upstream.headers.get('content-range') as string);
  }

  const filenameParam = params.get('filename');
  const derived = filenameParam || decodeURIComponent(target.pathname.split('/').pop() || '') || 'video.mp4';
  const filename = safeFilename(derived);
  responseHeaders.set(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
};
