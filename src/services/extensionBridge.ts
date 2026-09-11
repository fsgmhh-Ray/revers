/**
 * 页面 <-> Chrome 插件 的桥接层。
 *
 * 浏览器安全模型禁止页面直接跨域请求 YouTube / Instagram，
 * 但插件的 background service worker 拥有 host_permissions，
 * 可以以「用户本机 IP + 用户浏览器里现成的登录 Cookie」发起请求。
 *
 * 通信链路：
 *   页面 --postMessage--> content script --chrome.runtime--> background worker
 *   回程走同一条链路反向透传，页面侧用 id 做请求-响应配对。
 */

import type { PlatformType, VideoMetadata } from '../types/parser';
import type { DownloadRequest, Engine, EngineCapabilities, ParseRequest } from './types';
import { EngineError } from './types';

const PROTOCOL = 'CINEFLOW_EXT_V1';
/** 页面 -> 插件 */
const PAGE_CHANNEL = `${PROTOCOL}:page`;
/** 插件 -> 页面 */
const EXT_CHANNEL = `${PROTOCOL}:extension`;

interface RpcResponse<T = unknown> {
  source: string;
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: number;
};

const pending = new Map<string, Pending>();
let seq = 0;
let listening = false;

function ensureListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const payload = event.data as RpcResponse | undefined;
    if (!payload || payload.source !== EXT_CHANNEL) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    pending.delete(payload.id);
    if (payload.ok) entry.resolve(payload.data);
    else entry.reject(new Error(payload.error || '插件返回未知错误'));
  });
}

function rpc<T>(action: string, payload: unknown, timeoutMs = 120_000): Promise<T> {
  ensureListener();
  const id = `${Date.now()}-${++seq}`;
  window.postMessage({ source: PAGE_CHANNEL, id, action, payload }, '*');

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`插件响应超时（${action}）`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

/** 插件是否安装并注入了当前页面（content script 会给 <html> 打标记） */
export function detectExtensionMarker(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-cineflow-extension') === 'true';
}

export interface ExtensionHello {
  version: string;
  platforms: PlatformType[];
  authed: PlatformType[];
  downloadApi: boolean;
}

/** 握手：拿到插件版本、能力集与已登录平台 */
export async function extensionHello(timeoutMs = 1200): Promise<ExtensionHello> {
  return rpc<ExtensionHello>('HELLO', null, timeoutMs);
}

/** 插件侧的 windows.chrome 不可用时的兜底探测 */
export async function probeExtension(): Promise<ExtensionHello | null> {
  if (!detectExtensionMarker()) return null;
  try {
    return await extensionHello();
  } catch {
    return null;
  }
}

export function createExtensionEngine(caps: EngineCapabilities): Engine {
  return {
    capabilities: caps,
    async parse(req: ParseRequest): Promise<VideoMetadata> {
      const data = await rpc<VideoMetadata>(
        'PARSE',
        { url: req.url, platform: req.platform },
        90_000,
      );
      if (!data?.downloadUrl) throw new EngineError('extension', '插件未返回可用直链');
      return data;
    },
    async download(req: DownloadRequest): Promise<void> {
      const pid = await rpc<{ downloadId: number }>(
        'DOWNLOAD',
        {
          url: req.url,
          filename: req.filename,
          referer: req.referer,
          headers: buildDownloadHeaders(req),
        },
        30_000,
      );
      await trackDownload(pid.downloadId, req);
    },
  };
}

function buildDownloadHeaders(req: DownloadRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (req.metadata?.platform === 'instagram') headers.Referer = 'https://www.instagram.com/';
  if (req.metadata?.platform === 'tiktok') headers.Referer = 'https://www.tiktok.com/';
  if (req.metadata?.platform === 'youtube') headers.Referer = 'https://www.youtube.com/';
  return headers;
}

/**
 * chrome.downloads 不提供进度回调，这里轮询其状态直到落盘。
 * 大文件场景比 Blob 方案更稳（Chrome 的下载管理器自带断点续传）。
 */
function trackDownload(downloadId: number, req: DownloadRequest): Promise<void> {
  const started = Date.now();
  const limit = 10 * 60 * 1000;

  return new Promise<void>((resolve, reject) => {
    const tick = async () => {
      try {
        const state = await rpc<{
          state: string;
          bytesReceived: number;
          totalBytes: number;
          error?: string;
        }>('DOWNLOAD_STATE', { downloadId }, 15_000);

        if (state.state === 'complete') {
          req.onProgress?.(100);
          resolve();
          return;
        }
        if (state.state === 'interrupted') {
          reject(new EngineError('extension', state.error || '浏览器下载被中断'));
          return;
        }
        if (state.totalBytes > 0) {
          req.onProgress?.(Math.min(99, Math.round((state.bytesReceived / state.totalBytes) * 100)));
        }
      } catch {
        /* 单次轮询失败不致命，交给下面的超时逻辑终止 */
      }

      if (req.signal?.aborted) {
        void rpc('DOWNLOAD_CANCEL', { downloadId }, 5_000).catch(() => {});
        reject(new EngineError('extension', '下载已取消'));
        return;
      }
      if (Date.now() - started > limit) {
        reject(new EngineError('extension', '下载超时'));
        return;
      }
      window.setTimeout(tick, 700);
    };
    void tick();
  });
}
