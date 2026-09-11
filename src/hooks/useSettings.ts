import { useCallback, useEffect, useState } from 'react';

export type FilenamePattern = 'platform_author_title' | 'title' | 'id';

export interface Settings {
  parseConcurrency: number;
  downloadConcurrency: number;
  autoDownload: boolean;
  preferZip: boolean;
  filenamePattern: FilenamePattern;
}

const STORAGE_KEY = 'reverse-cineflowing:settings';

const DEFAULTS: Settings = {
  parseConcurrency: 3,
  downloadConcurrency: 2,
  autoDownload: false,
  preferZip: false,
  filenamePattern: 'platform_author_title',
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
