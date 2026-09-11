/**
 * Electron 桌面端桥接层。
 *
 * 桌面端是最强的一层：解析与下载都发生在用户本机，
 * 出口 IP 是真实住宅 IP，且 yt-dlp 可以用 --cookies-from-browser
 * 直接读取本机浏览器的登录态，彻底绕开 YouTube / Instagram 的机房 IP 风控。
 */

import type { PlatformType, VideoMetadata } from '../types/parser';
import type { ClientFeed, ConnectionState, FeedState } from '../types/clientFeed';
import type { DownloadRequest, Engine, EngineCapabilities, ParseRequest } from './types';
import { EngineError } from './types';

export interface ElectronHello {
  version: string;
  ytDlp: boolean;
  ffmpeg: boolean;
  /** 本机可读取 Cookie 的浏览器，例如 ['chrome','edge'] */
  browsers: string[];
  ytDlpVersion?: string;
}

export interface ElectronDownloadResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export type ElectronProgressHandler = (event: { id: string; percent: number; done: boolean; error?: string }) => void;

export interface ElectronAPI {
  hello(): Promise<ElectronHello>;
  parse(payload: { url: string; platform: PlatformType }): Promise<VideoMetadata>;
  download(payload: {
    id: string;
    url: string;
    platform: PlatformType;
    filename: string;
    sourceUrl?: string;
    cookieBrowser?: string;
  }): Promise<ElectronDownloadResult>;
  cancel(payload: { id: string }): Promise<void>;
  reveal(payload: { path: string }): Promise<void>;
  onDownloadProgress(handler: ElectronProgressHandler): () => void;
  /** 运营投放（升级 / 广告 / 推广）拉取与订阅 */
  fetchFeed(): Promise<ClientFeed | null>;
  feedState(): Promise<FeedState>;
  onFeed(handler: (feed: ClientFeed) => void): () => void;
  onConnection(handler: (state: ConnectionState) => void): () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    /** 桌面端在 preload 里注入的运行环境标识 */
    CINEFLOW_RUNTIME?: 'electron';
  }
}

export function detectElectron(): boolean {
  return typeof window !== 'undefined' && Boolean(window.CINEFLOW_RUNTIME === 'electron' && window.electronAPI);
}

export function getElectronAPI(): ElectronAPI | null {
  return detectElectron() ? window.electronAPI! : null;
}

export function createElectronEngine(caps: EngineCapabilities): Engine {
  const api = getElectronAPI();
  if (!api) throw new EngineError('electron', '桌面端 API 未注入');

  return {
    capabilities: caps,
    async parse(req: ParseRequest): Promise<VideoMetadata> {
      const data = await api.parse({ url: req.url, platform: req.platform });
      if (!data?.downloadUrl) throw new EngineError('electron', '桌面端未返回可用直链');
      return data;
    },
    async download(req: DownloadRequest): Promise<void> {
      const unsubscribe = api.onDownloadProgress((event) => {
        if (event.id !== req.taskId) return;
        if (event.error) {
          unsubscribe();
          return;
        }
        req.onProgress?.(event.percent);
        if (event.done) {
          unsubscribe();
          req.onProgress?.(100);
        }
      });

      req.signal?.addEventListener('abort', () => {
        void api.cancel({ id: req.taskId }).catch(() => {});
      });

      try {
        const result = await api.download({
          id: req.taskId,
          url: req.url,
          platform: req.metadata?.platform ?? 'unknown',
          filename: req.filename,
          sourceUrl: req.metadata?.originalUrl,
          cookieBrowser: req.cookieBrowser,
        });
        if (!result.ok) throw new EngineError('electron', result.error || '桌面端下载失败');
      } finally {
        unsubscribe();
      }
    },
  };
}
