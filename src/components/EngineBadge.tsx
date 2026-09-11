import { IconDownload, IconExternal, IconRefresh, IconShield, IconSparkles } from './Icons';
import type { EngineState } from '../hooks/useEngine';
import { ENGINE_META, type EngineKind } from '../services/types';

/**
 * 分发入口。正式发布后把 CHROME_STORE 换成商店地址，
 * EXT_GUIDE 是「开发者模式自装」的图文说明。
 */
const LINKS: Record<Exclude<EngineKind, 'cloud'>, { install: string; label: string; hint: string; guide: string }> = {
  extension: {
    install: 'https://github.com/fsgmhh-Ray/revers/tree/main/extension#readme',
    label: '安装浏览器插件',
    hint: '30 秒，无需重启浏览器，装完刷新本页自动生效',
    guide: 'https://github.com/fsgmhh-Ray/revers/tree/main/extension#readme',
  },
  electron: {
    install: 'https://github.com/fsgmhh-Ray/revers/releases/latest',
    label: '下载桌面端',
    hint: '能力最全：1080p+ 画质、本地 FFmpeg 抽帧，为第二阶段准备的客户端',
    guide: 'https://github.com/fsgmhh-Ray/revers/tree/main/desktop#readme',
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

/** 云端链路的能力边界说明 */
const CLOUD_LIMIT =
  'YouTube 与 Instagram 会封禁云服务器的机房 IP，云端链路解析它们大概率失败；' +
  '用你自己的电脑发出请求，风控自然失效。';

/**
 * 粘贴框上方的引导条：告诉用户当前由谁执行、有什么限制、以及如何升级。
 * 桌面端已就绪时不展示（那已经是最强链路）。
 */
export function EnginePromo({ state }: { state: EngineState }) {
  if (state.probing || state.active === 'electron') return null;

  const usingExtension = state.active === 'extension';
  const targets: Exclude<EngineKind, 'cloud'>[] = usingExtension ? ['electron'] : ['extension', 'electron'];

  return (
    <section className="panel border-white/[.08] bg-gradient-to-br from-white/[.05] via-white/[.02] to-transparent p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[.06] text-brand">
          <IconShield width={18} height={18} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-medium text-slate-100">
              当前由「{state.activeLabel}」执行
            </p>
            <button
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[.03] px-1.5 py-0.5 text-[10.5px] text-slate-400 hover:text-slate-200"
              onClick={state.refresh}
            >
              <IconRefresh width={11} height={11} />
              重新检测
            </button>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
            {usingExtension
              ? '已在用你的本机 IP 解析。需要 1080p+ 画质或第二阶段本地抽帧，可升级到桌面端。'
              : CLOUD_LIMIT}
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {targets.map((target) => {
            const link = LINKS[target];
            const primary = !usingExtension && target === 'extension';
            return (
              <a
                key={target}
                className={primary ? 'btn-primary' : 'btn-ghost'}
                href={link.install}
                target="_blank"
                rel="noreferrer"
                title={link.hint}
              >
                <IconDownload width={14} height={14} />
                {link.label}
                <IconExternal width={13} height={13} />
              </a>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {targets.map((target) => (
          <a
            key={target}
            className="group flex items-start gap-2.5 rounded-xl border border-white/[.06] bg-white/[.02] px-3 py-2.5 transition-colors hover:border-white/15"
            href={LINKS[target].guide}
            target="_blank"
            rel="noreferrer"
          >
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/[.06] text-[10px] text-brand-soft">
              {target === 'extension' ? '1' : '2'}
            </span>
            <span className="min-w-0">
              <span className="block text-[12px] text-slate-200 group-hover:text-white">
                {target === 'extension' ? '浏览器插件' : '桌面客户端'}
                <span className="ml-1.5 text-[10.5px] text-slate-500">
                  {target === 'extension' ? '推荐先装' : '重度使用'}
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                {target === 'extension'
                  ? '用本机 IP + 浏览器里现成的登录态请求，免导出 Cookie；最高约 720p。'
                  : '内置 yt-dlp + FFmpeg，直读本机 Cookie，支持 1080p+ 音视频合并与本地抽帧。'}
              </span>
            </span>
          </a>
        ))}
      </div>

      {!usingExtension && (
        <p className="mt-2.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-600">
          <IconSparkles width={12} height={12} />
          装完插件后回到本页会自动切换；若状态没更新，点上方「重新检测」。TikTok 不装也能用云端解析。
        </p>
      )}
    </section>
  );
}
