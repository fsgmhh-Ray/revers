import { useEffect, useState } from 'react';
import type { TaskItem } from '../types/parser';
import type { AnalysisStatus, StoryboardResult } from '../types/storyboard';
import { proxyUrl } from '../utils/downloader';
import { platformMeta } from '../utils/platform';
import { getElectronAPI } from '../services/electronBridge';
import { downloadText, safeName, seconds, timecode, toCsv, toMarkdown } from '../utils/storyboard';
import { IconClose, IconExternal, IconRefresh, IconSparkles } from './Icons';

/**
 * Stage 2 分镜逆向抽屉。
 *
 * 拆解在本机完成（桌面端的 FFmpeg 抽帧），所以：
 *   - 必须先有本地文件（下载过）才能拆；
 *   - 关键帧以 data URL 回传，不需要图床，也不经过网络。
 *
 * 没有桌面端时如实说明能力边界，不假装能拆。
 */
export function StoryboardDrawer({
  task,
  onClose,
  onPush,
}: {
  task: TaskItem | null;
  onClose: () => void;
  onPush: (task: TaskItem) => void;
}) {
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [result, setResult] = useState<StoryboardResult | null>(null);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState(0.3);

  const taskId = task?.id;

  // 切换任务时清空上一次的拆解结果，避免张冠李戴
  useEffect(() => {
    setStatus('idle');
    setProgress(0);
    setStage('');
    setResult(null);
    setError('');
  }, [taskId]);

  // 订阅抽帧进度（主进程逐帧回报）
  useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    return api.onStoryboardProgress((event) => {
      if (taskId && event.id !== taskId) return;
      setProgress(event.percent);
      setStage(event.stage);
    });
  }, [taskId]);

  if (!task) return null;

  const meta = platformMeta(task.data?.platform ?? 'unknown');
  const api = getElectronAPI();
  const desktopReady = Boolean(api);
  const hasLocal = Boolean(task.savedPath);
  const busy = status === 'extracting' || status === 'analyzing';
  const nodes = result?.nodes ?? [];

  const start = async () => {
    if (!api) {
      setError('分镜拆解在本机完成（FFmpeg 抽帧），需要安装桌面客户端。浏览器插件与云端链路没有本地文件系统权限。');
      setStatus('error');
      return;
    }
    if (!task.savedPath) {
      setError('还没下载到本机。请先点「下载」，视频存到本地后再来拆解。');
      setStatus('error');
      return;
    }

    setStatus('extracting');
    setProgress(0);
    setStage('准备中');
    setError('');

    try {
      const res = await api.storyboard({
        id: task.id,
        path: task.savedPath,
        sceneThreshold: threshold,
        maxShots: 48,
        frameWidth: 480,
      });
      if (!res || !res.ok) {
        setStatus('error');
        setError(res?.error || '拆解失败');
        return;
      }
      setResult(res);
      setStatus('success');
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : '拆解失败');
    }
  };

  const baseName = safeName(task.data?.title || 'storyboard');
  const exportMd = () =>
    downloadText(`${baseName}_分镜.md`, toMarkdown(nodes, { title: task.data?.title, stats: result?.stats }), 'text/markdown;charset=utf-8');
  const exportCsv = () => downloadText(`${baseName}_分镜.csv`, toCsv(nodes), 'text/csv;charset=utf-8');
  const exportJson = () =>
    downloadText(`${baseName}_分镜.json`, JSON.stringify({ video: task.data, storyboard: result }, null, 2), 'application/json');

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[1080px] animate-fade-up flex-col border-l border-white/5 bg-ink-800/95 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/5 px-5 py-3.5">
          <IconSparkles width={16} height={16} className="text-brand-soft" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">分镜逆向拆解 · Stage 2</h2>
            <p className="truncate text-[11px] text-slate-500">{task.data?.title || task.inputUrl}</p>
          </div>
          <span className={`chip ${meta.badge}`}>{meta.label}</span>
          <button className="text-slate-400 hover:text-white" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[360px_1fr]">
          {/* 左：预览 + 控制 */}
          <div className="overflow-y-auto border-r border-white/5 bg-black/40 p-4">
            {task.data?.downloadUrl ? (
              <video
                className="w-full rounded-xl bg-black"
                src={proxyUrl(task.data.downloadUrl, true)}
                poster={task.data.coverUrl ? proxyUrl(task.data.coverUrl, true) : undefined}
                controls
                playsInline
              />
            ) : (
              <div className="grid aspect-[9/16] w-full place-items-center rounded-xl bg-ink-700 text-[12px] text-slate-500">
                无可播放源
              </div>
            )}

            <div className="mt-3 space-y-1.5 text-[11.5px] text-slate-400">
              <p>
                作者：<span className="text-slate-200">{task.data?.author?.name || '—'}</span>
              </p>
              <p>
                时长：<span className="text-slate-200">{task.data?.duration || '—'} 秒</span>
              </p>
              <p>
                本地文件：
                <span className={hasLocal ? 'text-emerald-300' : 'text-amber-300'}>
                  {hasLocal ? '已就绪' : '未下载'}
                </span>
              </p>
            </div>

            {hasLocal && (
              <p className="mt-1.5 break-all font-mono text-[10px] leading-relaxed text-slate-600" title={task.savedPath}>
                {task.savedPath}
              </p>
            )}

            <div className="mt-4 rounded-xl border border-white/5 bg-white/[.02] p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] text-slate-300">场景灵敏度</span>
                <span className="font-mono text-[11px] text-slate-500">{threshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.6}
                step={0.05}
                value={threshold}
                disabled={busy}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="mt-2 w-full accent-brand"
              />
              <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
                值越小切得越碎（镜头更多），越大越保守。默认 0.30 适合大多数短视频。
              </p>

              <button
                className="btn-primary mt-3 w-full !py-2 !text-[12.5px]"
                onClick={() => void start()}
                disabled={busy || !desktopReady || !hasLocal}
              >
                <IconSparkles width={14} height={14} />
                {busy ? `拆解中 ${progress}%` : '一键拆解'}
              </button>

              {!desktopReady && (
                <p className="mt-2 text-[10.5px] leading-relaxed text-amber-300/80">
                  未检测到桌面客户端。分镜需要本机 FFmpeg 抽帧，插件与云端做不到。
                </p>
              )}
              {desktopReady && !hasLocal && (
                <p className="mt-2 text-[10.5px] leading-relaxed text-amber-300/80">请先下载到本机再拆解。</p>
              )}

              {busy && (
                <>
                  <div className="progress-track mt-2">
                    <div className="progress-bar" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="mt-1 text-[10.5px] text-slate-500">{stage}</p>
                </>
              )}
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/[.06] p-2.5 text-[11px] leading-relaxed text-rose-200">
                {error}
              </div>
            )}
          </div>

          {/* 右：结果 */}
          <div className="overflow-y-auto p-5">
            {status === 'success' && result ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { k: '镜头数', v: String(result.stats?.sceneCount ?? nodes.length) },
                    { k: '平均镜头', v: seconds(result.stats?.avgShotDuration ?? 0) },
                    { k: '总时长', v: seconds(result.source?.duration ?? 0) },
                    { k: '分辨率', v: result.source?.width ? `${result.source.width}×${result.source.height}` : '—' },
                  ].map((item) => (
                    <div key={item.k} className="rounded-xl border border-white/5 bg-white/[.02] px-3 py-2">
                      <p className="text-[10.5px] text-slate-500">{item.k}</p>
                      <p className="mt-0.5 text-[13px] font-medium text-slate-100">{item.v}</p>
                    </div>
                  ))}
                </div>

                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand/20 bg-brand/[.06] px-3 py-2">
                  <span className="text-[11.5px] text-slate-200">节奏：{result.stats?.cutRhythm}</span>
                  <span className="text-[10.5px] text-slate-500">· {result.stats?.analyzedBy}</span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportMd}>
                      导出 Markdown
                    </button>
                    <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportCsv}>
                      导出 CSV
                    </button>
                    <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportJson}>
                      导出 JSON
                    </button>
                  </div>
                </div>

                {result.stats?.note && (
                  <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[.05] px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
                    {result.stats.note}
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {nodes.map((n) => (
                    <article key={n.id} className="overflow-hidden rounded-xl border border-white/5 bg-white/[.02]">
                      <div className="relative aspect-video bg-black">
                        {n.thumbnailUrl ? (
                          <img src={n.thumbnailUrl} alt={`镜头 ${n.index}`} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-[11px] text-slate-600">无关键帧</div>
                        )}
                        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                          #{n.index} · {timecode(n.startTime)}
                        </span>
                        <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                          {seconds(n.duration ?? n.endTime - n.startTime)}
                        </span>
                      </div>
                      <div className="space-y-1 p-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <span className="chip bg-brand/15 text-brand-soft">{n.shotType}</span>
                          <span className="chip bg-white/5 text-slate-400">{n.cameraMovement}</span>
                        </div>
                        <p className="font-mono text-[10px] text-slate-600">
                          {timecode(n.startTime)} → {timecode(n.endTime)}
                        </p>
                        {n.visualDescription && (
                          <p className="line-clamp-3 text-[11px] leading-relaxed text-slate-400">{n.visualDescription}</p>
                        )}
                        {n.dialogue && (
                          <p className="line-clamp-2 text-[11px] leading-relaxed text-slate-300">「{n.dialogue}」</p>
                        )}
                        {n.inferred && (
                          <p className="text-[10px] text-slate-600">景别/运镜由剪辑时长推断</p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-white/[.02] p-6">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand-soft">
                  <IconSparkles width={20} height={20} />
                </div>
                <h3 className="mt-3 text-center text-sm font-medium text-slate-100">
                  {busy ? '正在拆解…' : '把视频逆向成可拍的分镜表'}
                </h3>
                <p className="mx-auto mt-1.5 max-w-md text-center text-[12px] leading-relaxed text-slate-500">
                  本机 FFmpeg 做场景切分与关键帧抽取，输出每个镜头的起止时间、时长、
                  景别与运镜，可导出 Markdown / CSV / JSON 直接进剧本或生图工作流。
                </p>

                {busy && (
                  <div className="mx-auto mt-4 max-w-md">
                    <div className="progress-track">
                      <div className="progress-bar" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="mt-1.5 text-center text-[11px] text-slate-500">
                      {stage} · {progress}%
                    </p>
                  </div>
                )}

                <div className="mx-auto mt-5 grid max-w-2xl gap-2 sm:grid-cols-2">
                  {[
                    { step: '01', title: '场景切分', desc: `FFmpeg scene 检测（阈值 ${threshold.toFixed(2)}）定位每个镜头切换点` },
                    { step: '02', title: '关键帧抽取', desc: '每个镜头中点抽一帧，直接回传页面，不经过网络与图床' },
                    { step: '03', title: '时间轴对齐', desc: '起止时间、时长、镜头节奏统计一次算清' },
                    { step: '04', title: 'Prompt 逆向', desc: '占位字段已就位，接入多模态模型后自动填充' },
                  ].map((item) => (
                    <div key={item.step} className="rounded-xl border border-white/5 bg-white/[.02] p-3">
                      <span className="font-mono text-[10.5px] text-brand-soft">{item.step}</span>
                      <p className="mt-1 text-[12.5px] text-slate-200">{item.title}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.desc}</p>
                    </div>
                  ))}
                </div>

                {error && (
                  <p className="mx-auto mt-4 max-w-md text-center text-[11px] leading-relaxed text-rose-300">{error}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/5 px-5 py-3">
          <button className="btn-ghost !py-2 !text-[12.5px]" onClick={onClose}>
            关闭
          </button>
          <div className="ml-auto flex items-center gap-2">
            {status === 'success' && (
              <button className="btn-ghost !py-2 !text-[12.5px]" onClick={() => void start()} disabled={busy}>
                <IconRefresh width={13} height={13} />
                重新拆解
              </button>
            )}
            <button className="btn-primary !py-2 !text-[12.5px]" onClick={() => onPush(task)}>
              推送到主站
              <IconExternal width={14} height={14} />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
