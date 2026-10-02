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
  /**
   * 桌面端显式导入的 cookies.txt 路径（Netscape 格式）；空字符串 = 不导入。
   *
   * 为什么需要它：Chrome 127+ 启用 App-Bound 加密后，--cookies-from-browser
   * 在 Windows 上基本失效（数据库被锁 + 密文解不开），导入文件是唯一稳定通道。
   * 优先级高于 cookieBrowser。
   */
  cookieFile: string;
  /** 桌面端下载目录；空字符串 = 用默认目录（下载/Cineflowing） */
  downloadDir: string;
  /** 视觉 LLM（分镜反推）：多模态/视频模型，如 agnes。OpenAI 兼容，BYOK，密钥不落第三方 */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** 文本 LLM（旁白转写）：纯文本/音频转写模型，如 Groq。留空则复用视觉 LLM 配置 */
  llmTextBaseUrl: string;
  llmTextApiKey: string;
  llmTextModel: string;
  /** 转写语言（留空=自动），如 zh / en */
  llmLanguage: string;
}

/**
 * 旁白转写（ASR）默认走 Groq whisper-large-v3（OpenAI 兼容 REST，免费、无需自建）。
 * 已实测端到端跑通：下载 → ffmpeg 抽音轨 → POST /v1/audio/transcriptions → 返回文本。
 * 视觉 LLM（分镜反推）复用 NVIDIA llama-3.2-90b-vision；两者 key 各自 BYOK，不落盘第三方。
 * 注意：这里只预填非敏感的 base URL + model，API Key 必须由用户自己填（避免烤进前端 bundle）。
 */
const NARRATION_DEFAULT_BASE = 'https://api.groq.com/openai/v1';
const NARRATION_DEFAULT_MODEL = 'whisper-large-v3';

const STORAGE_KEY = 'reverse-cineflowing:settings';

const DEFAULTS: Settings = {
  parseConcurrency: 3,
  downloadConcurrency: 2,
  autoDownload: false,
  preferZip: false,
  filenamePattern: 'platform_author_title',
  engine: 'auto',
  cookieBrowser: 'auto',
  cookieFile: '',
  downloadDir: '',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmTextBaseUrl: NARRATION_DEFAULT_BASE,
  llmTextApiKey: '',
  llmTextModel: NARRATION_DEFAULT_MODEL,
  llmLanguage: '',
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
