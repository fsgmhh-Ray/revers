import type { EngineState } from '../hooks/useEngine';
import type { Settings } from '../hooks/useSettings';
import { ENGINE_META, type EngineKind } from '../services/types';
import type { EnginePreference } from '../services/engineRouter';
import type { GatewayHealth } from './Header';
import { IconClose, IconRefresh } from './Icons';

interface Props {
  open: boolean;
  settings: Settings;
  health: GatewayHealth | null;
  engine: EngineState;
  onClose: () => void;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onReset: () => void;
}

const ENGINE_OPTIONS: { value: EnginePreference; label: string; desc: string }[] = [
  { value: 'auto', label: '自动', desc: '按 桌面端 → 浏览器插件 → 云端 依次嗅探，取第一个就绪的' },
  { value: 'electron', label: ENGINE_META.electron.label, desc: ENGINE_META.electron.tag },
  { value: 'extension', label: ENGINE_META.extension.label, desc: ENGINE_META.extension.tag },
  { value: 'cloud', label: ENGINE_META.cloud.label, desc: ENGINE_META.cloud.tag },
];

/** 强引擎未就绪时给出可行动提示 */
const MISSING_HINT: Record<EngineKind, string> = {
  electron: '未运行在桌面端中。下载桌面客户端后，解析与下载全部走你本机 IP。',
  extension: '未检测到插件。安装后用你自己的 IP 与浏览器登录态发起请求，机房 IP 封禁失效。',
  cloud: '网关未就绪，检查 Pages 环境变量 COBALT_INSTANCE_URL。',
};

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2.5">
      <span>
        <span className="block text-[13px] text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{hint}</span>}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand' : 'bg-ink-500'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}

