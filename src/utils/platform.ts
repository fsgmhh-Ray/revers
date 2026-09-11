import type { PlatformType } from '../types/parser';

interface PlatformMeta {
  key: PlatformType;
  label: string;
  short: string;
  badge: string;
  dot: string;
  hosts: string[];
}

export const PLATFORM_META: Record<PlatformType, PlatformMeta> = {
  tiktok: {
    key: 'tiktok',
    label: 'TikTok',
    short: 'TT',
    badge: 'bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/30',
    dot: 'bg-fuchsia-400',
    hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram Reels',
    short: 'IG',
    badge: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
    dot: 'bg-rose-400',
    hosts: ['instagram.com', 'www.instagram.com'],
  },
  youtube: {
    key: 'youtube',
    label: 'YouTube Shorts',
    short: 'YT',
    badge: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
    dot: 'bg-red-400',
    hosts: ['youtube.com', 'youtu.be', 'm.youtube.com'],
  },
  douyin: {
    key: 'douyin',
    label: '抖音',
    short: 'DY',
    badge: 'bg-slate-400/15 text-slate-200 ring-1 ring-slate-400/30',
    dot: 'bg-slate-300',
    hosts: ['douyin.com', 'iesdouyin.com'],
  },
  xiaohongshu: {
    key: 'xiaohongshu',
    label: '小红书',
    short: 'XHS',
    badge: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
    dot: 'bg-amber-400',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
  },
  unknown: {
    key: 'unknown',
    label: '未知平台',
    short: '?',
    badge: 'bg-ink-500/40 text-slate-400 ring-1 ring-ink-400',
    dot: 'bg-slate-500',
    hosts: [],
  },
};

export function detectPlatform(rawUrl: string): PlatformType {
  let url = rawUrl;
  try {
    url = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    url = rawUrl.toLowerCase();
  }

  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/douyin\.com/.test(url)) return 'douyin';
  if (/xiaohongshu\.com|xhslink\.com/.test(url)) return 'xiaohongshu';
  return 'unknown';
}

export function platformMeta(platform: PlatformType): PlatformMeta {
  return PLATFORM_META[platform] ?? PLATFORM_META.unknown;
}

/** 从任意一段粘贴文本中抽取链接（支持中英文混排、换行、逗号分隔） */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>\]\)，,、]+/gi) ?? [];
  const cleaned = matches
    .map((u) => u.replace(/[.,;:!?]+$/, ''))
    .filter((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });
  return Array.from(new Set(cleaned));
}

/** 生成安全的文件名（去掉系统非法字符，限制长度） */
export function sanitizeFilename(name: string, fallback = 'video'): string {
  const cleaned = (name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** 按平台生成默认文件名：{platform}_{author}_{title}.mp4 */
export function buildFilename(meta: {
  platform: PlatformType;
  title: string;
  author?: string;
  id?: string;
}): string {
  const parts = [meta.platform, meta.author, meta.title].filter(Boolean).join('_');
  return `${sanitizeFilename(parts, meta.id || 'video')}.mp4`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
