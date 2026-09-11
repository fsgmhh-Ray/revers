/**
 * 云端兜底引擎：请求打到 Cloudflare Pages Functions 网关，
 * 由 heterogeneous 解析链（自建 yt-dlp 内核 / TikWM 公共源）处理。
 *
 * 这是唯一在任何浏览器、零安装就能跑的链路，
 * 缺点是出口 IP 属于数据中心，YouTube / Instagram 会拦截。
 */

import type { PlatformType, VideoMetadata } from '../types/parser';
import { downloadSingleVideo } from '../utils/downloader';
import { detectPlatform } from '../utils/platform';
import type { DownloadRequest, Engine, EngineCapabilities, ParseRequest } from './types';
import { EngineError } from './types';

export async function cloudParse(url: string, platform: PlatformType, signal?: AbortSignal): Promise<VideoMetadata> {
  const res = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, platform }),
    signal,
  });
  const payload = (await res.json()) as { success?: boolean; data?: VideoMetadata; error?: string };
  if (!res.ok || !payload.success || !payload.data) {
    throw new EngineError('cloud', payload.error || `解析失败 (HTTP ${res.status})`);
  }
  return payload.data;
}

export function createCloudEngine(platforms: PlatformType[] = []): Engine {
  const capabilities: EngineCapabilities = {
    kind: 'cloud',
    available: true,
    platforms: platforms.length ? platforms : (['tiktok', 'instagram', 'youtube', 'douyin', 'xiaohongshu'] as PlatformType[]),
    authed: [],
    detail: 'Cloudflare Pages Functions 网关',
  };

  return {
    capabilities,
    async parse(req: ParseRequest): Promise<VideoMetadata> {
      const platform = req.platform || detectPlatform(req.url);
      return cloudParse(req.url, platform, req.signal);
    },
    async download(req: DownloadRequest): Promise<void> {
      await downloadSingleVideo(req.url, req.filename, {
        onProgress: (percent) => req.onProgress?.(percent),
        signal: req.signal,
      });
    },
  };
}
