import type { PlatformType } from '../../src/types/parser';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function detectPlatform(rawUrl: string): PlatformType {
  let host = rawUrl;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = rawUrl.toLowerCase();
  }
  if (/tiktok\.com/.test(host)) return 'tiktok';
  if (/instagram\.com/.test(host)) return 'instagram';
  if (/youtube\.com|youtu\.be/.test(host)) return 'youtube';
  if (/douyin\.com/.test(host)) return 'douyin';
  if (/xiaohongshu\.com|xhslink\.com/.test(host)) return 'xiaohongshu';
  return 'unknown';
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** 生成安全文件名（服务端兜底，防止 Content-Disposition 注入） */
export function safeFilename(name: string, fallback = 'video.mp4'): string {
  const cleaned = (name || '')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

export function absoluteUrl(maybeRelative: string, base: string): string {
  if (!maybeRelative) return '';
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}
