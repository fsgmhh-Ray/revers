/**
 * Electron 桌面端桥接层。
 *
 * 桌面端是最强的一层：解析与下载都发生在用户本机，
 * 出口 IP 是真实住宅 IP，且 yt-dlp 可以用 --cookies-from-browser
 * 直接读取本机浏览器的登录态，彻底绕开 YouTube / Instagram 的机房 IP 风控。
 */

import type { PlatformType, VideoMetadata } from '../types/parser';
import type { ClientFeed, ConnectionState, FeedState } from '../types/clientFeed';
import type { StoryboardProgress, StoryboardResult } from '../types/storyboard';
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
  /** 实际落盘目录（用户指定目录不可写时会自动退回） */
  dir?: string;
  error?: string;
}

export type ElectronProgressHandler = (event: { id: string; percent: number; done: boolean; error?: string }) => void;

/** 导入的 cookies.txt 校验结果 */
export interface CookieFileInfo {
  path: string | null;
  ok: boolean;
  /** Netscape 格式的 Cookie 条目数 */
  count: number;
  error?: string;
  /** 文件里是否含 tiktok.com 的 Cookie */
  hasTikTok?: boolean;
}

/**
 * 解析结果。
 *
 * 桌面端刻意「返回失败」而不是「抛异常」—— 跨 IPC 抛出的错误会被 Electron 包一层
 * "Error invoking remote method 'cineflow:parse': Error: ..."，
 * 把真正的原因埋在噪音后面。失败的说明由主进程翻译成人话后再交回来。
 */
export type ElectronParseResult = { ok: true; data: VideoMetadata } | { ok: false; error: string };

export interface ElectronAPI {
  hello(): Promise<ElectronHello>;
  parse(payload: {
    url: string;
    platform: PlatformType;
    cookieBrowser?: string;
    /** 优先使用这个 cookies.txt 里的登录态 */
    cookieFile?: string;
  }): Promise<ElectronParseResult>;
  download(payload: {
    id: string;
    url: string;
    platform: PlatformType;
    filename: string;
    sourceUrl?: string;
    cookieBrowser?: string;
    /** 优先使用这个 cookies.txt 里的登录态 */
    cookieFile?: string;
    /** 下载目录；留空用默认目录 */
    dir?: string;
  }): Promise<ElectronDownloadResult>;
  cancel(payload: { id: string }): Promise<void>;
  reveal(payload: { path: string }): Promise<void>;
  /** 弹出系统目录选择框，取消返回 null */
  pickDir(payload?: { current?: string }): Promise<string | null>;
  /** 默认下载目录与当前实际生效目录 */
  defaultDir(): Promise<{ dir: string; effective: string }>;
  /** 弹出文件框挑选 cookies.txt，取消返回 null */
  pickCookies(): Promise<CookieFileInfo | null>;
  /** 校验一个 cookies.txt 路径是否仍然可用 */
  cookieInfo(payload: { path: string }): Promise<CookieFileInfo>;
  /** Stage 2：本地 FFmpeg 分镜逆向 */
  storyboard(payload: {
    id: string;
    path: string;
    sceneThreshold?: number;
    maxShots?: number;
    frameWidth?: number;
  }): Promise<StoryboardResult>;
  onStoryboardProgress(handler: (event: StoryboardProgress) => void): () => void;
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
      // 兼容两代桌面端：新版返回 { ok, data | error }，旧版（≤0.2.0）直接返回 metadata。
      // 网页包永远是最新的（部署在 Pages），而用户本机装的桌面端可能是旧版，两种形态都得认。
      const res = (await api.parse({
        url: req.url,
        platform: req.platform,
        cookieBrowser: req.cookieBrowser,
        cookieFile: req.cookieFile,
      })) as ElectronParseResult | VideoMetadata;

      if ('ok' in res && res.ok === false) {
        throw new EngineError('electron', res.error || '桌面端解析失败');
      }

      const data: VideoMetadata = 'data' in res && res.data ? res.data : (res as VideoMetadata);

      if (!data?.downloadUrl) {
        throw new EngineError(
          'electron',
          '解析到了视频信息，但没有可用的播放地址。该内容可能需要登录，或对当前地区不可见。',
        );
      }
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
          cookieFile: req.cookieFile,
          dir: req.dir,
        });
        if (!result.ok) throw new EngineError('electron', result.error || '桌面端下载失败');
        // 把落盘路径交回业务层：UI 靠它显示"文件在哪"并支持一键打开
        if (result.path) req.onSaved?.(result.path);
      } finally {
        unsubscribe();
      }
    },
  };
}
