export type ShotType = '特写(CU)' | '近景(MCU)' | '中景(MS)' | '全景(WS)' | '远景(LS)' | '极远景(ELS)';
export type CameraMovement =
  | '固定(Static)'
  | '推(Track in)'
  | '拉(Track out)'
  | '摇(Pan/Tilt)'
  | '移(Truck)'
  | '跟(Follow)';

export interface StoryboardNode {
  id: string;
  /** 毫秒 */
  startTime: number;
  /** 毫秒 */
  endTime: number;
  /** 关键帧图像（R2 链接） */
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
}

export interface VideoAnalysisResult {
  videoId: string;
  /** 整体视觉风格，如 Cinematic, 8k, cyberpunk */
  globalStyle: string;
  storyboards: StoryboardNode[];
}

export type AnalysisStatus = 'idle' | 'extracting' | 'analyzing' | 'success' | 'error';
