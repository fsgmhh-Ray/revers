export type PlatformType = 'tiktok' | 'instagram' | 'youtube' | 'douyin' | 'xiaohongshu' | 'unknown';

export interface VideoMetadata {
  id: string;
  originalUrl: string;
  platform: PlatformType;
  title: string;
  author: {
    name: string;
    avatar?: string;
  };
  /** 单位：秒 */
  duration: number;
  coverUrl: string;
  /** 高清无水印直链 */
  downloadUrl: string;
  fallbackUrls?: string[];
  dimensions?: {
    width: number;
    height: number;
  };
  hasWatermark: boolean;
  /** 解析来源，便于排查链路 */
  provider?: string;
  /** 直链有效期（部分 CDN 直链带签名，会过期） */
  expiresAt?: number;
  fileSize?: number;
}

export type ParseStatus = 'idle' | 'parsing' | 'success' | 'error';
export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'failed';

export interface TaskItem {
  id: string;
  inputUrl: string;
  parseStatus: ParseStatus;
  downloadStatus: DownloadStatus;
  /** 0 - 100 */
  progress: number;
  data?: VideoMetadata;
  errorMsg?: string;
  createdAt: number;
  /**
   * 桌面端下载完成后的本地绝对路径。
   * 有了它才能「打开所在文件夹」和「本地分镜拆解」（两者都需要真实文件）。
   */
  savedPath?: string;
}

export interface ParseResponse {
  success: boolean;
  data?: VideoMetadata;
  error?: string;
}
