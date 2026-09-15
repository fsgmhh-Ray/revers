import type { StoryboardNode, StoryboardStats } from '../types/storyboard';

/** 毫秒 → mm:ss.S */
export function timecode(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 毫秒 → 2.4s 这种短格式，用于镜头时长 */
export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/**
 * 导出为 Markdown 分镜表。
 * 结构是「按镜头分节 + 表格总览」，既能直接给人读，也方便丢给下游 AI。
 */
export function toMarkdown(
  nodes: StoryboardNode[],
  meta: { title?: string; stats?: StoryboardStats },
): string {
  const head = [
    `# 分镜脚本 · ${meta.title || '未命名'}`,
    '',
    meta.stats
      ? `> 镜头数 **${meta.stats.sceneCount}** · 平均镜头 **${seconds(meta.stats.avgShotDuration)}** · 节奏 **${meta.stats.cutRhythm}** · 分析方式 \`${meta.stats.analyzedBy}\``
      : '',
    '',
    '| # | 起止 | 时长 | 景别 | 运镜 | 画面 | 台词 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const rows = nodes.map((n) =>
    [
      n.index ?? '',
      `${timecode(n.startTime)}–${timecode(n.endTime)}`,
      seconds(n.duration ?? n.endTime - n.startTime),
      n.shotType,
      n.cameraMovement,
      (n.visualDescription || '—').replace(/\|/g, '/'),
      (n.dialogue || '—').replace(/\|/g, '/'),
    ].join(' | '),
  );

  const details = nodes
    .map((n) => {
      const lines = [
        '',
        `## 镜头 ${n.index ?? ''} · ${timecode(n.startTime)}–${timecode(n.endTime)}`,
        '',
        `- 景别：${n.shotType}`,
        `- 运镜：${n.cameraMovement}`,
        `- 时长：${seconds(n.duration ?? n.endTime - n.startTime)}`,
        `- 画面：${n.visualDescription || '（待补全）'}`,
        `- 台词：${n.dialogue || '（无）'}`,
      ];
      if (n.aiPrompt?.imagePrompt) lines.push(`- Flux.1 Prompt：\`${n.aiPrompt.imagePrompt}\``);
      if (n.aiPrompt?.videoPrompt) lines.push(`- Wan2.1 Prompt：\`${n.aiPrompt.videoPrompt}\``);
      return lines.join('\n');
    })
    .join('\n');

  return [...head, ...rows, details, '', '---', '由 reverse.cineflowing.com 逆向生成'].join('\n');
}

/** 导出为 CSV（Excel 直接可开，带 BOM 防中文乱码） */
export function toCsv(nodes: StoryboardNode[]): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['序号', '开始', '结束', '时长(秒)', '景别', '运镜', '画面描述', '台词', 'Flux Prompt', 'Wan Prompt'];
  const rows = nodes.map((n) =>
    [
      n.index ?? '',
      timecode(n.startTime),
      timecode(n.endTime),
      ((n.duration ?? n.endTime - n.startTime) / 1000).toFixed(1),
      n.shotType,
      n.cameraMovement,
      n.visualDescription,
      n.dialogue,
      n.aiPrompt?.imagePrompt ?? '',
      n.aiPrompt?.videoPrompt ?? '',
    ]
      .map(esc)
      .join(','),
  );
  return '\uFEFF' + [header.map(esc).join(','), ...rows].join('\r\n');
}

/** 触发浏览器下载一段文本 */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** 生成一个安全的文件名片段 */
export function safeName(input: string): string {
  return (input || 'storyboard')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}
