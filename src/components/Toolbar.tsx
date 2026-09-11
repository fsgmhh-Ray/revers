import type { TaskItem } from '../types/parser';
import { IconDownload, IconRefresh, IconTrash, IconZip } from './Icons';

interface Props {
  tasks: TaskItem[];
  isParsing: boolean;
  isDownloading: boolean;
  onDownloadAll: () => void;
  onCancel: () => void;
  onClearAll: () => void;
  onClearFinished: () => void;
}

export function Toolbar({
  tasks,
  isParsing,
  isDownloading,
  onDownloadAll,
  onCancel,
  onClearAll,
  onClearFinished,
}: Props) {
  const ready = tasks.filter((t) => t.parseStatus === 'success').length;
  const failed = tasks.filter((t) => t.parseStatus === 'error').length;
  const saved = tasks.filter((t) => t.downloadStatus === 'completed').length;
  const busy = isParsing || isDownloading;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/5 bg-ink-800/50 px-3.5 py-2.5 backdrop-blur">
      <div className="flex items-center gap-3 text-[11.5px] text-slate-400">
        <span>
          总计 <b className="text-slate-100">{tasks.length}</b>
        </span>
        <span className="text-ink-400">|</span>
        <span>
          可下载 <b className="text-emerald-300">{ready}</b>
        </span>
        <span className="text-ink-400">|</span>
        <span>
          失败 <b className="text-rose-300">{failed}</b>
        </span>
        <span className="text-ink-400">|</span>
        <span>
          已保存 <b className="text-brand-soft">{saved}</b>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {busy && (
          <button className="btn-ghost !py-1.5 !text-[12px]" onClick={onCancel}>
            取消
          </button>
        )}
        <button className="btn-ghost !py-1.5 !text-[12px]" onClick={onClearFinished} disabled={!tasks.length}>
          <IconRefresh width={13} height={13} />
          清理已完成
        </button>
        <button className="btn-danger !py-1.5 !text-[12px]" onClick={onClearAll} disabled={!tasks.length}>
          <IconTrash width={13} height={13} />
          清空
        </button>
        <button className="btn-primary !py-1.5 !text-[12px]" onClick={onDownloadAll} disabled={!ready || isDownloading}>
          {isDownloading ? '下载中…' : <IconDownload width={14} height={14} />}
          {isDownloading ? '' : '批量下载'}
        </button>
        <span className="hidden items-center gap-1 text-[10.5px] text-slate-600 lg:flex">
          <IconZip width={12} height={12} />
          设置中可切换 ZIP 打包
        </span>
      </div>
    </div>
  );
}