export function SettingsPanel({ open, settings, health, engine, onClose, onChange, onReset }: Props) {
  if (!open) return null;

  const providerRows: { key: string; label: string; desc: string }[] = [
    { key: 'cobalt', label: 'Cobalt 自建内核', desc: '推荐。独立 VPS 部署，规避 YT / IG 对 Cloudflare 出口 IP 的封禁' },
    { key: 'ytdlp', label: 'yt-dlp 自建内核', desc: 'parser-core 兼容协议，覆盖抖音 / 小红书等国内平台' },
    { key: 'tikwm', label: 'TikWM 公共源', desc: 'TikTok 兜底，无需自建即可用' },
    { key: 'mock', label: '演示模式', desc: '返回示例素材，仅用于 UI 联调' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[420px] animate-fade-up flex-col border-l border-white/5 bg-ink-800/95 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <h2 className="text-sm font-semibold text-white">工坊设置</h2>
          <button className="text-slate-400 hover:text-white" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <section className="mb-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">解析链状态</h3>
            <div className="space-y-2">
              {providerRows.map((row) => {
                const enabled = Boolean((health?.providers as Record<string, boolean> | undefined)?.[row.key]);
                return (
                  <div key={row.key} className="flex items-start gap-2.5 rounded-xl border border-white/5 bg-white/[.02] p-2.5">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    <div>
                      <p className="text-[12.5px] text-slate-200">{row.label}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{row.desc}</p>
                    </div>
                    <span className={`ml-auto text-[10.5px] ${enabled ? 'text-emerald-300' : 'text-slate-600'}`}>
                      {enabled ? '已启用' : '未启用'}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[.06] p-2.5 text-[11px] leading-relaxed text-amber-200/80">
              Instagram Reels 与 YouTube Shorts 会封禁 Cloudflare 数据中心网段。生产环境请在 Pages 环境变量配置
              <code className="mx-1 rounded bg-black/40 px-1">COBALT_INSTANCE_URL</code>
              指向自建解析内核（见仓库 parser-core 目录，Docker 一键部署）。
            </p>
          </section>

          <section className="mb-6">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">执行引擎</h3>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
              决定由谁去发请求。机房 IP 会被 YouTube / Instagram 风控，用你自己的 IP 才能稳定解析。
            </p>
            <div className="space-y-1.5">
              {ENGINE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                    settings.engine === option.value
                      ? 'border-brand/50 bg-brand/10'
                      : 'border-white/5 bg-white/[.02] hover:border-white/15'
                  }`}
                >
                  <input
                    type="radio"
                    name="engine"
                    className="mt-0.5 accent-brand"
                    checked={settings.engine === option.value}
                    onChange={() => onChange('engine', option.value)}
                  />
                  <span className="flex-1">
                    <span className="block text-[12.5px] text-slate-200">{option.label}</span>
                    <span className="block text-[11px] leading-relaxed text-slate-500">{option.desc}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-2.5 space-y-1.5 rounded-xl border border-white/5 bg-white/[.02] p-2.5">
              {engine.capabilities.length === 0 ? (
                <p className="text-[11px] text-slate-500">正在探测…</p>
              ) : (
                engine.capabilities.map((caps) => (
                  <div key={caps.kind} className="flex items-start gap-2">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                        caps.available ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] text-slate-300">
                        {ENGINE_META[caps.kind].label}
                        {caps.version ? <span className="text-slate-600"> · v{caps.version}</span> : null}
                        <span className={caps.available ? 'ml-1.5 text-emerald-300' : 'ml-1.5 text-slate-600'}>
                          {caps.available ? '就绪' : '不可用'}
                        </span>
                      </p>
                      <p className="text-[10.5px] text-slate-500">
                        {caps.available ? caps.detail || ENGINE_META[caps.kind].tag : MISSING_HINT[caps.kind]}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <button
                type="button"
                className="mt-1 text-[11px] text-brand hover:underline"
                onClick={engine.refresh}
              >
                重新探测
              </button>
            </div>

            {engine.active === 'electron' && (
              <label className="mt-2.5 flex items-center justify-between rounded-xl border border-white/5 bg-white/[.02] px-3 py-2.5">
                <span className="text-[12.5px] text-slate-200">读取登录态的浏览器</span>
                <select
                  className="field !w-auto !py-1 text-[12px]"
                  value={settings.cookieBrowser}
                  onChange={(e) => onChange('cookieBrowser', e.target.value)}
                >
                  {['auto', 'chrome', 'edge', 'firefox', 'brave', 'vivaldi', 'safari'].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>

          <section className="mb-6">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">调度</h3>
            <div className="divide-y divide-white/5">
              <label className="flex items-center justify-between py-3">
                <span className="text-[13px] text-slate-200">解析并发数</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.parseConcurrency}
                  onChange={(e) => onChange('parseConcurrency', Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
                  className="field w-20 !py-1 text-center"
                />
              </label>
              <label className="flex items-center justify-between py-3">
                <span className="text-[13px] text-slate-200">下载并发数</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={settings.downloadConcurrency}
                  onChange={(e) =>
                    onChange('downloadConcurrency', Math.min(6, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className="field w-20 !py-1 text-center"
                />
              </label>
              <Toggle
                label="打包为 ZIP 下载"
                hint="批量场景推荐：浏览器会拦截连续多文件下载"
                checked={settings.preferZip}
                onChange={(v) => onChange('preferZip', v)}
              />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">文件名规则</h3>
            <div className="space-y-1.5">
              {(
                [
                  { value: 'platform_author_title', label: '平台_作者_标题', example: 'tiktok_scott_keep_watching.mp4' },
                  { value: 'title', label: '标题', example: 'keep_watching_this.mp4' },
                  { value: 'id', label: '视频 ID', example: '7106594312292453675.mp4' },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                    settings.filenamePattern === option.value
                      ? 'border-brand/50 bg-brand/10'
                      : 'border-white/5 bg-white/[.02] hover:border-white/15'
                  }`}
                >
                  <input
                    type="radio"
                    name="filenamePattern"
                    className="accent-brand"
                    checked={settings.filenamePattern === option.value}
                    onChange={() => onChange('filenamePattern', option.value)}
                  />
                  <span className="flex-1">
                    <span className="block text-[12.5px] text-slate-200">{option.label}</span>
                    <span className="block font-mono text-[10.5px] text-slate-500">{option.example}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        </div>

        <div className="border-t border-white/5 px-5 py-3">
          <button className="btn-ghost w-full !py-2 !text-[12.5px]" onClick={onReset}>
            <IconRefresh width={14} height={14} />
            恢复默认设置
          </button>
        </div>
      </aside>
    </div>
  );
}
