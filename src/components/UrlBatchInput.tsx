import { useMemo, useState } from 'react';
import { detectPlatform, extractUrls, platformMeta } from '../utils/platform';
import type { PlatformType } from '../types/parser';
import { IconLink, IconSparkles, IconTrash } from './Icons';

const SAMPLES = [
  'https://www.tiktok.com/@tiktok/video/7106594312292453675',
  'https://www.instagram.com/reel/CxXXXXXxxXX/',
  'https://www.youtube.com/shorts/abcdefghijk',
];

export function UrlBatchInput({
  onSubmit,
  isParsing,
  engineLabel,
}: {
  onSubmit: (text: string) => void;
  isParsing: boolean;
  /** 当前执行引擎的中文名，让用户知道这批链接由谁处理 */
  engineLabel?: string;
}) {
  const [text, setText] = useState('');

  const urls = useMemo(() => extractUrls(text), [text]);
  const grouped = useMemo(() => {
    const map = new Map<PlatformType, number>();
    urls.forEach((u) => {
      const key = detectPlatform(u);
      map.set(key, (map.get(key) || 0) + 1);
    });
    return Array.from(map.entries());
  }, [urls]);

  const submit = () => {
    if (!urls.length || isParsing) return;
    onSubmit(text);
    setText('');
  };

  return (
    <section className="panel p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <IconLink width={16} height={16} className="text-brand-soft" />
          <h2 className="text-sm font-semibold text-white">批量粘贴链接</h2>
          <span className="text-[11px] text-slate-500">支持 TikTok / Instagram Reels / YouTube Shorts / 抖音 / 小红书</span>
        </div>
        <button
          className="text-[11px] text-slate-500 hover:text-brand-soft"
          onClick={() => setText(SAMPLES.join('\n'))}
        >
          填充示例
        </button>
      </div>

      <textarea
        className="field min-h-[132px] resize-y font-mono text-[12.5px] leading-relaxed"
        placeholder={'每行一个链接，也支持整段文本自动抽取：\nhttps://www.tiktok.com/@user/video/1234567890\nhttps://www.instagram.com/reel/xxxxx/\nhttps://www.youtube.com/shorts/xxxxx'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
        }}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {grouped.length > 0 ? (
          grouped.map(([platform, count]) => {
            const meta = platformMeta(platform);
            return (
              <span key={platform} className={`chip ${meta.badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                {meta.label} × {count}
              </span>
            );
          })
        ) : (
          <span className="text-[11.5px] text-slate-500">识别到 0 个链接</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {text && (
            <button className="btn-ghost" onClick={() => setText('')}>
              <IconTrash width={14} height={14} />
              清空
            </button>
          )}
          <button className="btn-primary" onClick={submit} disabled={!urls.length || isParsing}>
            <IconSparkles width={15} height={15} />
            {isParsing ? '解析中…' : `解析 ${urls.length || ''} 个链接`}
          </button>
        </div>
      </div>

      <p className="mt-2.5 text-[11px] text-slate-600">
        快捷键 Ctrl / ⌘ + Enter 立即解析
        {engineLabel ? ` · 当前由「${engineLabel}」发出请求` : null}
      </p>
    </section>
  );
}
