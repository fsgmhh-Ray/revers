import type { Env } from './types';
import { absoluteUrl, uuid } from './http';
import type { PlatformType, VideoMetadata } from '../../src/types/parser';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface ProviderResult {
  data: VideoMetadata;
  provider: string;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/* ------------------------------------------------------------------ *
 * 1) Mock：无后端时的 UI 联调数据源
 * ------------------------------------------------------------------ */
const MOCK_LIBRARY = [
  {
    id: 'mock-blazes',
    title: '示例素材 ForBiggerBlazes（演示模式）',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerBlazes.jpg',
    duration: 15,
  },
  {
    id: 'mock-joy',
    title: '示例素材 ForBiggerJoyrides（演示模式）',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    cover: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerJoyrides.jpg',
    duration: 15,
  },
];

function mockProvider(url: string, platform: PlatformType): ProviderResult {
  const pick = MOCK_LIBRARY[Math.abs(hashCode(url)) % MOCK_LIBRARY.length];
  return {
    provider: 'mock',
    data: {
      id: pick.id,
      originalUrl: url,
      platform: platform === 'unknown' ? 'tiktok' : platform,
      title: pick.title,
      author: { name: 'Demo Creator' },
      duration: pick.duration,
      coverUrl: pick.cover,
      downloadUrl: pick.url,
      hasWatermark: false,
      provider: 'mock',
    },
  };
}

function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/* ------------------------------------------------------------------ *
 * 2) Cobalt：自建解析内核（推荐，规避 Cloudflare 出口 IP 封禁）
 * ------------------------------------------------------------------ */
interface CobaltPayload {
  status?: 'tunnel' | 'redirect' | 'picker' | 'stream' | 'error' | string;
  url?: string;
  filename?: string;
  text?: string;
  items?: { type?: string; url?: string; filename?: string }[];
  picker?: { type?: string; url?: string }[];
}

async function cobaltProvider(url: string, platform: PlatformType, env: Env): Promise<ProviderResult> {
  const base = (env.COBALT_INSTANCE_URL || '').replace(/\/+$/, '');
  if (!base) throw new ProviderError('未配置 COBALT_INSTANCE_URL');

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
  };
  if (env.COBALT_API_KEY) headers.Authorization = `Api-Key ${env.COBALT_API_KEY}`;

  const body = JSON.stringify({
    url,
    videoQuality: 'max',
    filenamePattern: 'basic',
    isAudioOnly: false,
    disableMetadata: false,
  });

  let payload: CobaltPayload | null = null;
  let lastError = '';

  for (const path of ['/api/json', '/']) {
    try {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
      const text = await res.text();
      try {
        payload = JSON.parse(text) as CobaltPayload;
      } catch {
        lastError = `解析内核返回非 JSON（HTTP ${res.status}）`;
        continue;
      }
      if (res.ok && payload && payload.status !== 'error') break;
      lastError = payload?.text || `解析内核错误（HTTP ${res.status}）`;
    } catch (err: any) {
      lastError = err?.message || '解析内核不可达';
    }
  }

  if (!payload || payload.status === 'error') {
    throw new ProviderError(lastError || 'Cobalt 解析失败');
  }

  const direct =
    payload.url ||
    payload.items?.find((i) => i.type?.includes('video'))?.url ||
    payload.items?.[0]?.url ||
    payload.picker?.find((i) => i.type?.includes('video'))?.url ||
    '';

  if (!direct) throw new ProviderError('解析内核未返回视频直链');

  return {
    provider: 'cobalt',
    data: {
      id: uuid(),
      originalUrl: url,
      platform,
      title: payload.filename?.replace(/\.[^.]+$/, '') || `${platform}_${Date.now()}`,
      author: { name: 'Unknown Creator' },
      duration: 0,
      coverUrl: '',
      downloadUrl: absoluteUrl(direct, base),
      hasWatermark: false,
      provider: 'cobalt',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3) TikWM：TikTok 免费兜底源（无需自建即可用）
 * ------------------------------------------------------------------ */
interface TikwmPayload {
  code?: number;
  msg?: string;
  data?: {
    id?: string;
    title?: string;
    cover?: string;
    origin_cover?: string;
    duration?: number | string;
    play?: string;
    wmplay?: string;
    hdplay?: string;
    size?: number;
    author?: { nickname?: string; avatar?: string; unique_id?: string };
  };
}

async function tikwmProvider(url: string, env: Env): Promise<ProviderResult> {
  const endpoint = (env.TIKWM_API_URL || 'https://www.tikwm.com/api/').replace(/\/+$/, '') + '/';
  const target = `${endpoint}?url=${encodeURIComponent(url)}&hd=1`;

  const res = await fetch(target, {
    headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) throw new ProviderError(`TikWM HTTP ${res.status}`);

  const payload = (await res.json()) as TikwmPayload;
  if (payload.code !== 0 || !payload.data) {
    throw new ProviderError(payload.msg || 'TikWM 解析失败');
  }

  const d = payload.data;
  const origin = new URL(endpoint).origin;
  const candidates = [d.hdplay, d.play, d.wmplay].filter(Boolean) as string[];
  if (!candidates.length) throw new ProviderError('TikWM 未返回视频地址');

  const hd = Boolean(d.hdplay);
  const chosen = candidates[0];

  return {
    provider: 'tikwm',
    data: {
      id: d.id || uuid(),
      originalUrl: url,
      platform: 'tiktok',
      title: (d.title || 'tiktok_video').slice(0, 120),
      author: { name: d.author?.nickname || d.author?.unique_id || 'Unknown', avatar: absoluteUrl(d.author?.avatar || '', origin) },
      duration: Number(d.duration) || 0,
      coverUrl: absoluteUrl(d.cover || d.origin_cover || '', origin),
      downloadUrl: absoluteUrl(chosen, origin),
      fallbackUrls: candidates.slice(1).map((u) => absoluteUrl(u, origin)),
      hasWatermark: !hd && chosen === d.wmplay,
      fileSize: d.size,
      provider: 'tikwm',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4) yt-dlp 兼容服务（自建，POST /api/json 同 Cobalt 协议）
 * ------------------------------------------------------------------ */
async function ytdlpProvider(url: string, platform: PlatformType, env: Env): Promise<ProviderResult> {
  const result = await cobaltProvider(url, platform, {
    ...env,
    COBALT_INSTANCE_URL: env.YTDLP_SERVICE_URL,
    COBALT_API_KEY: env.COBALT_API_KEY,
  });
  return { ...result, provider: 'yt-dlp' };
}

/* ------------------------------------------------------------------ *
 * 调度：按平台选择解析链
 * ------------------------------------------------------------------ */
export async function resolveVideo(
  url: string,
  platform: PlatformType,
  env: Env,
): Promise<ProviderResult> {
  const errors: string[] = [];

  const chain: (() => Promise<ProviderResult>)[] = [];

  if (env.MOCK_PARSER === '1') {
    chain.push(() => Promise.resolve(mockProvider(url, platform)));
  }

  if (env.COBALT_INSTANCE_URL) {
    chain.push(() => cobaltProvider(url, platform, env));
  }

  if (env.YTDLP_SERVICE_URL) {
    chain.push(() => ytdlpProvider(url, platform, env));
  }

  if (platform === 'tiktok' && env.TIKWM_API_URL !== 'off') {
    chain.push(() => tikwmProvider(url, env));
  }

  if (!chain.length) {
    throw new ProviderError(
      platform === 'tiktok'
        ? '未配置任何解析源（设置 COBALT_INSTANCE_URL 或保留默认 TikWM）'
        : '该平台需要自建解析内核：请在 Pages 环境变量配置 COBALT_INSTANCE_URL（Cobalt / yt-dlp 服务）',
    );
  }

  for (const run of chain) {
    try {
      const result = await run();
      if (result?.data?.downloadUrl) return result;
      errors.push('解析源未返回直链');
    } catch (err: any) {
      errors.push(err?.message || '解析异常');
    }
  }

  throw new ProviderError(errors.join(' | '));
}

export const PROVIDER_HINTS: Record<string, string> = {
  mock: '演示模式',
  cobalt: 'Cobalt 自建内核',
  'yt-dlp': 'yt-dlp 自建内核',
  tikwm: 'TikWM 公共源',
};
