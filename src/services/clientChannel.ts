/**
 * 客户端长连接通道（主站 ↔ 桌面端 / 网页 / 插件）。
 *
 * 职责：
 *   1. 统一拉取运营投放（升级 / 广告 / 推广）—— 自动识别运行时：
 *      - 桌面端：由主进程心跳驱动，原生事件直接转发；
 *      - 网页 / 插件：直接请求同源 /api/client-feed 并轮询。
 *   2. 暴露连接状态（online / 最后同步时间），供界面显示「已连接主站」。
 *
 * 这是「客户粘性」的基础设施：主站可随时通过 feed 下发公告、升级与推广。
 */

import { APP_VERSION } from '../config';
import type { ClientFeed, ConnectionState } from '../types/clientFeed';
import { detectElectron, getElectronAPI } from './electronBridge';

let lastFeed: ClientFeed | null = null;
let lastConn: ConnectionState = {
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  at: Date.now(),
};

const feedListeners = new Set<(f: ClientFeed) => void>();
const connListeners = new Set<(c: ConnectionState) => void>();

function notifyFeed() {
  for (const h of feedListeners) h(lastFeed!);
}
function notifyConnection(c: ConnectionState) {
  lastConn = c;
  for (const h of connListeners) h(c);
}

/** 拉取一次 feed。桌面端优先走原生桥（已有主进程缓存），否则直连同源接口。 */
export async function fetchFeed(): Promise<ClientFeed | null> {
  const api = getElectronAPI();
  if (api?.fetchFeed) {
    const f = await api.fetchFeed();
    if (f) {
      lastFeed = f;
      notifyFeed();
    }
    return f;
  }
  try {
    const res = await fetch(`/api/client-feed?v=${encodeURIComponent(APP_VERSION)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const f = (await res.json()) as ClientFeed;
    lastFeed = f;
    notifyFeed();
    return f;
  } catch {
    return null;
  }
}

export function getFeed(): ClientFeed | null {
  return lastFeed;
}

export function getConnection(): ConnectionState {
  return lastConn;
}

/** 订阅 feed 变化；注册时立即回放最近一次（若有）。 */
export function onFeed(handler: (f: ClientFeed) => void): () => void {
  feedListeners.add(handler);
  if (lastFeed) handler(lastFeed);
  return () => feedListeners.delete(handler);
}

export function onConnection(handler: (c: ConnectionState) => void): () => void {
  connListeners.add(handler);
  handler(lastConn);
  return () => connListeners.delete(handler);
}

/* ------------------------------------------------------------------ */
/* 运行时绑定                                                          */
/* ------------------------------------------------------------------ */

// 桌面端：主进程通过 IPC 主动推送 feed 与连接状态
if (detectElectron()) {
  const api = getElectronAPI();
  api?.onFeed?.((f) => {
    lastFeed = f;
    notifyFeed();
  });
  api?.onConnection?.((c) => notifyConnection(c));
}

// 网页 / 插件：跟随浏览器在线状态
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => notifyConnection({ online: true, at: Date.now() }));
  window.addEventListener('offline', () => notifyConnection({ online: false, at: Date.now() }));
}

/* ------------------------------------------------------------------ */
/* 心跳（仅网页 / 插件 需要；桌面端由主进程驱动，这里跳过以免重复拉取） */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setInterval> | null = null;

export function startClientChannel(): void {
  if (timer) return;
  void fetchFeed();
  if (detectElectron()) return; // 桌面端心跳在主进程，渲染进程不重复轮询
  const interval = (lastFeed?.heartbeatIntervalSec || 45) * 1000;
  timer = setInterval(() => void fetchFeed(), Math.max(15_000, interval));
}

export function stopClientChannel(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
