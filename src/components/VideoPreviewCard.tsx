import { useState } from 'react';
import type { TaskItem } from '../types/parser';
import { platformMeta, formatBytes, formatDuration } from '../utils/platform';
import { proxyUrl } from '../utils/downloader';
import { getElectronAPI } from '../services/electronBridge';
import {
  IconAlert,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFilm,
  IconPlay,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from './Icons';

interface Props {
  task: TaskItem;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onDownload: (id: string) => void;
  onStoryboard: (task: TaskItem) => void;
}

export function VideoPreviewCard({ task, onRetry, onRemove, onDownload, onStoryboard }: Props) {
  const [playing, setPlaying] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const meta = platformMeta(task.data?.platform ?? 'unknown');
  const parsing = task.parseStatus === 'parsing' || task.parseStatus === 'idle';
  const failed = task.parseStatus === 'error';
  const downloading = task.downloadStatus === 'downloading';
  const done = task.downloadStatus === 'completed';

  const copyLink = async () => {
    if (!task.data?.downloadUrl) return;
    try {
      await navigator.clipboard.writeText(task.data.downloadUrl);
    } catch {
      /* 忽略剪贴板权限失败 */
    }
  };

  /** 桌面端下载后才有本地路径；网页/插件链路没有，按钮不显示 */
  const openFolder = () => {
    const api = getElectronAPI();
    if (api && task.savedPath) void api.reveal({ path: task.savedPath });
  };

  return (
    <article className="panel group relative flex animate-fade-up flex-col overflow-hidden">
      {/* 预览区 */}
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-ink-700">
        {parsing && (
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-ink-600/60" />
            <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[.07] to-transparent" />
            <div className="absolute inset-0 grid place-items-center">
              <span className="text-[11px] tracking-widest text-slate-400">PARSING…</span>
            </div>
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 grid place-items-center bg-rose-950/40 px-4 text-center">
            <div>
              <IconAlert width={22} height={22} className="mx-auto mb-2 text-rose-300" />
              <p className="line-clamp-3 text-[11.5px] leading-relaxed text-rose-200">{task.errorMsg || '解析失败'}</p>
              <button className="btn-ghost mt-3 !py-1.5 !text-[11.5px]" onClick={() => onRetry(task.id)}>
                <IconRefresh width={13} height={13} />
                重试
              </button>
            </div>
          </div>
        )}

        {task.parseStatus === 'success' && task.data && (
          <>
            {playing ? (
              <video
                className="h-full w-full object-contain"
                src={proxyUrl(task.data.downloadUrl, true)}
                poster={task.data.coverUrl ? proxyUrl(task.data.coverUrl, true) : undefined}
                controls
                autoPlay
                playsInline
              />
            ) : task.data.coverUrl && !coverFailed ? (
              <img
                src={proxyUrl(task.data.coverUrl, true)}
                alt={task.data.title}
                loading="lazy"
                onError={() => setCoverFailed(true)}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="grid h-full w-full place-items-center bg-gradient-to-br from-ink-600 to-ink-800">
                <IconFilm width={28} height={28} className="text-slate-600" />
              </div>
            )}

            {!playing && (
              <button
                className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => setPlaying(true)}
              >
                <span className="grid h-11 w-11 place-items-center rounded-full bg-white/15 ring-1 ring-white/40 backdrop-blur">
                  <IconPlay width={18} height={18} className="translate-x-[1px] text-white" />
                </span>
              </button>
            )}

            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2.5">
              <span className={`chip ${meta.badge} backdrop-blur`}>{meta.label}</span>
              <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">
                {formatDuration(task.data.duration)}
              </span>
            </div>

            {task.data.hasWatermark && (
              <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200 ring-1 ring-amber-400/30">
                含水印（兜底源）
              </span>
            )}
          </>
        )}

        {(downloading || done) && (
          <div className="absolute inset-x-0 bottom-0 p-2.5">
            <div className="progress-track">
              <div
                className={`progress-bar ${done ? 'from-emerald-400 to-emerald-300' : ''}`}
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-300">
              <span>{done ? '已保存' : `下载中 ${task.progress}%`}</span>
              <span>{formatBytes(task.data?.fileSize)}</span>
            </div>
          </div>
        )}
      </div>

      {/* 信息区 */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-[13px] font-medium leading-snug text-slate-100" title={task.data?.title}>
          {task.data?.title || task.inputUrl}
        </h3>

        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="truncate">{task.data?.author?.name || '—'}</span>
          {task.data?.provider && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px]">{task.data.provider}</span>}
        </div>

        <p className="line-clamp-1 font-mono text-[10.5px] text-slate-600" title={task.inputUrl}>
          {task.inputUrl}
        </p>

        {done && task.savedPath && (
          <div className="rounded-lg border border-emerald-400/15 bg-emerald-400/[.04] px-2 py-1.5">
            <p
              className="line-clamp-2 break-all font-mono text-[10px] leading-relaxed text-emerald-200/70"
              title={task.savedPath}
            >
              {task.savedPath}
            </p>
            <button className="mt-1 text-[10.5px] text-brand hover:underline" onClick={openFolder}>
              打开所在文件夹
            </button>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <button
            className="btn-ghost !px-2.5 !py-1.5 !text-[11.5px]"
            onClick={() => onDownload(task.id)}
            disabled={task.parseStatus !== 'success' || downloading}
          >
            <IconDownload width={13} height={13} />
            {done ? '重新下载' : '下载'}
          </button>

          <button
            className="btn-ghost !px-2 !py-1.5 !text-[11.5px]"
            onClick={() => onStoryboard(task)}
            disabled={task.parseStatus !== 'success'}
            title="逆向拆解为分镜剧本"
          >
            <IconSparkles width={13} height={13} />
            分镜
          </button>

          <button className="btn-ghost !px-2 !py-1.5" onClick={copyLink} disabled={!task.data?.downloadUrl} title="复制直链">
            <IconCopy width={13} height={13} />
          </button>

          <a
            className="btn-ghost !px-2 !py-1.5"
            href={task.inputUrl}
            target="_blank"
            rel="noreferrer"
            title="打开原链接"
          >
            <IconExternal width={13} height={13} />
          </a>

          <button
            className="btn-ghost ml-auto !px-2 !py-1.5 hover:!border-rose-500/30 hover:!text-rose-300"
            onClick={() => onRemove(task.id)}
            title="移除"
          >
            <IconTrash width={13} height={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
