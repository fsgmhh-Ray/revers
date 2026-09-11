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

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
  } catch (err: any) {
    return json({ error: `上游请求失败：${err?.message || 'unknown'}` }, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return json({ error: `上游返回 HTTP ${upstream.status}` }, 502);
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
