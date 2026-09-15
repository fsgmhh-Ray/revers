/**
 * Stage 2 分镜逆向的数据契约。
 *
 * 与桌面端 desktop/ipc.js 的 buildStoryboard() 返回值一一对应；
 * 同时也是「推送到主站」时导入包的载荷结构。
 */

export type ShotType = '特写(CU)' | '近景(MCU)' | '中景(MS)' | '全景(WS)' | '远景(LS)' | '极远景(ELS)';
export type CameraMovement =
  | '快切(Cut)'
  | '固定(Static)'
  | '推(Track in)'
  | '拉(Track out)'
  | '摇(Pan/Tilt)'
  | '移(Truck)'
  | '跟(Follow)';

export interface StoryboardNode {
  id: string;
  /** 第几个镜头，从 1 开始 */
  index?: number;
  /** 毫秒 */
  startTime: number;
  /** 毫秒 */
  endTime: number;
  /** 毫秒；等于 endTime - startTime */
  duration?: number;
  /**
   * 关键帧图像。桌面端抽帧后就地转成 data URL 回传，
   * 免去「本地文件路径无法被远程页面直接引用」的问题；
   * 云端链路则是 R2 链接。
   */
  thumbnailUrl: string;
  shotType: ShotType;
  cameraMovement: CameraMovement;
  /** 该镜头内的台词 */
  dialogue: string;
  /** 画面内容描述（中文） */
  visualDescription: string;
  aiPrompt: {
    /** 适配 Flux.1 的生图 Prompt */
    imagePrompt: string;
    /** 适配 Wan2.1 / Hunyuan 的动效 Prompt */
    videoPrompt: string;
  };
  /** true = 镜头类型由剪辑时长推断，尚未经多模态模型确认 */
  inferred?: boolean;
}

export interface VideoAnalysisResult {
  videoId: string;
  /** 整体视觉风格，如 Cinematic, 8k, cyberpunk */
  globalStyle: string;
  storyboards: StoryboardNode[];
}

export type AnalysisStatus = 'idle' | 'extracting' | 'analyzing' | 'success' | 'error';

/* ------------------------------------------------------------------ */
/* 本地分镜管线（桌面端 FFmpeg）                                        */
/* ------------------------------------------------------------------ */

export interface StoryboardSource {
  /** 本地视频绝对路径 */
  file: string;
  /** 毫秒 */
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface StoryboardStats {
  sceneCount: number;
  sceneThreshold: number;
  /** 毫秒 */
  avgShotDuration: number;
  cutRhythm: string;
  /** local-ffmpeg | vision */
  analyzedBy: string;
  note: string;
}

export interface StoryboardResult {
  ok: boolean;
  id?: string;
  error?: string;
  source?: StoryboardSource;
  nodes?: StoryboardNode[];
  stats?: StoryboardStats;
}

export interface StoryboardProgress {
  id: string;
  percent: number;
  stage: string;
}

export interface StoryboardOptions {
  /** 场景切换灵敏度，越大切得越少。默认 0.3 */
  sceneThreshold?: number;
  /** 最多输出多少个镜头，超出会等间隔抽稀。默认 48 */
  maxShots?: number;
  /** 关键帧宽度，默认 480 */
  frameWidth?: number;
}
