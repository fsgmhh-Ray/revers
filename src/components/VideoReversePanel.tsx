import { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import { cloudNarration, cloudStoryboard, type LlmCfg } from '../services/cloudBridge';
import { getElectronAPI, localNarration } from '../services/electronBridge';
import { detectPlatform } from '../utils/platform';
import { formatNarration } from '../utils/narration';
import { probeTextLlm, probeVisionLlm } from '../services/llmProbe';
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
  const [copied, setCopied] = useState(false);
  /** 旁白来源（「字幕（zh-Hans）」/「音频转写」），让用户知道拿到的是哪一种 */
  const [narrSource, setNarrSource] = useState('');

  /** 桌面端本地全流程：已下载到本机的视频路径 */
  const [localPath, setLocalPath] = useState('');
  const [localDir, setLocalDir] = useState('');
  const [localPhase, setLocalPhase] = useState<Phase>('idle');
  const [localError, setLocalError] = useState('');
  const [localStage, setLocalStage] = useState('');
  /** 本地全流程已耗时（秒），长任务没有计时会让人以为卡死 */
  const [localElapsed, setLocalElapsed] = useState(0);

  /**
   * 用户手动上传的本地文件（与「下载到本机」的 localPath 分开存）。
   *
   * 必须分开：localPath 会残留上一次下载的文件。若直接复用它，用户换了新链接
   * 却还在分析旧文件——界面上看不出区别，是极难察觉的错误。
   */
  const [uploadedPath, setUploadedPath] = useState('');
  const [uploadedName, setUploadedName] = useState('');

  /** LLM 配置自检：发真实最小请求验证 base/model/key */
  const [probeState, setProbeState] = useState<{ vision: string; text: string }>({ vision: '', text: '' });
  const [probeMsg, setProbeMsg] = useState<{ vision: string; text: string }>({ vision: '', text: '' });

  const testVision = async () => {
    setProbeState((s) => ({ ...s, vision: 'testing' }));
    setProbeMsg((s) => ({ ...s, vision: '正在测试视觉 LLM…' }));
    const r = await probeVisionLlm({ baseUrl: settings.llmBaseUrl, apiKey: settings.llmApiKey, model: settings.llmModel });
    setProbeState((s) => ({ ...s, vision: r.ok ? 'ok' : 'fail' }));
    setProbeMsg((s) => ({ ...s, vision: `${r.ok ? '✓' : '✗'} ${r.message}` }));
  };

  const testText = async () => {
    setProbeState((s) => ({ ...s, text: 'testing' }));
    setProbeMsg((s) => ({ ...s, text: '正在测试文本 LLM…' }));
    const r = await probeTextLlm({ baseUrl: settings.llmTextBaseUrl, apiKey: settings.llmTextApiKey, model: settings.llmTextModel });
    setProbeState((s) => ({ ...s, text: r.ok ? 'ok' : 'fail' }));
    setProbeMsg((s) => ({ ...s, text: `${r.ok ? '✓' : '✗'} ${r.message}` }));
  };

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
  /**
   * 桌面端解析/下载的公共参数。
   *
   * 以前这里只传了 url/filename，结果：① 用户设置的下载目录被忽略，视频被丢到
   * 系统盘默认目录（Ray 明确要求「不要放 C 盘」）；② 浏览器登录态没带上，
   * YouTube 更容易撞风控。两处都在这里统一补齐。
   */
  const dlCommon = {
    dir: settings.downloadDir || undefined,
    cookieBrowser: settings.cookieBrowser && settings.cookieBrowser !== 'auto' ? settings.cookieBrowser : undefined,
    cookieFile: settings.cookieFile || undefined,
  };
  // 缺失项提示：只缺 key 时明确说「缺 Key」，避免用户看到「未配置」却不知道差什么
  const visionMissing = !settings.llmBaseUrl
    ? '视觉 LLM 缺 Base URL'
    : !settings.llmModel
      ? '视觉 LLM 缺 Model'
      : '';
  const textMissing = !settings.llmTextBaseUrl
    ? '文本 LLM 缺 Base URL'
    : !settings.llmTextModel
      ? '文本 LLM 缺 Model'
      : '';
  const busy = phase === 'analyzing' || narrPhase === 'analyzing' || localPhase === 'analyzing';

  // 桌面端：订阅主进程抽帧/转写进度
  useEffect(() => {
    if (!api) return;
    return api.onStoryboardProgress((event) => {
      setLocalStage(event.stage || '');
    });
  }, [api]);

  /**
   * 订阅下载进度。
   *
   * 为什么必须有：桌面端「提取完整旁白」在链接没下载过时会先解析 + 下载
   * （YouTube 视频动辄 30~40MB，要一两分钟），而这一段以前**完全没有进度回传**，
   * 界面只显示一句固定的「解析并下载到本机」——用户看一分钟不动就会以为卡死了。
   */
  useEffect(() => {
    if (!api) return;
    return api.onDownloadProgress((event) => {
      if (event?.error) return;
      if (event?.done) {
        setLocalStage('下载完成，开始本地处理');
        return;
      }
      setLocalStage(`下载到本机 ${event?.percent ?? 0}%`);
    });
  }, [api]);

  // 长任务计时：任一条链路在跑就每秒 +1，阶段文案旁边显示「已用 37s」
  useEffect(() => {
    const running = phase === 'analyzing' || narrPhase === 'analyzing' || localPhase === 'analyzing';
    if (!running) return;
    const t = setInterval(() => setLocalElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [phase, narrPhase, localPhase]);

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
    setLocalElapsed(0);
    setLocalStage('解析视频信息');
    try {
      const platform = detectPlatform(url.trim());
      const parsed = await api.parse({ url: url.trim(), platform, ...dlCommon });
      if (!parsed.ok) throw new Error(parsed.error || '解析失败');

      setLocalStage('下载到本机');
      const fileName = `${safeName(parsed.data.title || 'video')}.mp4`;
      const dl = await api.download({
        id: `rev_${Date.now()}`,
        url: url.trim(),
        platform,
        filename: fileName,
        sourceUrl: parsed.data.originalUrl,
        ...dlCommon,
      });
      if (!dl.ok || !dl.path) throw new Error(dl.error || '下载失败，未拿到本地文件');

      setLocalPath(dl.path);
      setLocalDir(dl.dir || '');
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
          // 即便已经下载了整段视频，也先试字幕：质量更好且不用付 ASR 的钱
          const local = await localNarration({ path: dl.path, url: url.trim(), ...dlCommon }, llm, `nr_${Date.now()}`);
          if (local?.transcript) {
            // 与「提取完整旁白」按钮保持同一套整理逻辑，否则一键流程出来的是挤成一坨的原文
            setNarration(
              local.source === 'subtitle'
                ? formatNarration(local.transcript, { keepTimestamps: true })
                : formatNarration(local.transcript),
            );
            setNarrSource(local.source === 'subtitle' ? `字幕（${local.lang || '自动'}）` : '音频转写');
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

  /**
   * 上传本地视频 —— 网络链接解释不了时的兜底入口。
   *
   * 风控 / 限区 / 解析源只给静音版 / 站点改版，都会让链接走不通；但用户本地
   * 往往已经有这个文件。拿到绝对路径后，分镜与旁白全部走本地 ffmpeg，
   * 不再依赖任何解析源（连 yt-dlp 都不需要）。
   */
  const pickLocalFile = async () => {
    if (!api?.pickFile) {
      setLocalError('当前桌面端版本不支持上传本地文件，请升级到最新版');
      setLocalPhase('error');
      return;
    }
    const picked = await api.pickFile();
    if (!picked?.path) return; // 用户取消，什么都不做
    setUploadedPath(picked.path);
    setUploadedName(picked.name || picked.path.split(/[\\/]/).pop() || '本地文件');
    setLocalPath(picked.path);
    setLocalDir('');
    setLocalStage(`已选择本地文件：${picked.name}`);
    setLocalError('');
    setLocalPhase('idle');
    setError('');
    setNarrError('');
  };

  const reverse = async () => {
    // 上传过本地文件就直接拿它反推——这正是「链接解释不了」时的兜底路径
    const localFile = desktopReady ? uploadedPath : '';
    if (!url.trim() && !localFile) {
      setError('请先粘贴视频链接，或点「⬆ 上传本地视频」选择本机文件');
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
    setLocalElapsed(0);
    try {
      // 桌面端：走本机 IP（解析→下载→本地分镜），避免云端内核的机房 IP 风控
      // 与 Pages 墙钟限制。云端内核对 YouTube 会直接返回 bot check。
      if (desktopReady) {
        // 上传过本地文件就跳过「解析 + 下载」这两步最容易失败的环节
        let filePath = localFile;
        if (!filePath) {
          setLocalStage('解析并下载到本机');
          const platform = detectPlatform(url.trim());
          const parsed = await api!.parse({ url: url.trim(), platform, ...dlCommon });
          if (!parsed.ok) throw new Error(parsed.error || '解析失败');
          const fileName = `${safeName(parsed.data.title || 'video')}.mp4`;
          const dl = await api!.download({
            id: `rev_${Date.now()}`,
            url: url.trim(),
            platform,
            filename: fileName,
            sourceUrl: parsed.data.originalUrl,
            ...dlCommon,
          });
          if (!dl.ok || !dl.path) throw new Error(dl.error || '下载失败，未拿到本地文件');
          filePath = dl.path;
          setLocalPath(dl.path);
          setLocalDir(dl.dir || '');
        }
        setLocalStage(`本地抽帧拆解分镜（${filePath.split(/[\\/]/).pop()}）`);
        const sb = await api!.storyboard({
          id: `sb_${Date.now()}`,
          path: filePath,
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
    if (!url.trim() && !(desktopReady && uploadedPath)) {
      setNarrError('请先粘贴视频链接，或点「⬆ 上传本地视频」选择本机文件');
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
    setLocalElapsed(0);
    try {
      // 桌面端：无论是否已下载过，都走本机 IP（避免云端内核的机房 IP 风控 / Pages 墙钟）
      if (desktopReady && api) {
        // ① 先试字幕：只要视频有官方/自动字幕，几秒就能拿到，且不用花钱、不会有同音字错。
        //    拿不到才回退到「下载音轨 + ASR」这条慢路（慢一到两个数量级）。
        //    纯上传的本地文件没有链接可抓字幕，这一步整个跳过。
        if (url.trim()) {
          setLocalStage('尝试直接取字幕');
          const subtitleHit = await localNarration(
            { url: url.trim(), ...dlCommon },
            llm,
            `nr_${Date.now()}`,
          );
          if (subtitleHit?.transcript) {
            setNarration(formatNarration(subtitleHit.transcript, { keepTimestamps: true }));
            setNarrSource(subtitleHit.source === 'subtitle' ? `字幕（${subtitleHit.lang || '自动'}）` : '音频转写');
            setNarrPhase('success');
            return;
          }
        }

        // ② 没字幕：用本地文件（上传的优先），没有才下载音轨后转写
        let target = uploadedPath || localPath;
        if (!target) {
          setLocalStage('无字幕，下载音轨到本机');
          const p = detectPlatform(url.trim());
          const parsed = await api.parse({ url: url.trim(), platform: p, ...dlCommon });
          if (!parsed.ok) throw new Error(parsed.error || '解析失败');
          const dl = await api.download({
            id: `rev_narr_${Date.now()}`,
            url: url.trim(),
            platform: p,
            filename: `${safeName(parsed.data.title || 'video')}.m4a`,
            sourceUrl: parsed.data.originalUrl,
            audioOnly: true,
            ...dlCommon,
          });
          if (!dl.ok || !dl.path) throw new Error(dl.error || '下载失败，未拿到本地文件');
          target = dl.path;
          setLocalPath(dl.path);
          setLocalDir(dl.dir || '');
        }
        setLocalStage('本地转写旁白');
        const local = await localNarration(target!, llm, `nr_${Date.now()}`);
        if (local?.transcript) {
          setNarration(formatNarration(local.transcript));
          setNarrSource(local.source === 'subtitle' ? `字幕（${local.lang || '自动'}）` : '音频转写');
          setNarrPhase('success');
          return;
        }
        setNarrError(local?.needFile ? '该视频没有字幕，且未拿到本地音轨' : '本地转写返回为空（该视频可能无人声）');
        setNarrPhase('error');
        return;
      }
      const data = await cloudNarration(url.trim(), llm);
      if (data?.status === 'error') {
        setNarrPhase('error');
        setNarrError(data.text || '转写失败');
        return;
      }
      setNarration(formatNarration(data?.transcript || ''));
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
            贴任意视频链接 → 云端内核抽帧 → 多模态 LLM 反推分镜提示词 / 完整旁白；链接解释不了时可用「上传本地视频」直接反推
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
                className="btn-ghost shrink-0 !border-emerald-400/40 !text-emerald-200 !py-2.5 !text-[12.5px]"
                onClick={() => void pickLocalFile()}
                disabled={busy}
                title="链接解析不了（风控 / 限区 / 解析源只给静音版）时，直接用本机已有的视频文件反推——全程本地 ffmpeg，不依赖任何解析源"
              >
                ⬆ 上传本地视频
              </button>
            )}
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

          {uploadedName && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-100/90">
              <span>
                已选本地文件 <strong className="text-emerald-200">{uploadedName}</strong>
                —— 将直接用它反推，不再解析任何链接。
              </span>
              <button
                className="ml-auto shrink-0 rounded-lg border border-white/10 px-2 py-0.5 text-[10.5px] text-slate-300 hover:bg-white/5"
                onClick={() => {
                  setUploadedPath('');
                  setUploadedName('');
                  setLocalStage('');
                }}
              >
                清除
              </button>
            </div>
          )}

          {desktopReady && (
            <p className="rounded-xl border border-brand/20 bg-brand/[.05] px-3 py-2 text-[11px] leading-relaxed text-brand-soft/90">
              <strong className="text-brand-soft">本地一键全流程</strong>：解析 → 下载到本机 → 本地分镜提示词 → 完整旁白，
              全部走你的家宽 IP（<span className="text-slate-400">YouTube / Instagram 的机房 IP 风控、Pages 10s 墙钟都绕开</span>）。
              需要先在下方填好「视觉 LLM」与「文本 LLM」。
              {localStage && (
                <span className="ml-1 text-slate-300">
                  当前：{localStage}
                  {busy && localElapsed > 0 && <span className="text-slate-400">（已用 {localElapsed}s）</span>}
                </span>
              )}
            </p>
          )}

          {localPhase === 'error' && localError && (
            <p className="rounded-xl border border-rose-500/20 bg-rose-500/[.06] px-3 py-2 text-[11.5px] leading-relaxed text-rose-200">
              {localError}
            </p>
          )}
          {localPhase === 'success' && localPath && (
            <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/[.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-200/90">
              已完成（用时 {localElapsed}s）：本地文件 <span className="break-all font-mono">{localPath}</span>
              {localDir &&
                settings.downloadDir &&
                localDir.replace(/[\\/]+$/, '').toLowerCase() !==
                  settings.downloadDir.replace(/[\\/]+$/, '').toLowerCase() && (
                  <span className="text-amber-200/90">
                    {' '}
                    ⚠️ 你设置的下载目录不可写，已自动回退到 <span className="font-mono">{localDir}</span>（请到「设置」改一个可写目录）
                  </span>
                )}
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
                  <span className="ml-2 text-amber-300/80">{visionMissing || '未配置'}</span>
                )}
                {textReady ? (
                  <span className="ml-2 text-emerald-300/80">文本已配</span>
                ) : (
                  <span className="ml-2 text-amber-300/80">{textMissing || '文本未配'}</span>
                )}
              </span>
              <span className="text-[11px] text-slate-500">{showCfg ? '收起' : '展开'}</span>
            </button>
            {showCfg && (
              <div className="mt-2.5 space-y-2.5">
                <div className="space-y-1.5 rounded-lg border border-brand/15 bg-brand/[.04] p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10.5px] font-medium text-brand-soft">视觉 LLM（分镜反推 · 多模态）</p>
                    <button
                      className="btn-ghost !px-2 !py-1 !text-[10.5px]"
                      disabled={probeState.vision === 'testing'}
                      onClick={() => void testVision()}
                      title="发一个最小请求，验证 Base URL / Model / Key 是否真的可用"
                    >
                      {probeState.vision === 'testing' ? '测试中…' : '测试'}
                    </button>
                  </div>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                    placeholder="Base URL（如 https://integrate.api.nvidia.com/v1）"
                    value={settings.llmBaseUrl}
                    onChange={(e) => update('llmBaseUrl', e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      placeholder="Model（建议 meta/llama-3.2-11b-vision-instruct）"
                      value={settings.llmModel}
                      onChange={(e) => update('llmModel', e.target.value)}
                    />
                    <input
                      className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                      type="password"
                      placeholder="API Key（nvapi-…）"
                      value={settings.llmApiKey}
                      onChange={(e) => update('llmApiKey', e.target.value)}
                    />
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-500">
                    同一把 NVIDIA key 实测：<span className="text-slate-300">11b 单帧约 1 秒</span>，
                    <span className="text-slate-300">90b 单帧约 85 秒</span>（跑 9 个镜头差 10 分钟以上）。
                    分镜优先用 11b；要更高质量再换 90b，但请耐心等进度条。
                  </p>
                  {probeMsg.vision && (
                    <p className={`text-[10.5px] leading-relaxed ${probeState.vision === 'ok' ? 'text-emerald-300/90' : probeState.vision === 'fail' ? 'text-rose-300/90' : 'text-slate-400'}`}>
                      {probeMsg.vision}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[.02] p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10.5px] font-medium text-slate-300">文本 LLM（旁白转写 · Groq whisper）</p>
                    <button
                      className="btn-ghost !px-2 !py-1 !text-[10.5px]"
                      disabled={probeState.text === 'testing'}
                      onClick={() => void testText()}
                      title="发一个 0.2 秒静音音频，验证转写端点是否可用"
                    >
                      {probeState.text === 'testing' ? '测试中…' : '测试'}
                    </button>
                  </div>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                    placeholder="Base URL（https://api.groq.com/openai/v1）"
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
                      placeholder="API Key（gsk_…）"
                      value={settings.llmTextApiKey}
                      onChange={(e) => update('llmTextApiKey', e.target.value)}
                    />
                  </div>
                  {probeMsg.text && (
                    <p className={`text-[10.5px] leading-relaxed ${probeState.text === 'ok' ? 'text-emerald-300/90' : probeState.text === 'fail' ? 'text-rose-300/90' : 'text-slate-400'}`}>
                      {probeMsg.text}
                    </p>
                  )}
                </div>

                <input
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-slate-200 outline-none focus:border-brand"
                  placeholder="转写语言（可选，如 zh / en；留空=自动）"
                  value={settings.llmLanguage}
                  onChange={(e) => update('llmLanguage', e.target.value)}
                />
                <p className="text-[10.5px] leading-relaxed text-slate-500">
                  配置会<strong className="text-slate-400">自动保存</strong>到本机浏览器（localStorage），随请求直发，不落第三方。
                  分镜走 /v1/chat/completions，旁白走 /v1/audio/transcriptions。
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
              <div className="flex items-center justify-between">
                <p className="text-[11.5px] font-medium text-slate-300">
                  完整旁白 / 转写
                  {narrSource && (
                    <span className="ml-1.5 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-normal text-brand-soft">
                      {narrSource}
                    </span>
                  )}
                  <span className="ml-1.5 text-[10.5px] font-normal text-slate-500">
                    {narrSource.startsWith('字幕') ? '（带时间轴，可直接编辑）' : '（已断句分段，可直接编辑）'}
                  </span>
                </p>
                <span className="text-[10.5px] text-slate-500">{narration.length} 字</span>
              </div>
              <textarea
                className="h-44 w-full resize-y whitespace-pre-wrap rounded-lg border border-white/5 bg-black/40 p-2.5 text-[12px] leading-7 text-slate-300"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="转写结果会出现在这里…"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn-ghost !py-1.5 !text-[11.5px]"
                  onClick={() => {
                    void navigator.clipboard?.writeText(narration);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? '已复制 ✓' : '复制全文'}
                </button>
                <button
                  className="btn-ghost !py-1.5 !text-[11.5px]"
                  onClick={() => {
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    downloadText(`旁白_${stamp}.txt`, narration, 'text/plain;charset=utf-8');
                  }}
                >
                  保存为 .txt
                </button>
                <button
                  className="btn-ghost !py-1.5 !text-[11.5px]"
                  onClick={() => {
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    downloadText(`旁白_${stamp}.md`, `# 完整旁白\n\n${narration}\n`, 'text/markdown;charset=utf-8');
                  }}
                >
                  保存为 .md
                </button>
                <button
                  className="btn-ghost !py-1.5 !text-[11.5px]"
                  onClick={() => {
                    setNarration('');
                    setNarrPhase('idle');
                  }}
                >
                  清空
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
