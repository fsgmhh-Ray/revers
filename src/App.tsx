import { useCallback, useEffect, useState } from 'react';
import { Header, type GatewayHealth } from './components/Header';
import { UrlBatchInput } from './components/UrlBatchInput';
import { Toolbar } from './components/Toolbar';
import { TaskQueueList } from './components/TaskQueueList';
import { SettingsPanel } from './components/SettingsPanel';
import { StoryboardDrawer } from './components/StoryboardDrawer';
import { Toaster, useToasts } from './components/Toaster';
import { EnginePromo } from './components/EngineBadge';
import { ClientFeed } from './components/ClientFeed';
import { useEngine } from './hooks/useEngine';
import { useSettings } from './hooks/useSettings';
import { useTaskManager } from './hooks/useTaskManager';
import type { TaskItem } from './types/parser';

const MAIN_SITE_IMPORT = 'https://www.cineflowing.com/import';

export default function App() {
  const { settings, update, reset } = useSettings();
  const { toasts, push, remove } = useToasts();
  const engineState = useEngine(settings.engine);
  const {
    tasks,
    isParsing,
    isDownloading,
    addUrls,
    retryParse,
    removeTask,
    clearAll,
    clearFinished,
    downloadOne,
    downloadAll,
    cancel,
  } = useTaskManager(settings, push, engineState);

  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/parse?probe=1')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => alive && setHealth(data as GatewayHealth))
      .catch(() => alive && setHealth({ ok: false }));
    return () => {
      alive = false;
    };
  }, []);

  const handlePush = useCallback(
    (task: TaskItem) => {
      const payload = {
        source: 'reverse.cineflowing.com',
        exportedAt: new Date().toISOString(),
        video: task.data,
      };
      navigator.clipboard
        ?.writeText(JSON.stringify(payload, null, 2))
        .then(() => push('导入包已复制，正在跳转主站…', 'success'))
        .catch(() => push('复制失败，请手动复制直链', 'error'));
      window.open(MAIN_SITE_IMPORT, '_blank', 'noopener');
    },
    [push],
  );

  return (
    <div className="min-h-full">
      <Header health={health} engine={engineState} onOpenSettings={() => setSettingsOpen(true)} />

      <main className="mx-auto max-w-[1400px] space-y-4 px-5 py-5">
        <ClientFeed />
        <EnginePromo state={engineState} />

        <UrlBatchInput
          onSubmit={(text) => void addUrls(text)}
          isParsing={isParsing}
          engineLabel={engineState.activeLabel}
        />

        <Toolbar
          tasks={tasks}
          isParsing={isParsing}
          isDownloading={isDownloading}
          onDownloadAll={() => void downloadAll()}
          onCancel={cancel}
          onClearAll={clearAll}
          onClearFinished={clearFinished}
        />

        <TaskQueueList
          tasks={tasks}
          onRetry={(id) => void retryParse(id)}
          onRemove={removeTask}
          onDownload={(id) => void downloadOne(id)}
          onStoryboard={setActiveTask}
        />

        <footer className="grid gap-3 pt-2 sm:grid-cols-3">
          {[
            { t: '① 粘贴链接', d: '自动识别平台并批量入队，支持整段文本抽取' },
            { t: '② 无水印解析', d: '自建 Cobalt / yt-dlp 内核优先，TikTok 走公共源兜底' },
            { t: '③ 下载 / 拆解', d: '并发下载或 ZIP 打包，随后可逆向出分镜剧本与 AI Prompt' },
          ].map((item) => (
            <div key={item.t} className="rounded-xl border border-white/5 bg-white/[.02] px-3.5 py-3">
              <p className="text-[12.5px] font-medium text-slate-200">{item.t}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.d}</p>
            </div>
          ))}
        </footer>
      </main>

        <SettingsPanel
          open={settingsOpen}
          settings={settings}
          health={health}
          engine={engineState}
          onClose={() => setSettingsOpen(false)}
          onChange={update}
          onReset={reset}
        />

      <StoryboardDrawer task={activeTask} onClose={() => setActiveTask(null)} onPush={handlePush} />
      <Toaster toasts={toasts} onRemove={remove} />
    </div>
  );
}
