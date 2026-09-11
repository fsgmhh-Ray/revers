import type { Settings } from '../hooks/useSettings';
import type { GatewayHealth } from './Header';
import { IconClose, IconRefresh } from './Icons';

interface Props {
  open: boolean;
  settings: Settings;
  health: GatewayHealth | null;
  onClose: () => void;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onReset: () => void;
}

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

export function SettingsPanel({ open, settings, health, onClose, onChange, onReset }: Props) {
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
