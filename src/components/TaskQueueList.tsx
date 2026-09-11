import type { TaskItem } from '../types/parser';
import { VideoPreviewCard } from './VideoPreviewCard';
import { IconFilm } from './Icons';

interface Props {
  tasks: TaskItem[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onDownload: (id: string) => void;
  onStoryboard: (task: TaskItem) => void;
}

export function TaskQueueList({ tasks, onRetry, onRemove, onDownload, onStoryboard }: Props) {
  if (!tasks.length) {
    return (
      <div className="panel grid place-items-center px-6 py-20 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white/[.04] ring-1 ring-white/10">
          <IconFilm width={22} height={22} className="text-slate-500" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-slate-200">队列是空的</h3>
        <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-slate-500">
          粘贴 TikTok / Instagram Reels / YouTube Shorts 链接开始解析。
          <br />
          解析成功后可单条下载、批量并发下载，或打包为 ZIP 一次带走。
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tasks.map((task) => (
        <VideoPreviewCard
          key={task.id}
          task={task}
          onRetry={onRetry}
          onRemove={onRemove}
          onDownload={onDownload}
          onStoryboard={onStoryboard}
        />
      ))}
    </div>
  );
}
