/** 经边缘网关中转的下载直链（解决 CDN 跨域 / Referer 校验导致的下载被拒） */
export function proxyUrl(url: string, inline = false): string {
  const base = `/api/proxy-download?url=${encodeURIComponent(url)}`;
  return inline ? `${base}&inline=1` : base;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export interface DownloadOptions {
  onProgress?: (percent: number, received: number, total: number) => void;
  signal?: AbortSignal;
  /** 返回 blob，供 ZIP 打包复用（true 时不触发浏览器保存） */
  returnBlob?: boolean;
}

export interface DownloadResult {
  blob: Blob;
  size: number;
  contentType: string;
}

/** 单任务带进度的 Blob 下载（通过边缘代理绕过 CDN 的 CORS / Referer 限制） */
export async function downloadSingleVideo(
  url: string,
  filename: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { onProgress, signal, returnBlob = false } = options;
  const res = await fetch(proxyUrl(url), { signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`下载失败 (HTTP ${res.status}) ${detail.slice(0, 120)}`);
  }

  const contentLength = Number(res.headers.get('content-length')) || 0;
  const contentType = res.headers.get('content-type') || 'video/mp4';
  const reader = res.body?.getReader();

  let blob: Blob;
  if (!reader) {
    blob = await res.blob();
  } else {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReport = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress && contentLength) {
        const percent = Math.min(99, Math.round((received / contentLength) * 100));
        if (percent !== lastReport) {
          lastReport = percent;
          onProgress(percent, received, contentLength);
        }
      }
    }
    blob = new Blob(chunks as BlobPart[], { type: contentType });
  }

  onProgress?.(100, blob.size, contentLength || blob.size);

  if (!returnBlob) {
    triggerBlobDownload(blob, filename.endsWith('.mp4') ? filename : `${filename}.mp4`);
  }
  return { blob, size: blob.size, contentType };
}

export interface PoolTask {
  url: string;
  filename: string;
}

/**
 * 限制最大并发数的批量下载器
 * @returns 每个任务是否成功
 */
export async function downloadWithConcurrencyLimit(
  tasks: PoolTask[],
  concurrency = 2,
  onProgress: (index: number, progress: number) => void,
  signal?: AbortSignal,
): Promise<boolean[]> {
  const results: boolean[] = new Array(tasks.length).fill(false);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      if (signal?.aborted) return;
      const index = cursor++;
      const task = tasks[index];
      try {
        await downloadSingleVideo(task.url, task.filename, {
          onProgress: (percent) => onProgress(index, percent),
          signal,
        });
        results[index] = true;
      } catch (err) {
        console.error(`[downloader] ${task.filename} failed`, err);
        results[index] = false;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** 通用并发池：把 items 交给 worker 处理，最多同时跑 limit 个 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/** 打包为 ZIP 后一次性下载（浏览器对多文件连续下载有限制，批量场景更稳） */
export async function packAndDownloadZip(
  tasks: PoolTask[],
  zipName = 'cineflowing-batch.zip',
  onProgress?: (done: number, total: number, itemProgress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folder = zip.folder('cineflowing') ?? zip;
  let done = 0;

  for (const task of tasks) {
    if (signal?.aborted) break;
    try {
      const { blob } = await downloadSingleVideo(task.url, task.filename, {
        returnBlob: true,
        signal,
        onProgress: (percent) => onProgress?.(done, tasks.length, percent),
      });
      folder.file(task.filename, blob);
    } catch (err) {
      console.error(`[zip] skip ${task.filename}`, err);
    } finally {
      done += 1;
      onProgress?.(done, tasks.length, 100);
    }
  }

  const output = await zip.generateAsync({ type: 'blob' }, (meta) => onProgress?.(done, tasks.length, meta.percent));
  triggerBlobDownload(output, zipName);
}
