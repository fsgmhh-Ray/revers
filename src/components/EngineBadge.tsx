import { IconDownload, IconExternal, IconSparkles } from './Icons';
import type { EngineState } from '../hooks/useEngine';
import { ENGINE_META, type EngineKind } from '../services/types';

/**
 * 分发渠道入口。正式上线后把 CHROME_STORE 换成商店审核通过的地址即可。
 */
const LINKS: Record<Exclude<EngineKind, 'cloud'>, { install: string; label: string }> = {
  electron: {
    install: 'https://github.com/fsgmhh-Ray/revers/releases/latest',
    label: '下载桌面端',
  },
  extension: {
    install: 'https://github.com/fsgmhh-Ray/revers/tree/main/extension#readme',
    label: '安装浏览器插件',
  },
};

const TONE: Record<EngineKind, { dot: string; text: string; ring: string }> = {
  electron: { dot: 'bg-brand', text: 'text-brand', ring: 'border-brand/30 bg-brand/10' },
  extension: { dot: 'bg-reel', text: 'text-reel', ring: 'border-reel/30 bg-reel/10' },
  cloud: { dot: 'bg-slate-500', text: 'text-slate-400', ring: 'border-white/5 bg-white/[.03]' },
};

/** 头部引擎状态胶囊 */
export function EngineBadge({ state }: { state: EngineState }) {
  const kind = state.active ?? 'cloud';
  const tone = TONE[kind];
  const dot = state.probing ? 'bg-slate-600 animate-pulse' : state.ready ? tone.dot : 'bg-rose-400';

  return (
    <div
      className={`hidden items-center gap-2 rounded-xl border px-2.5 py-1.5 md:flex ${tone.ring}`}
      title={state.detail || ''}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={`text-[11px] font-medium ${tone.text}`}>
        {state.probing ? '探测执行引擎…' : `${ENGINE_META[kind].label} · ${ENGINE_META[kind].short}`}
      </span>
      <button
        className="text-[10px] text-slate-500 hover:text-slate-300"
        onClick={state.refresh}
        title="重新探测"
      >
        ↻
      </button>
    </div>
  );
}

/**
 * 升级引导：当更强的引擎尚未安装时展示，
 * 把「插件 / 桌面端」作为渐进式交付的转化入口。
 */
export function EnginePromo({ state }: { state: EngineState }) {
  if (state.probing || !state.upgradeTo || state.upgradeTo === 'cloud') return null;
  const target = state.upgradeTo;
  const link = LINKS[target];

  return (
    <section className="rounded-2xl border border-white/[.06] bg-gradient-to-r from-white/[.04] to-transparent px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/[.06] text-brand">
          <IconSparkles width={16} height={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-slate-200">
            当前由「{state.activeLabel}」执行，YouTube / Instagram 可能被风控拦截
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {target === 'extension'
              ? '安装浏览器插件后，解析与下载将直接使用你的本机 IP 和浏览器登录态，机房 IP 封禁即刻失效。'
              : '桌面端内置 yt-dlp，可直读本机浏览器 Cookie，支持最高画质与本地 FFmpeg 抽帧（第二阶段）。'}
          </p>
        </div>
        <a className="btn-primary shrink-0" href={link.install} target="_blank" rel="noreferrer">
          {target === 'extension' ? <IconDownload width={14} height={14} /> : <IconDownload width={14} height={14} />}
          {link.label}
          <IconExternal width={13} height={13} />
        </a>
      </div>
    </section>
  );
}
