import { useCallback, useMemo, useRef, useState } from 'react';
import type { ParseResponse, TaskItem } from '../types/parser';
import {
  downloadSingleVideo,
  downloadWithConcurrencyLimit,
  packAndDownloadZip,
  runPool,
  type PoolTask,
} from '../utils/downloader';
import { detectPlatform, extractUrls, sanitizeFilename } from '../utils/platform';
import { uid } from '../utils/id';
import type { Settings } from './useSettings';

export type Notify = (message: string, type?: 'info' | 'success' | 'error') => void;

export function useTaskManager(settings: Settings, notify: Notify = () => {}) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const abortRef = useRef<AbortController | null>(null);

  const updateTask = useCallback((id: string, patch: Partial<TaskItem>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const ensureController = useCallback(() => {
    if (!abortRef.current || abortRef.current.signal.aborted) {
      abortRef.current = new AbortController();
    }
    return abortRef.current;
  }, []);

  const filenameFor = useCallback((task: TaskItem): string => {
    const data = task.data;
    const pattern = settingsRef.current.filenamePattern;
    const base = !data
      ? 'video'
      : pattern === 'title'
        ? data.title
        : pattern === 'id'
          ? data.id
          : [data.platform, data.author?.name, data.title].filter(Boolean).join('_');
    return `${sanitizeFilename(base || 'video', data?.id || 'video')}.mp4`;
  }, []);

  const parseTask = useCallback(
    async (task: TaskItem) => {
      updateTask(task.id, { parseStatus: 'parsing', errorMsg: undefined });
      try {
        const res = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: task.inputUrl }),
          signal: ensureController().signal,
        });
        const payload = (await res.json()) as ParseResponse;
        if (!res.ok || !payload.success || !payload.data) {
          throw new Error(payload.error || `解析失败 (HTTP ${res.status})`);
        }
        updateTask(task.id, { parseStatus: 'success', data: payload.data, errorMsg: undefined });
        return true;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          updateTask(task.id, { parseStatus: 'idle' });
          return false;
        }
        updateTask(task.id, { parseStatus: 'error', errorMsg: err?.message || '解析异常' });
        return false;
      }
    },
    [ensureController, updateTask],
  );

  /** 批量添加链接并触发解析 */
  const addUrls = useCallback(
    async (rawText: string) => {
      const urls = extractUrls(rawText);
      if (!urls.length) {
        notify('没有识别到有效链接', 'error');
        return 0;
      }

      let accepted: TaskItem[] = [];
      setTasks((prev) => {
        const known = new Set(prev.map((t) => t.inputUrl));
        const fresh = urls
          .filter((u) => !known.has(u))
          .map<TaskItem>((inputUrl) => ({
            id: uid(),
            inputUrl,
            parseStatus: 'idle',
            downloadStatus: 'pending',
            progress: 0,
            createdAt: Date.now(),
          }));
        accepted = fresh;
        return fresh.length ? [...prev, ...fresh] : prev;
      });

      if (!accepted.length) {
        notify('这些链接已在队列中', 'info');
        return 0;
      }

      setIsParsing(true);
      let ok = 0;
      await runPool(accepted, settingsRef.current.parseConcurrency, async (task) => {
        const done = await parseTask(task);
        if (done) ok += 1;
      });
      setIsParsing(false);
      notify(`解析完成：成功 ${ok} / ${accepted.length}`, ok ? 'success' : 'error');
      return ok;
    },
    [notify, parseTask],
  );

  const retryParse = useCallback(
    async (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      setIsParsing(true);
      await parseTask(task);
      setIsParsing(false);
    },
    [parseTask, tasks],
  );

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    abortRef.current?.abort();
    setTasks([]);
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((t) => !(t.downloadStatus === 'completed' && t.progress === 100)));
  }, []);

  const downloadOne = useCallback(
    async (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task?.data?.downloadUrl) return;
      updateTask(id, { downloadStatus: 'downloading', progress: 0 });
      try {
        await downloadSingleVideo(task.data.downloadUrl, filenameFor(task), {
          onProgress: (percent) => updateTask(id, { progress: percent }),
          signal: ensureController().signal,
        });
        updateTask(id, { downloadStatus: 'completed', progress: 100 });
      } catch (err: any) {
        updateTask(id, { downloadStatus: 'failed', errorMsg: err?.message || '下载失败' });
        notify(`${task.data.title || '视频'} 下载失败`, 'error');
      }
    },
    [ensureController, filenameFor, notify, tasks, updateTask],
  );

  const downloadable = useMemo(
    () => tasks.filter((t) => t.parseStatus === 'success' && t.data?.downloadUrl),
    [tasks],
  );

  /** 批量下载：可选 ZIP 打包（推荐，规避浏览器多文件下载拦截） */
  const downloadAll = useCallback(async () => {
    const queue = tasks.filter(
      (t) => t.parseStatus === 'success' && t.data?.downloadUrl && t.downloadStatus !== 'completed',
    );
    if (!queue.length) {
      notify('没有可下载的视频', 'info');
      return;
    }

    setIsDownloading(true);
    const controller = ensureController();
    const pool: PoolTask[] = queue.map((t) => ({ url: t.data!.downloadUrl, filename: filenameFor(t) }));
    queue.forEach((t) => updateTask(t.id, { downloadStatus: 'downloading', progress: 0 }));

    try {
      if (settingsRef.current.preferZip && pool.length > 1) {
        await packAndDownloadZip(
          pool,
          `cineflowing_${new Date().toISOString().slice(0, 10)}.zip`,
          (done, total, itemProgress) => {
            const index = Math.min(done, queue.length - 1);
            updateTask(queue[index].id, { progress: itemProgress });
            if (itemProgress >= 100 && done < total) updateTask(queue[index].id, { downloadStatus: 'completed', progress: 100 });
            if (done >= total && itemProgress >= 100) updateTask(queue[queue.length - 1].id, { downloadStatus: 'completed', progress: 100 });
          },
          controller.signal,
        );
      } else {
        const results = await downloadWithConcurrencyLimit(
          pool,
          settingsRef.current.downloadConcurrency,
          (index, progress) => {
            updateTask(queue[index].id, { progress });
            if (progress >= 100) updateTask(queue[index].id, { downloadStatus: 'completed' });
          },
          controller.signal,
        );
        queue.forEach((t, i) => {
          if (!results[i]) updateTask(t.id, { downloadStatus: 'failed', errorMsg: '下载失败，可重试或改用 ZIP 打包' });
        });
      }
      notify('批量下载已触发', 'success');
    } catch (err: any) {
      notify(err?.message || '批量下载失败', 'error');
    } finally {
      setIsDownloading(false);
    }
  }, [ensureController, filenameFor, notify, tasks, updateTask]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsParsing(false);
    setIsDownloading(false);
    notify('已取消当前进行中的任务', 'info');
  }, [notify]);

  const stats = useMemo(() => {
    const parsed = tasks.filter((t) => t.parseStatus === 'success').length;
    const parseFailed = tasks.filter((t) => t.parseStatus === 'error').length;
    const downloaded = tasks.filter((t) => t.downloadStatus === 'completed').length;
    const platforms = tasks.reduce<Record<string, number>>((acc, t) => {
      const key = detectPlatform(t.inputUrl);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return { total: tasks.length, parsed, parseFailed, downloaded, platforms };
  }, [tasks]);

  return {
    tasks,
    stats,
    isParsing,
    isDownloading,
    downloadable,
    addUrls,
    retryParse,
    removeTask,
    clearAll,
    clearFinished,
    downloadOne,
    downloadAll,
    cancel,
  };
}
