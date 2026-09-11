/**
 * 引擎路由器：统一入口，按优先级嗅探当前运行环境。
 *
 *   Electron 桌面端  >  Chrome 插件  >  云端内核
 *
 * 桌面端最强（本机 IP + yt-dlp + 自动读浏览器 Cookie），
 * 插件次之（本机 IP + 跨域白名单 + chrome.downloads），
 * 云端兜底（零安装，但机房 IP 会被 IG / YT 风控）。
 *
 * 业务层只拿到一个 Engine 实例，不关心底层是 IPC、postMessage 还是 fetch。
 */

import type { PlatformType } from '../types/parser';
import { createCloudEngine } from './cloudBridge';
import { createElectronEngine, detectElectron, getElectronAPI, type ElectronHello } from './electronBridge';
import { createExtensionEngine, probeExtension, type ExtensionHello } from './extensionBridge';
import { EngineError, ENGINE_PRIORITY, type Engine, type EngineCapabilities, type EngineKind } from './types';

export type EnginePreference = 'auto' | EngineKind;

export interface ResolvedEngine {
  engine: Engine;
  /** 全部被探测过的引擎能力快照，用于 UI 引导 */
  capabilities: EngineCapabilities[];
  active: EngineKind;
  electron?: ElectronHello;
  extension?: ExtensionHello;
}

function unavailable(kind: EngineKind, detail: string): EngineCapabilities {
  return { kind, available: false, platforms: [], authed: [], detail };
}

export async function resolveEngine(preference: EnginePreference = 'auto'): Promise<ResolvedEngine> {
  const capabilities: EngineCapabilities[] = [];
  let electron: ElectronHello | undefined;
  let extension: ExtensionHello | undefined;

  // --- Electron ---
  if (preference === 'auto' || preference === 'electron') {
    const api = detectElectron() ? getElectronAPI() : null;
    if (api) {
      try {
        electron = await api.hello();
        const platforms: PlatformType[] = ['tiktok', 'instagram', 'youtube', 'douyin', 'xiaohongshu'];
        const caps: EngineCapabilities = {
          kind: 'electron',
          available: electron.ytDlp,
          version: electron.version,
          platforms,
          authed: electron.browsers.length
            ? (['instagram', 'youtube'] as PlatformType[])
            : [],
          detail: electron.ytDlp
            ? `本地 yt-dlp${electron.ytDlpVersion ? ` ${electron.ytDlpVersion}` : ''} · FFmpeg ${electron.ffmpeg ? '就绪' : '缺失'}`
            : '未检测到 yt-dlp',
        };
        capabilities.push(caps);
        if (caps.available) {
          return { engine: createElectronEngine(caps), capabilities, active: 'electron', electron };
        }
      } catch {
        capabilities.push(unavailable('electron', '桌面端握手失败'));
      }
    } else {
      capabilities.push(unavailable('electron', '未运行在桌面端中'));
    }
  }

  // --- Chrome Extension ---
  if (preference === 'auto' || preference === 'extension') {
    const hello = await probeExtension();
    if (hello) {
      extension = hello;
      const caps: EngineCapabilities = {
        kind: 'extension',
        available: true,
        version: hello.version,
        platforms: hello.platforms,
        authed: hello.authed,
        detail: hello.authed.length ? `已登录：${hello.authed.join(' / ')}` : '未检测到登录态',
      };
      capabilities.push(caps);
      return { engine: createExtensionEngine(caps), capabilities, active: 'extension', extension };
    }
    capabilities.push(unavailable('extension', '未检测到插件，可安装后免风控解析'));
  }

  // --- Cloud ---
  const cloud = createCloudEngine();
  capabilities.push(cloud.capabilities);
  return { engine: cloud, capabilities, active: 'cloud', electron, extension };
}

/** 供 UI 显示的推荐话术 */
export function nextBestEngine(capabilities: EngineCapabilities[]): EngineKind | null {
  const map = new Map(capabilities.map((c) => [c.kind, c]));
  for (const kind of ENGINE_PRIORITY) {
    const caps = map.get(kind);
    if (caps && !caps.available) return kind;
  }
  return null;
}

export { EngineError };
