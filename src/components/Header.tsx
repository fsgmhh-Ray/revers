import { IconExternal, IconFilm, IconSettings } from './Icons';
import { EngineBadge } from './EngineBadge';
import { ConnectionDot } from './ClientFeed';
import type { EngineState } from '../hooks/useEngine';

export interface GatewayHealth {
  ok: boolean;
  providers?: {
    mock?: boolean;
    cobalt?: boolean;
    ytdlp?: boolean;
    tikwm?: boolean;
  };
  probe?: {
    endpointHost?: string;
    reachable?: boolean;
    httpStatus?: number;
    latencyMs?: number;
    error?: string;
    hint?: string;
  };
}

const MAIN_SITE = 'https://www.cineflowing.com/';

export function Header({
  health,
  engine,
  onOpenSettings,
}: {
  health: GatewayHealth | null;
  engine: EngineState;
  onOpenSettings: () => void;
}) {
  const active = health?.providers
    ? Object.entries(health.providers)
        .filter(([, enabled]) => enabled)
        .map(([key]) => (key === 'ytdlp' ? 'yt-dlp' : key))
        .join(' · ')
    : '';

  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-900/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-reel text-white shadow-glow">
            <IconFilm width={18} height={18} />
          </div>
          <div className="leading-tight">
            <div className="flex items-baseline gap-2">
              <h1 className="text-[15px] font-semibold tracking-wide text-white">REVERSE</h1>
              <span className="text-[11px] font-medium text-slate-500">reverse.cineflowing.com</span>
            </div>
            <p className="text-[11.5px] text-slate-400">爆款短剧反向工程工坊 · 无水印解析 / 批量下载 / 分镜逆向</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ConnectionDot />
          <EngineBadge state={engine} />

          <div className="hidden items-center gap-2 rounded-xl border border-white/5 bg-white/[.03] px-2.5 py-1.5 md:flex">
            <span
              className={`h-1.5 w-1.5 rounded-full ${health?.ok ? 'bg-emerald-400' : 'bg-slate-600'} ${
                health?.ok ? '' : 'animate-pulse'
              }`}
            />
            <span className="text-[11px] text-slate-400">
              {health ? (active ? `解析链：${active}` : '未配置解析源') : '检测中…'}
            </span>
          </div>

          {health?.probe && (
            <div
              className="hidden items-center gap-2 rounded-xl border border-white/5 bg-white/[.03] px-2.5 py-1.5 lg:flex"
              title={health.probe.hint || health.probe.error || ''}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  health.probe.reachable ? 'bg-emerald-400' : 'bg-rose-400'
                }`}
              />
              <span className="text-[11px] text-slate-400">
                内核 {health.probe.endpointHost} ·{' '}
                {health.probe.reachable
                  ? `${health.probe.latencyMs}ms`
                  : `HTTP ${health.probe.httpStatus ?? 'ERR'}`}
              </span>
            </div>
          )}

          <a className="btn-ghost hidden sm:inline-flex" href={MAIN_SITE} target="_blank" rel="noreferrer">
            主站 cineflowing.com
            <IconExternal width={14} height={14} />
          </a>

          <button className="btn-ghost" onClick={onOpenSettings} title="设置">
            <IconSettings width={15} height={15} />
            <span className="hidden sm:inline">设置</span>
          </button>
        </div>
      </div>
    </header>
  );
}
