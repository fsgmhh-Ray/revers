import { useEffect, useState } from 'react';
import { IconClose, IconExternal } from './Icons';
import {
  getFeed,
  onConnection,
  onFeed,
  startClientChannel,
  stopClientChannel,
} from '../services/clientChannel';
import type { ClientFeed, ConnectionState } from '../types/clientFeed';

const DISMISS_KEY = 'cf_feed_dismissed';

function loadDismissed(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
  } catch {
    return {};
  }
}

function markDismissed(id: string): void {
  const d = loadDismissed();
  d[id] = Date.now();
  localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
}

/** 顶栏「已连接主站」状态点（桌面端由主进程心跳驱动，网页端跟随浏览器网络）。 */
export function ConnectionDot() {
  const [conn, setConn] = useState<ConnectionState>(() => ({
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    at: Date.now(),
  }));
  const [, tick] = useState(0);

  useEffect(() => {
    const off = onConnection(setConn);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const secs = Math.max(0, Math.round((Date.now() - conn.at) / 1000));
  return (
    <div
      className="hidden items-center gap-2 rounded-xl border border-white/5 bg-white/[.03] px-2.5 py-1.5 md:flex"
      title={conn.online ? `已连接主站 · ${secs}s 前同步` : '与主站连接中断'}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          conn.online ? 'bg-emerald-400' : 'bg-rose-400 animate-pulse'
        }`}
      />
      <span className="text-[11px] text-slate-400">{conn.online ? `已连接 · ${secs}s` : '离线'}</span>
    </div>
  );
}

/** 升级 / 广告 / 推广投放层。挂载一次即可，内部自动订阅 feed。 */
export function ClientFeed() {
  const [feed, setFeed] = useState<ClientFeed | null>(getFeed());
  const [dismissed, setDismissed] = useState<Record<string, number>>(loadDismissed());

  useEffect(() => {
    startClientChannel();
    const offFeed = onFeed(setFeed);
    return () => {
      offFeed();
      stopClientChannel();
    };
  }, []);

  const dismiss = (id: string) => {
    markDismissed(id);
    setDismissed(loadDismissed());
  };

  if (!feed) return null;

  const bannerVisible = feed.banner && !dismissed[feed.banner.id];
  const upgradeKey = `upgrade:${feed.latestVersion}`;
  const upgradeVisible =
    (feed.upgrade.required || feed.upgrade.available) && !dismissed[upgradeKey];

  return (
    <>
      {bannerVisible && feed.banner && (
        <div className="relative overflow-hidden rounded-xl border border-brand/30 bg-gradient-to-r from-brand/10 to-reel/10 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-slate-100">{feed.banner.title}</p>
              {feed.banner.body && (
                <p className="truncate text-[11px] text-slate-400">{feed.banner.body}</p>
              )}
            </div>
            {feed.banner.url && (
              <a
                className="btn-ghost shrink-0 text-[11px]"
                href={feed.banner.url}
                target="_blank"
                rel="noreferrer"
              >
                {feed.banner.cta || '查看'}
                <IconExternal width={12} height={12} />
              </a>
            )}
            <button
              className="shrink-0 text-slate-500 transition hover:text-slate-300"
              onClick={() => dismiss(feed.banner!.id)}
              title="不再显示"
            >
              <IconClose width={14} height={14} />
            </button>
          </div>
        </div>
      )}

      {upgradeVisible && (
        <div className="relative rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-amber-200">
                {feed.upgrade.title}
                {feed.upgrade.required ? '（建议尽快更新）' : '（可选）'}
              </p>
              {feed.upgrade.notes && (
                <p className="truncate text-[11px] text-slate-400">{feed.upgrade.notes}</p>
              )}
            </div>
            {feed.upgrade.url && (
              <a
                className="btn-ghost shrink-0 text-[11px] text-amber-200"
                href={feed.upgrade.url}
                target="_blank"
                rel="noreferrer"
              >
                立即升级
                <IconExternal width={12} height={12} />
              </a>
            )}
            <button
              className="shrink-0 text-slate-500 transition hover:text-slate-300"
              onClick={() => dismiss(upgradeKey)}
              title="稍后再说"
            >
              <IconClose width={14} height={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
