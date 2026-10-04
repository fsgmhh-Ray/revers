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

/** 本地文件选择结果（cineflow:pick-file） */
export interface ElectronPickedFile {
  ok: boolean;
  /** 本机绝对路径——后续分镜 / 旁白直接用它，不再经过任何解析源 */
  path: string;
  name: string;
  size: number;
}

/** 本地旁白转写结果（与主进程 buildNarration 的返回对应） */
export type ElectronNarrationResult =
  | {
      ok: true;
      id?: string;
      transcript: string;
      provider?: string;
      model?: string;
      /** subtitle = 直接取到字幕（秒级、免费、无误字）；asr = 抽音轨后语音转写 */
      source?: 'subtitle' | 'asr';
      /** 字幕语言（zh-Hans / en 等） */
      lang?: string;
    }
  | { ok: false; error: string; /** 字幕没拿到且本地也没有文件 → 调用方需先下载音轨 */ needFile?: boolean };

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
    /**
     * 只下载音轨（m4a）。只做旁白时用：30MB 的视频里真正用到的音轨只有 5MB 左右，
     * 而下载是全链路最慢的一环。分镜拆解必须看画面，不能开这个。
     */
    audioOnly?: boolean;
  }): Promise<ElectronDownloadResult>;
  cancel(payload: { id: string }): Promise<void>;
  reveal(payload: { path: string }): Promise<void>;
  /** 弹出系统目录选择框，取消返回 null */
  pickDir(payload?: { current?: string }): Promise<string | null>;
  /** 默认下载目录与当前实际生效目录 */
  defaultDir(): Promise<{ dir: string; effective: string }>;
  /** 弹出文件框挑选 cookies.txt，取消返回 null */
  pickCookies(): Promise<CookieFileInfo | null>;
  /**
   * 弹出文件框选择本地视频/音频（链接解析不了时的兜底入口），取消返回 null。
   *
   * 风控 / 限区 / 解析源只给静音版 / 站点改版，都会让链接走不通；
   * 但用户本地往往已经有这个文件。拿到绝对路径后分镜与旁白全走本地 ffmpeg，
   * 连 yt-dlp 都不需要。
   */
  pickFile(): Promise<ElectronPickedFile | null>;
  /** 校验一个 cookies.txt 路径是否仍然可用 */
  cookieInfo(payload: { path: string }): Promise<CookieFileInfo>;
  /** Stage 2：本地 FFmpeg 分镜逆向 */
  storyboard(payload: {
    id: string;
    path: string;
    sceneThreshold?: number;
    maxShots?: number;
    frameWidth?: number;
    /** 视觉 LLM（可选）：提供则用本机 IP 调该模型补全画面描述与提示词 */
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;
    language?: string;
  }): Promise<StoryboardResult>;
  /**
   * 完整旁白 / 语音转写（本地执行）。
   *
   * 桌面端走本机 IP + 本地 ffmpeg 抽音轨，再把音频送去 OpenAI 兼容 ASR
   * （默认 Groq whisper-large-v3），长音频在内核侧自动分块。
   */
  narration(payload: {
    id: string;
    path: string;
    /** 原始页面链接：给了就先尝试直接抓字幕，拿不到才用 path 走 ASR */
    url?: string;
    sourceUrl?: string;
    cookieFile?: string;
    cookieBrowser?: string;
    llmTextBaseUrl?: string;
    llmTextApiKey?: string;
    llmTextModel?: string;
    language?: string;
  }): Promise<ElectronNarrationResult>;
  /**
   * LLM 配置自测（桌面端直连）。
   *
   * NVIDIA 等 API 的 CORS 预检不返回 Access-Control-Allow-Origin，浏览器直接
   * fetch 必然 "Failed to fetch"，但服务端调用完全正常。因此桌面端必须走后端通道测。
   */
  testLlm(payload: {
    kind: 'vision' | 'text';
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }): Promise<{ ok: boolean; message: string }>;
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

/** 本地旁白的输入：可以只给链接（先试字幕），也可以给已下载的文件（走 ASR） */
export interface LocalNarrationSource {
  /** 已下载到本机的视频/音频文件路径 */
  path?: string;
  /** 原始页面链接：给了就先尝试直接抓字幕 */
  url?: string;
  /** yt-dlp 解析出的原始链接，优先于 url */
  sourceUrl?: string;
  cookieFile?: string;
  cookieBrowser?: string;
}

export interface LocalNarrationResult {
  transcript: string;
  provider?: string;
  model?: string;
  source?: 'subtitle' | 'asr';
  lang?: string;
  /** 字幕没拿到且本地没有文件 → 调用方需先下载音轨再重试 */
  needFile?: boolean;
  error?: string;
}

/**
 * 桌面端本地旁白转写。
 *
 * 两条路径（主进程里自动选，调用方不用管）：
 *  1. **字幕优先** —— 有链接就先用 yt-dlp 抓官方/自动字幕，实测 4 秒出结果，
 *     不花钱，也不会有 ASR 的同音字错。
 *  2. **抽音轨 + ASR** —— 没字幕才走，慢一到两个数量级。
 *
 * 与云端内核 (/api/narration) 的差别：桌面端全程在本机跑，因此不受 Pages 墙钟
 * 限制，也不受机房 IP 风控影响。非桌面端环境返回 null，由调用方回退到云端。
 */
export async function localNarration(
  target: string | LocalNarrationSource,
  llm: { llmTextBaseUrl?: string; llmTextApiKey?: string; llmTextModel?: string; llmLanguage?: string },
  id = `nr_${Date.now()}`,
): Promise<LocalNarrationResult | null> {
  const api = getElectronAPI();
  if (!api?.narration) return null;
  const src: LocalNarrationSource = typeof target === 'string' ? { path: target } : target;

  const res = await api.narration({
    id,
    path: src.path || '',
    url: src.url,
    sourceUrl: src.sourceUrl,
    cookieFile: src.cookieFile,
    cookieBrowser: src.cookieBrowser,
    llmTextBaseUrl: llm.llmTextBaseUrl,
    llmTextApiKey: llm.llmTextApiKey,
    llmTextModel: llm.llmTextModel,
    language: llm.llmLanguage,
  });

  if (!res.ok) {
    // 「需要文件」不是失败：字幕这条路走不通，调用方下载音轨后再调一次即可
    if (res.needFile) return { transcript: '', needFile: true, error: res.error };
    throw new EngineError('electron', res.error || '本地旁白转写失败');
  }
  return {
    transcript: res.transcript,
    provider: res.provider,
    model: res.model,
    source: res.source,
    lang: res.lang,
  };
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
