import type { TaskItem } from '../types/parser';
import { proxyUrl } from '../utils/downloader';
import { platformMeta } from '../utils/platform';
import { IconClose, IconExternal, IconSparkles } from './Icons';

const PIPELINE = [
  { step: '01', title: '场景切分', desc: 'FFmpeg select=gt(scene,0.3) 提取关键帧并上传 R2' },
  { step: '02', title: '多模态解析', desc: 'Gemini / GPT-4o 原生视频理解，结构化输出分镜 JSON' },
  { step: '03', title: '时间戳对齐', desc: '物理关键帧与语义 JSON 合并为 StoryboardNode[]' },
  { step: '04', title: 'Prompt 逆向', desc: '组装 Flux.1 生图 Prompt 与 Wan2.1 动效 Prompt' },
];

const CONTRACT = `interface StoryboardNode {
  id: string;
  startTime: number;   // 毫秒
  endTime: number;
  thumbnailUrl: string;
  shotType: '特写(CU)' | '近景(MCU)' | '中景(MS)' | ...;
  cameraMovement: '固定(Static)' | '推(Track in)' | ...;
  dialogue: string;
  visualDescription: string;
  aiPrompt: { imagePrompt: string; videoPrompt: string };
}`;

export function StoryboardDrawer({
  task,
  onClose,
  onPush,
}: {
  task: TaskItem | null;
  onClose: () => void;
  onPush: (task: TaskItem) => void;
}) {
  if (!task) return null;
  const meta = platformMeta(task.data?.platform ?? 'unknown');

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[980px] animate-fade-up flex-col border-l border-white/5 bg-ink-800/95 shadow-2xl">
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

        <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[380px_1fr]">
          <div className="border-r border-white/5 bg-black/40 p-4">
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
                解析源：<span className="text-slate-200">{task.data?.provider || '—'}</span>
              </p>
            </div>
          </div>

          <div className="overflow-y-auto p-5">
            <div className="mb-5 rounded-2xl border border-dashed border-white/10 bg-white/[.02] p-6 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand-soft">
                <IconSparkles width={20} height={20} />
              </div>
              <h3 className="mt-3 text-sm font-medium text-slate-100">分镜拆解引擎待接入</h3>
              <p className="mx-auto mt-1.5 max-w-md text-[12px] leading-relaxed text-slate-500">
                本阶段已完成「无水印解析 + 批量下载」。分镜逆向需要 FFmpeg 物理抽帧与多模态大模型算力，
                将作为独立微服务接入，产物结构与下方契约一致。
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <span className="chip bg-white/5 text-slate-400">FFmpeg Scene Detection</span>
                <span className="chip bg-white/5 text-slate-400">Gemini / GPT-4o 多模态</span>
                <span className="chip bg-white/5 text-slate-400">Flux.1 / Wan2.1 Prompt</span>
              </div>
            </div>

            <div className="mb-5 grid gap-2 sm:grid-cols-2">
              {PIPELINE.map((item) => (
                <div key={item.step} className="rounded-xl border border-white/5 bg-white/[.02] p-3">
                  <span className="font-mono text-[10.5px] text-brand-soft">{item.step}</span>
                  <p className="mt-1 text-[12.5px] text-slate-200">{item.title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.desc}</p>
                </div>
              ))}
            </div>

            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">数据契约</h4>
            <pre className="overflow-x-auto rounded-xl border border-white/5 bg-black/50 p-3.5 font-mono text-[11px] leading-relaxed text-slate-400">
              {CONTRACT}
            </pre>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/5 px-5 py-3">
          <button className="btn-ghost !py-2 !text-[12.5px]" onClick={onClose}>
            关闭
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-ghost !py-2 !text-[12.5px]" disabled>
              一键拆解（引擎接入后开放）
            </button>
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
