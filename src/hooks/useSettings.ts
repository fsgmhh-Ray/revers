import { useCallback, useEffect, useState } from 'react';
import type { EnginePreference } from '../services/engineRouter';

export type FilenamePattern = 'platform_author_title' | 'title' | 'id';

export interface Settings {
  parseConcurrency: number;
  downloadConcurrency: number;
  autoDownload: boolean;
  preferZip: boolean;
  filenamePattern: FilenamePattern;
  /** 解析/下载链路的执行引擎，auto 时按 桌面端 > 插件 > 云端 嗅探 */
  engine: EnginePreference;
  /** 桌面端读取哪个浏览器的登录态（chrome / edge / firefox …），auto 由 yt-dlp 自行尝试 */
  cookieBrowser: string;
  /** 桌面端下载目录；空字符串 = 用默认目录（下载/Cineflowing） */
  downloadDir: string;
}

const STORAGE_KEY = 'reverse-cineflowing:settings';

const DEFAULTS: Settings = {
  parseConcurrency: 3,
  downloadConcurrency: 2,
  autoDownload: false,
  preferZip: false,
  filenamePattern: 'platform_author_title',
  engine: 'auto',
  cookieBrowser: 'auto',
  downloadDir: '',
};

function read(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(read);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [settings]);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULTS), []);

  return { settings, update, reset };
}
