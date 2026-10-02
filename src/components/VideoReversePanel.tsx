import { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { cloudNarration, cloudStoryboard, type LlmCfg } from '../services/cloudBridge';
import { getElectronAPI, localNarration } from '../services/electronBridge';
import { detectPlatform } from '../utils/platform';
import { downloadText, safeName, seconds, timecode, toCsv, toMarkdown } from '../utils/storyboard';
import { IconSparkles } from './Icons';

type Phase = 'idle' | 'analyzing' | 'success' | 'error';

/**
 * 视频反推提示词 —— 主页独立入口。
 *
 * 与 StoryboardDrawer 的区别：这里**不依赖桌面端、也不需要先解析/下载**，
 * 贴任意视频链接即可由云端内核（Oracle parser-core）完成
 * 下载 → FFmpeg 抽帧 → 多模态 LLM 反推分镜提示词 / 音轨转写。
 *
 * LLM 走 BYOK（OpenAI 兼容），配置与设置面板共用同一份 localStorage。
 */
export function VideoReversePanel() {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(true);
  const [showCfg, setShowCfg] = useState(false);
  const [url, setUrl] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const [narrPhase, setNarrPhase] = useState<Phase>('idle');
  const [narration, setNarration] = useState('');
  const [narrError, setNarrError] = useState('');

  /** 桌面端本地全流程：已下载到本机的视频路径 */
  const [localPath, setLocalPath] = useState('');
  const [localPhase, setLocalPhase] = useState<Phase>('idle');
  const [localError, setLocalError] = useState('');
  const [localStage, setLocalStage] = useState('');

  const api = getElectronAPI();
  const desktopReady = Boolean(api);

  const llm: LlmCfg = {
    llmBaseUrl: settings.llmBaseUrl,
    llmApiKey: settings.llmApiKey,
    llmModel: settings.llmModel,
    llmTextBaseUrl: settings.llmTextBaseUrl,
    llmTextApiKey: settings.llmTextApiKey,
    llmTextModel: settings.llmTextModel,
    llmLanguage: settings.llmLanguage,
  };
  // 分镜反推需要「视觉 LLM」；旁白转写需要「文本 LLM」（未填则复用视觉）
  const visionReady = Boolean(settings.llmBaseUrl && settings.llmModel);
  const textReady = Boolean((settings.llmTextBaseUrl && settings.llmTextModel) || visionReady);
  const busy = phase === 'analyzing' || narrPhase === 'analyzing' || localPhase === 'analyzing';

  // 桌面端：订阅主进程抽帧/转写进度
  useEffect(() => {
    if (!api) return;
    return api.onStoryboardProgress((event) => {
      setLocalStage(event.stage || '');
    });
  }, [api]);

  /**
   * 桌面端本地全流程：解析 → 下载到本机 → 本地分镜 → 本地完整旁白。
   *
   * 全部走本机 IP，绕开 Pages 墙钟与机房 IP 风控（YouTube bot check 的根治解法）。
   */
  const runLocalAll = async () => {
    if (!api) return;
    if (!url.trim()) {
      setLocalError('请先粘贴视频链接');
      setLocalPhase('error');
      return;
    }
    setLocalPhase('analyzing');
    setLocalError('');
    setLocalStage('解析视频信息');
    try {
      const platform = detectPlatform(url.trim());
      const parsed = await api.parse({ url: url.trim(), platform });
      if (!parsed.ok) throw new Error(parsed.error || '解析失败');

      setLocalStage('下载到本机');
      const fileName = `${safeName(parsed.data.title || 'video')}.mp4`;
      const dl = await api.download({
        id: `rev_${Date.now()}`,
        url: url.trim(),
        platform,
        filename: fileName,
        sourceUrl: parsed.data.originalUrl,
      });
      if (!dl.ok || !dl.path) throw new Error(dl.error || '下载失败，未拿到本地文件');

      setLocalPath(dl.path);
      setLocalStage('本地抽帧拆解分镜');
      const sb = await api.storyboard({
        id: `sb_${Date.now()}`,
        path: dl.path,
        maxShots: 48,
        frameWidth: 480,
        llmBaseUrl: settings.llmBaseUrl,
        llmApiKey: settings.llmApiKey,
        llmModel: settings.llmModel,
        language: settings.llmLanguage,
      });
      if (!sb || !sb.ok) throw new Error((sb as any)?.error || '本地分镜拆解失败');
      setResult(sb);
      setPhase('success');

      // 旁白：同一份本地文件，本地 ffmpeg 抽音轨后送 ASR
      if (textReady) {
        setNarrPhase('analyzing');
        setLocalStage('本地转写旁白');
        try {
          const local = await localNarration(dl.path, llm, `nr_${Date.now()}`);
          if (local?.transcript) {
            setNarration(local.transcript);
            setNarrPhase('success');
          } else {
            setNarrError('旁白转写返回为空（该视频可能无人声）');
            setNarrPhase('error');
          }
        } catch (err) {
          setNarrError(err instanceof Error ? err.message : '本地旁白转写失败');
          setNarrPhase('error');
        }
      }
      setLocalPhase('success');
    } catch (err) {
      setLocalPhase('error');
      setLocalError(err instanceof Error ? err.message : '本地全流程失败');
    }
  };

  const reverse = async () => {
    if (!url.trim()) {
      setError('请先粘贴视频链接');
      setPhase('error');
      return;
    }
    if (!visionReady) {
      setError('请先展开「LLM 配置」填写视觉 LLM（分镜反推，可接 agnes / NVIDIA NIM / Groq / OpenAI 等）');
      setPhase('error');
      setShowCfg(true);
      return;
    }
    setPhase('analyzing');
    setError('');
    try {
      // 桌面端：走本机 IP（解析→下载→本地分镜），避免云端内核的机房 IP 风控
      // 与 Pages 墙钟限制。云端内核对 YouTube 会直接返回 bot check。
      if (desktopReady) {
        setLocalStage('解析并下载到本机');
        const platform = detectPlatform(url.trim());
        const parsed = await api!.parse({ url: url.trim(), platform });
        if (!parsed.ok) throw new Error(parsed.error || '解析失败');
        const fileName = `${safeName(parsed.data.title || 'video')}.mp4`;
        const dl = await api!.download({
          id: `rev_${Date.now()}`,
          url: url.trim(),
          platform,
          filename: fileName,
          sourceUrl: parsed.data.originalUrl,
        });
        if (!dl.ok || !dl.path) throw new Error(dl.error || '下载失败，未拿到本地文件');
        setLocalPath(dl.path);
        setLocalStage('本地抽帧拆解分镜');
        const sb = await api!.storyboard({
        id: `sb_${Date.now()}`,
        path: dl.path,
        maxShots: 24,
        frameWidth: 480,
        llmBaseUrl: settings.llmBaseUrl,
        llmApiKey: settings.llmApiKey,
        llmModel: settings.llmModel,
        language: settings.llmLanguage,
      });
        if (!sb || !sb.ok) throw new Error((sb as any)?.error || '本地分镜拆解失败');
        setResult(sb);
        setPhase('success');
        return;
      }
      const data = await cloudStoryboard(url.trim(), llm, { maxShots: 24, frameWidth: 480 });
      if (data?.status === 'error') {
        setPhase('error');
        setError(data.text || '内核返回错误');
        return;
      }
      setResult(data);
      setPhase('success');
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : '反推失败');
    }
  };

  const narrate = async () => {
    if (!url.trim()) {
      setNarrError('请先粘贴视频链接');
      setNarrPhase('error');
      return;
    }
    if (!textReady) {
      setNarrError('请先填写文本 LLM（旁白转写，如 Groq whisper-large-v3）；不填则复用视觉 LLM 配置');
      setNarrPhase('error');
      setShowCfg(true);
      return;
    }
    setNarrPhase('analyzing');
    setNarrError('');
    try {
      // 桌面端且已下载到本机 → 本地转写（本机 IP，不受 Pages 墙钟 / 机房风控影响）
      if (desktopReady && localPath) {
        const local = await localNarration(localPath, llm, `nr_${Date.now()}`);
        if (local?.transcript) {
          setNarration(local.transcript);
          setNarrPhase('success');
          return;
        }
      }
      const data = await cloudNarration(url.trim(), llm);
      if (data?.status === 'error') {
        setNarrPhase('error');
        setNarrError(data.text || '转写失败');
        return;
      }
      setNarration(data?.transcript || '');
      setNarrPhase('success');
    } catch (err) {
      setNarrPhase('error');
      setNarrError(err instanceof Error ? err.message : '转写失败');
    }
  };

  const nodes = result?.nodes ?? [];
  const baseName = safeName('reverse');
  const exportMd = () => downloadText(`${baseName}_分镜.md`, toMarkdown(nodes, { stats: result?.stats }), 'text/markdown;charset=utf-8');
  const exportCsv = () => downloadText(`${baseName}_分镜.csv`, toCsv(nodes), 'text/csv;charset=utf-8');
  const exportJson = () =>
    downloadText(`${baseName}_分镜.json`, JSON.stringify(result, null, 2), 'application/json');

  return (
    <section className="overflow-hidden rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/[.07] to-transparent">
      <button
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/20 text-brand-soft">
          <IconSparkles width={15} height={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-white">视频反推提示词 · 独立入口</span>
          <span className="block truncate text-[11px] text-slate-400">
            贴任意视频链接 → 云端内核抽帧 → 多模态 LLM 反推分镜提示词 / 完整旁白（无需安装、无需先解析）
          </span>
        </span>
        <span className="chip brand-tonal shrink-0 text-[10.5px]">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/5 px-4 py-3.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-[12.5px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-brand"
              placeholder="粘贴视频链接（TikTok / YouTube Shorts / Instagram Reels / 抖音 / 小红书…）"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn-primary shrink-0 !py-2.5 !text-[12.5px]" onClick={() => void reverse()} disabled={busy}>
              <IconSparkles width={14} height={14} />
              {phase === 'analyzing' ? '反推中…' : '反推分镜提示词'}
            </button>
            <button className="btn-ghost shrink-0 !py-2.5 !text-[12.5px]" onClick={() => void narrate()} disabled={busy}>
              {narrPhase === 'analyzing' ? '转写中…' : '提取完整旁白'}
            </button>
            {desktopReady && (
              <button
                className="btn-ghost shrink-0 !border-brand/40 !text-brand-soft !py-2.5 !text-[12.5px]"
                onClick={() => void runLocalAll()}
                disabled={busy}
                title="本机 IP 解析+下载+分镜+旁白，全程走你的家宽 IP，绕过机房风控与 Pages 限制"
              >
                {localPhase === 'analyzing' ? '本地处理中…' : '⬇ 本地一键全流程'}
              </button>
            )}
          </div>

          {desktopReady && (
            <p className="rounded-xl border border-brand/20 bg-brand/[.05] px-3 py-2 text-[11px] leading-relaxed text-brand-soft/90">
              <strong className="text-brand-soft">本地一键全流程</strong>：解析 → 下载到本机 → 本地分镜提示词 → 完整旁白，
              全部走你的家宽 IP（<span className="text-slate-400">YouTube / Instagram 的机房 IP 风控、Pages 10s 墙钟都绕开</span>）。
              需要先在下方填好「视觉 LLM」与「文本 LLM」。
              {localStage && <span className="ml-1 text-slate-300">当前：{localStage}</span>}
            </p>
          )}

          {localPhase === 'error' && localError && (
            <p className="rounded-xl border border-rose-500/20 bg-rose-500/[.06] px-3 py-2 text-[11.5px] leading-relaxed text-rose-200">
              {localError}
            </p>
          )}
          {localPhase === 'success' && localPath && (
            <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/[.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-200/90">
              已完成：本地文件 <span className="break-all font-mono">{localPath}</span>
            </p>
          )}

          {/* LLM 配置（BYOK · 双供应商） */}
          <div className="rounded-xl border border-white/5 bg-white/[.02] p-3">
            <button
              className="flex w-full items-center justify-between text-left"
              onClick={() => setShowCfg((v) => !v)}
            >
              <span className="text-[11.5px] font-medium text-slate-300">
                LLM 配置（BYOK · 视觉 + 文本 双供应商）
                {visionReady ? (
                  <span className="ml-2 text-emerald-300/80">视觉已配</span>
                ) : (
                  <span className="ml-2 text-amber-300/80">未配置</span>
                )}
              </span>
              <span className="text-[11px] text-slate-500">{showCfg ? '收起' : '展开'}</span>
            </button>
            {showCfg && (
              <div className="mt-2.5 space-y-2.5">
                <div className="space-y-1.5 rounded-lg border border-brand/15 bg-brand/[.04] p-2.5">
                  <p className="text-[10.5px] font-medium text-brand-soft">视觉 LLM（分镜反推 · 多模态）</p>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                    placeholder="Base URL（如 https://apihub.agnes-ai.com/v1）"
                    value={settings.llmBaseUrl}
                    onChange={(e) => update('llmBaseUrl', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      placeholder="Model（agnes-2.5-flash / gpt-4o-mini）"
                      value={settings.llmModel}
                      onChange={(e) => update('llmModel', e.target.value)}
                    />
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      type="password"
                      placeholder="API Key（可留空）"
                      value={settings.llmApiKey}
                      onChange={(e) => update('llmApiKey', e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[.02] p-2.5">
                  <p className="text-[10.5px] font-medium text-slate-300">文本 LLM（旁白转写 · 可选，留空复用视觉）</p>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                    placeholder="Base URL（如 https://api.groq.com/openai/v1）"
                    value={settings.llmTextBaseUrl}
                    onChange={(e) => update('llmTextBaseUrl', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      placeholder="Model（whisper-large-v3）"
                      value={settings.llmTextModel}
                      onChange={(e) => update('llmTextModel', e.target.value)}
                    />
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      type="password"
                      placeholder="API Key（可留空）"
                      value={settings.llmTextApiKey}
                      onChange={(e) => update('llmTextApiKey', e.target.value)}
                    />
                  </div>
                </div>

                <input
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                  placeholder="转写语言（可选，如 zh / en）"
                  value={settings.llmLanguage}
                  onChange={(e) => update('llmLanguage', e.target.value)}
                />
                <p className="text-[10.5px] leading-relaxed text-slate-500">
                  密钥只存在你本机浏览器（localStorage），随请求直发内核，不落第三方。分镜走 /v1/chat/completions，旁白走 /v1/audio/transcriptions。
                </p>
              </div>
            )}
          </div>

          {phase === 'analyzing' && (
            <p className="text-[11.5px] text-slate-400">云端下载 + 抽帧 + LLM 反推中…首帧较慢，请稍候。</p>
          )}
          {phase === 'error' && error && (
            <p className="rounded-xl border border-rose-500/20 bg-rose-500/[.06] px-3 py-2 text-[11.5px] leading-relaxed text-rose-200">
              {error}
            </p>
          )}

          {/* 分镜结果 */}
          {phase === 'success' && result && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { k: '镜头数', v: String(result.stats?.sceneCount ?? nodes.length) },
                  { k: '平均镜头', v: seconds(result.stats?.avgShotDuration ?? 0) },
                  { k: '总时长', v: seconds(result.source?.duration ?? 0) },
                  { k: '分辨率', v: result.source?.width ? `${result.source.width}×${result.source.height}` : '—' },
                ].map((it) => (
                  <div key={it.k} className="rounded-xl border border-white/5 bg-white/[.02] px-3 py-2">
                    <p className="text-[10.5px] text-slate-500">{it.k}</p>
                    <p className="mt-0.5 text-[13px] font-medium text-slate-100">{it.v}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand/20 bg-brand/[.06] px-3 py-2">
                <span className="text-[11.5px] text-slate-200">节奏：{result.stats?.cutRhythm}</span>
                <span className="text-[10.5px] text-slate-500">· {result.stats?.analyzedBy}</span>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportMd}>导出 Markdown</button>
                  <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportCsv}>导出 CSV</button>
                  <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={exportJson}>导出 JSON</button>
                </div>
              </div>

              {result.stats?.note && (
                <p className="rounded-xl border border-amber-400/20 bg-amber-400/[.05] px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
                  {result.stats.note}
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {nodes.map((n: any) => (
                  <article key={n.id} className="overflow-hidden rounded-xl border border-white/5 bg-white/[.02]">
                    <div className="relative aspect-video bg-black">
                      {n.thumbnailUrl ? (
                        <img src={n.thumbnailUrl} alt={`镜头 ${n.index}`} className="h-full w-full object-cover" />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-[11px] text-slate-600">无关键帧</div>
                      )}
                      <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                        #{n.index} · {timecode(n.startTime)}
                      </span>
                      <span className="absolute right-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                        {seconds(n.duration ?? n.endTime - n.startTime)}
                      </span>
                    </div>
                    <div className="space-y-1.5 p-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        <span className="chip bg-brand/15 text-brand-soft">{n.shotType}</span>
                        <span className="chip bg-white/5 text-slate-400">{n.cameraMovement}</span>
                      </div>
                      <p className="font-mono text-[10px] text-slate-600">
                        {timecode(n.startTime)} → {timecode(n.endTime)}
                      </p>
                      {n.visualDescription && (
                        <p className="text-[11px] leading-relaxed text-slate-400">{n.visualDescription}</p>
                      )}
                      {n.dialogue && (
                        <p className="text-[11px] leading-relaxed text-slate-300">「{n.dialogue}」</p>
                      )}
                      {n.aiPrompt?.imagePrompt && (
                        <div className="rounded-lg border border-white/5 bg-black/30 p-2">
                          <p className="mb-1 text-[10px] font-medium text-brand-soft">图 Prompt · Flux</p>
                          <p className="break-words font-mono text-[10.5px] leading-relaxed text-slate-300">{n.aiPrompt.imagePrompt}</p>
                        </div>
                      )}
                      {n.aiPrompt?.videoPrompt && (
                        <div className="rounded-lg border border-white/5 bg-black/30 p-2">
                          <p className="mb-1 text-[10px] font-medium text-brand-soft">视频 Prompt · Wan/Hunyuan</p>
                          <p className="break-words font-mono text-[10.5px] leading-relaxed text-slate-300">{n.aiPrompt.videoPrompt}</p>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {/* 旁白结果 */}
          {narrPhase === 'error' && narrError && (
            <p className="rounded-xl border border-rose-500/20 bg-rose-500/[.06] px-3 py-2 text-[11.5px] leading-relaxed text-rose-200">
              {narrError}
            </p>
          )}
          {narrPhase === 'success' && narration && (
            <div className="space-y-2 rounded-xl border border-white/5 bg-white/[.02] p-3">
              <p className="text-[11.5px] font-medium text-slate-300">完整旁白 / 转写</p>
              <textarea
                className="h-32 w-full resize-y rounded-lg border border-white/5 bg-black/40 p-2 text-[11.5px] leading-relaxed text-slate-300"
                readOnly
                value={narration}
              />
              <div className="flex gap-2">
                <button className="btn-ghost !py-1.5 !text-[11.5px]" onClick={() => navigator.clipboard?.writeText(narration)}>
                  复制
                </button>
                <button
                  className="btn-ghost !py-1.5 !text-[11.5px]"
                  onClick={() => downloadText(`${baseName}_旁白.txt`, narration, 'text/plain;charset=utf-8')}
                >
                  下载
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
