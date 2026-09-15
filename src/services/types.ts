/**
 * 三擎分发的统一契约。
 * 无论任务最终跑在用户本机（Electron）、浏览器插件里，还是云端 VPS，
 * 对外都暴露同一组方法，业务层无需感知差异。
 */

import type { PlatformType, VideoMetadata } from '../types/parser';

/** 执行引擎类型，按能力从强到弱排列 */
export type EngineKind = 'electron' | 'extension' | 'cloud';

export const ENGINE_PRIORITY: EngineKind[] = ['electron', 'extension', 'cloud'];

export const ENGINE_META: Record<EngineKind, { label: string; short: string; tag: string }> = {
  electron: { label: '本地桌面端', short: '本地', tag: '本机 IP · yt-dlp · 最高画质' },
  extension: { label: '浏览器插件', short: '插件', tag: '你的 IP · 免导出 Cookie' },
  cloud: { label: '云端内核', short: '云端', tag: '机房 IP · 部分平台受限' },
};

export interface EngineCapabilities {
  kind: EngineKind;
  /** 引擎是否就绪（插件是否安装 / 是否在桌面端壳内） */
  available: boolean;
  version?: string;
  /** 该引擎能力覆盖的平台 */
  platforms: PlatformType[];
  /** 已检测到登录态的平台（决定 IG / YT 能否突破风控） */
  authed: PlatformType[];
  detail?: string;
}

export interface ParseRequest {
  url: string;
  platform: PlatformType;
  /** 桌面端专用：从哪个浏览器读取登录态，auto 交给 yt-dlp 自行探测 */
  cookieBrowser?: string;
  /** 桌面端专用：显式导入的 cookies.txt 路径，优先级高于 cookieBrowser */
  cookieFile?: string;
  signal?: AbortSignal;
}

export interface DownloadRequest {
  taskId: string;
  url: string;
  filename: string;
  /** 原始页面地址，用于伪造 Referer 防盗链 */
  referer?: string;
  metadata?: VideoMetadata;
  /** 桌面端专用：从哪个浏览器读取登录态，auto 交给 yt-dlp 自行探测 */
  cookieBrowser?: string;
  /** 桌面端专用：显式导入的 cookies.txt 路径，优先级高于 cookieBrowser */
  cookieFile?: string;
  /** 桌面端专用：下载目录；留空则用默认目录 */
  dir?: string;
  /** 桌面端专用：拿到最终落盘路径后回调，供 UI 显示位置并一键打开 */
  onSaved?: (path: string) => void;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface Engine {
  readonly capabilities: EngineCapabilities;
  parse(req: ParseRequest): Promise<VideoMetadata>;
  download(req: DownloadRequest): Promise<void>;
}

export class EngineError extends Error {
  readonly engine: EngineKind;
  readonly code: string;

  constructor(engine: EngineKind, message: string, code = 'ENGINE_FAILED') {
    super(message);
    this.name = 'EngineError';
    this.engine = engine;
    this.code = code;
  }
}
