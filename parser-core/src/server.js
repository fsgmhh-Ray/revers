/**
 * parser-core —— 自建解析内核
 *
 * 以 Cobalt 兼容协议（POST /api/json）对外提供服务，内部使用 yt-dlp 解析，
 * 部署在独立 VPS 上可规避 Cloudflare / 数据中心 IP 被 YouTube、Instagram 封禁的问题。
 *
 * Stage 2 扩展：
 *   POST /api/storyboard   视频 URL → FFmpeg 场景切分 + 关键帧抽取 → 多模态 LLM 填充分镜
 *   POST /api/narration    视频 URL → 抽音轨 → LLM 转写（完整旁白）
 * 两个端点均 BYOK：baseUrl / apiKey / model 通过请求体传入，服务端不落盘密钥。
 * 支持「双 profile」：视觉 LLM（分镜，多模态/视频，如 agnes）与文本 LLM（旁白转写，如 Groq）
 * 独立配置；文本未填则复用视觉配置，单配置用户无需填两次。
 *
 * 环境变量：
 *   PORT           默认 9000
 *   API_KEY        可选；设置后需在请求头带 Authorization: Api-Key <key>
 *   ALLOWED_ORIGIN 可选；CORS 白名单（默认 *）
 *   YTDLP_PATH     yt-dlp 可执行文件路径（默认 yt-dlp）
 *   CACHE_TTL      解析结果缓存秒数（默认 300）
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, writeFile } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { callVision, transcribe } from './lib/llm.js';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 9000);
const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const CACHE_TTL = Number(process.env.CACHE_TTL || 300) * 1000;
/** YouTube / Instagram 对数据中心 IP 风控严重，挂载 cookies.txt 才能稳定解析 */
const COOKIES_PATH = process.env.COOKIES_PATH || '/app/cookies.txt';
const HAS_COOKIES = existsSync(COOKIES_PATH);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** 内存缓存：url -> { payload, expiresAt } */
const cache = new Map();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function requireKey(req) {
  return !API_KEY || req.headers.authorization === `Api-Key ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited with ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('yt-dlp 输出无法解析为 JSON'));
      }
    });
  });
}

/** 选出画质最高的 mp4 直链 */
function pickBestFormat(info) {
  const formats = (info?.formats || []).filter((f) => f.url);
  if (!formats.length) return { url: info?.url, height: info?.height, width: info?.width };

  const videoOnly = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && !/storyboard/i.test(f.format_id || ''));
  const progressive = videoOnly.filter((f) => f.acodec && f.acodec !== 'none');
  const pool = progressive.length ? progressive : videoOnly;
  const best = pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || formats[formats.length - 1];
  return { url: best.url, height: best.height, width: best.width, hasAudio: Boolean(best?.acodec && best.acodec !== 'none') };
}

async function parse(url) {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--dump-json',
    '--user-agent',
    UA,
  ];
  if (HAS_COOKIES) args.push('--cookies', COOKIES_PATH);
  args.push('--extractor-args', 'youtube:player_client=android_vr,web_safari', url);

  const info = await runYtDlp(args);

  const best = pickBestFormat(info);
  if (!best?.url) {
    return { status: 'error', text: 'yt-dlp 未返回可用直链（多为风控或登录墙）' };
  }

  const payload = {
    status: 'redirect',
    url: best.url,
    filename: `${(info.title || 'video').slice(0, 80)}.mp4`,
    meta: {
      id: info.id,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader || info.channel,
      thumbnail: info.thumbnail,
      width: best.width || info.width,
      height: best.height || info.height,
      extractor: info.extractor_key,
      webpage_url: info.webpage_url || url,
    },
  };

  cache.set(url, { payload, expiresAt: Date.now() + CACHE_TTL });
  return payload;
}

/** 阻止通过 /api/fetch 打内网（SSRF 防护） */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function buildReferer(target) {
  const h = target.hostname.toLowerCase();
  if (/tiktok|muscdn|byteoversea|musical\.ly/.test(h)) return 'https://www.tiktok.com/';
  if (/instagram|cdninstagram|fbcdn/.test(h)) return 'https://www.instagram.com/';
  if (/youtube|youtu\.be|googlevideo|ytimg/.test(h)) return 'https://www.youtube.com/';
  if (/douyin|iesdouyin/.test(h)) return 'https://www.douyin.com/';
  if (/xiaohongshu|xhscdn/.test(h)) return 'https://www.xiaohongshu.com/';
  return `${target.protocol}//${target.hostname}/`;
}

/* ------------------------------------------------------------------ */
/* Stage 2：视频下载 / 场景切分 / 抽帧 / 转写                            */
/* ------------------------------------------------------------------ */

const tmp = (ext) => join(tmpdir(), `cf_${randomUUID()}.${ext}`);

/** 流式下载（直链可能绑定 IP，失败回退到内核自带的 /api/fetch 代理） */
async function streamDownload(url, dest, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** 解析 URL → 直链 → 落地为本地文件，返回 { path, meta } */
async function resolveAndDownload(url, dest) {
  const parsed = await parse(url);
  if (parsed.status !== 'redirect' || !parsed.url) {
    throw new Error(parsed.text || '解析失败');
  }
  const direct = parsed.url;
  // 先直连（TikTok/TikWM 这类公共源很快）
  try {
    await streamDownload(direct, dest, {
      'User-Agent': UA,
      Accept: 'video/*,*/*;q=0.8',
      Referer: buildReferer(new URL(direct)),
    });
    if ((await fileSize(dest)) > 4096) return { path: dest, meta: parsed.meta };
  } catch {
    /* 落空继续走代理 */
  }
  // 回退：内核自带的源站代拉（YouTube / Instagram 直链绑定 IP 时必须走这条）
  const proxy = `http://127.0.0.1:${PORT}/api/fetch?url=${encodeURIComponent(direct)}`;
  const proxyHeaders = API_KEY ? { Authorization: `Api-Key ${API_KEY}` } : {};
  await streamDownload(proxy, dest, proxyHeaders);
  return { path: dest, meta: parsed.meta };
}

async function fileSize(p) {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

async function probeDuration(path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', path,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

/** FFmpeg 场景检测，返回场景切换时间点（秒） */
async function detectScenes(path, threshold) {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-i', path,
    // 注意：ffmpeg 的 -filter_complex 用逗号分隔多个滤镜，因此 gt(scene,...) 内部逗号必须
    // 用单引号包住整个表达式，否则 ffmpeg 会把逗号误判为滤镜分隔符而报 "Missing ')' in 'gt(scene'"。
    '-filter_complex', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ]);
  const times = [];
  const re = /pts_time:(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) times.push(parseFloat(m[1]));
  return times;
}

async function extractFrame(path, timeSec, width) {
  const out = tmp('jpg');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(timeSec), '-i', path,
    '-frames:v', '1', '-vf', `scale=${width}:-1`, '-q:v', '3', out,
  ]);
  const buf = await readFile(out);
  await unlink(out).catch(() => {});
  return buf.toString('base64');
}

/** 把模型返回的文案稳健地解析为 JSON（容错 ```json 代码块 / 夹杂文字） */
function parseJsonRobust(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * 反推分镜：场景切分 → 抽帧 → 多模态 LLM 填充分镜字段。
 * 返回与前端 StoryboardResult 对齐的结构。
 */
async function buildStoryboard(videoPath, opts, llm) {
  const duration = await probeDuration(videoPath);
  if (!duration) throw new Error('无法读取视频时长（文件可能损坏）');

  const threshold = opts.threshold ?? 0.3;
  const maxShots = Math.min(opts.maxShots ?? 24, 48);
  const frameWidth = opts.frameWidth ?? 480;

  let changes = [];
  try {
    changes = await detectScenes(videoPath, threshold);
  } catch {
    changes = [];
  }

  // 场景边界：0, 切换点..., duration
  let cuts = [0, ...changes.filter((t) => t > 0 && t < duration)];
  let segments = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : duration;
    if (end - start >= 0.2) segments.push({ start, end });
  }
  // 兜底：静态/无切换 → 等间隔切分
  if (segments.length < 2) {
    segments = [];
    for (let i = 0; i < maxShots; i++) {
      segments.push({ start: (duration * i) / maxShots, end: (duration * (i + 1)) / maxShots });
    }
  }
  // 超过上限 → 等间隔抽稀
  if (segments.length > maxShots) {
    const step = Math.ceil(segments.length / maxShots);
    segments = segments.filter((_, i) => i % step === 0).slice(0, maxShots);
  }

  const frames = [];
  for (const seg of segments) {
    const mid = (seg.start + seg.end) / 2;
    const b64 = await extractFrame(videoPath, mid, frameWidth);
    frames.push({ start: seg.start, end: seg.end, b64 });
  }

  const system =
    '你是资深影视分镜师与 AI 生图/视频 Prompt 工程师。根据关键帧逆向拆解短视频，' +
    '输出结构化分镜。务必只返回 JSON，不要任何解释或 markdown 代码块。';
  const userText =
    `以下是某短视频按时间顺序抽出的 ${frames.length} 张关键帧（单位为秒，已标注该帧所处时间点）。\n` +
    frames.map((f, i) => `帧${i + 1} @ ${f.start.toFixed(1)}s`).join('\n') +
    '\n\n请逆向拆解为分镜表，返回如下 JSON：\n' +
    '{\n' +
    '  "globalStyle": "整体视觉风格关键词，如 Cinematic, 8k, cyberpunk",\n' +
    '  "storyboards": [\n' +
    '    { "shotType": "特写(CU)|近景(MCU)|中景(MS)|全景(WS)|远景(LS)|极远景(ELS)",\n' +
    '      "cameraMovement": "快切(Cut)|固定(Static)|推(Track in)|拉(Track out)|摇(Pan/Tilt)|移(Truck)|跟(Follow)",\n' +
    '      "dialogue": "该镜头内的台词/旁白原文（无则空字符串）",\n' +
    '      "visualDescription": "画面内容中文描述（谁、在哪、做什么、构图、光线）",\n' +
    '      "aiPrompt": { "imagePrompt": "适配 Flux.1 的生图英文 Prompt", "videoPrompt": "适配 Wan2.1/Hunyuan 的动效英文 Prompt" } }\n' +
    '  ]\n' +
    '}\n' +
    `storyboards 数量应等于 ${frames.length}。dialogue 若视频无台词可留空。`;

  const content = await callVision({ ...llm, frames, system, userText });

  let parsed;
  try {
    parsed = parseJsonRobust(content);
  } catch {
    throw new Error('LLM 返回无法解析为 JSON（可能模型不支持结构化输出，请换用 GPT-4o / Groq / NIM 等）');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.storyboards || parsed?.storyboard || [];
  if (!Array.isArray(list)) throw new Error('LLM 返回结构不符合预期');

  const nodes = frames.map((f, i) => {
    const item = list[i] || {};
    const ap = item.aiPrompt || {};
    return {
      id: `shot_${i + 1}`,
      index: i + 1,
      startTime: Math.round(f.start * 1000),
      endTime: Math.round(f.end * 1000),
      duration: Math.round((f.end - f.start) * 1000),
      thumbnailUrl: `data:image/jpeg;base64,${f.b64}`,
      shotType: item.shotType || '中景(MS)',
      cameraMovement: item.cameraMovement || '固定(Static)',
      dialogue: item.dialogue || '',
      visualDescription: item.visualDescription || '',
      aiPrompt: {
        imagePrompt: ap.imagePrompt || '',
        videoPrompt: ap.videoPrompt || '',
      },
      inferred: true,
    };
  });

  const avg = nodes.length ? nodes.reduce((s, n) => s + (n.duration || 0), 0) / nodes.length : 0;
  const rhythm = avg < 1500 ? '快剪' : avg < 3000 ? '中速' : '舒缓';
  const stats = {
    sceneCount: nodes.length,
    sceneThreshold: threshold,
    avgShotDuration: Math.round(avg),
    cutRhythm: rhythm,
    analyzedBy: 'vision-llm',
    note: '画面描述/台词/反推 Prompt 由多模态大模型生成，景别与运镜为模型推断，建议人工复核。',
  };

  return {
    ok: true,
    id: randomUUID(),
    source: { file: videoPath, duration: Math.round(duration * 1000), width: 0, height: 0, fps: 0 },
    stats,
    nodes,
    globalStyle: parsed?.globalStyle || '',
  };
}

/** 检查视频是否含有音轨（静音视频无法转写） */
async function hasAudioStream(path) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', path,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 完整旁白：抽音轨 → 通用 LLM 转写 */
async function buildNarration(videoPath, llm) {
  if (!(await hasAudioStream(videoPath))) {
    throw new Error('该视频不含音轨，无法生成旁白/转写（请换一个有声音的视频）');
  }
  const wav = tmp('wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', wav,
  ]);
  try {
    const transcript = await transcribe({ ...llm, audioPath: wav, language: llm.language });
    return { ok: true, transcript, provider: llm.baseUrl, model: llm.model };
  } finally {
    await unlink(wav).catch(() => {});
  }
}

/**
 * 读取 LLM 配置，支持「双 profile」合用多个供应商。
 *   mode='vision'：反推分镜，只认视觉/通用配置（llmBaseUrl / llmApiKey / llmModel）。
 *   mode='text'  ：旁白转写，优先用「文本 LLM」独立配置（llmTextBaseUrl / llmTextApiKey / llmTextModel）；
 *                 未填则回退复用视觉配置（单配置用户无需填两次；如 agnes 视觉 + Groq 文本 即此分法）。
 */
function readLlmCfg(body, mode = 'vision') {
  let baseUrl = '';
  let apiKey = '';
  let model = '';
  if (mode === 'text') {
    baseUrl = (body.llmTextBaseUrl || '').trim();
    apiKey = (body.llmTextApiKey || '').trim();
    model = (body.llmTextModel || '').trim();
  }
  if (!baseUrl) {
    baseUrl = (body.llmBaseUrl || body.baseUrl || '').trim();
    apiKey = (body.llmApiKey || body.apiKey || apiKey || '').trim();
    model = (body.llmModel || body.model || model || '').trim();
  }
  if (!baseUrl) {
    const where =
      mode === 'text'
        ? '请在设置里填「文本 LLM（旁白转写）」，或不填文本配置以复用「视觉 LLM」'
        : '请在设置里填「视觉 LLM（分镜反推）」';
    throw new Error(`缺少 LLM base URL（${where}，例如 https://api.groq.com/openai/v1）`);
  }
  if (!model) {
    throw new Error(
      '缺少 LLM model（视觉如 gpt-4o-mini / agnes-2.5-flash；文本转写如 whisper-large-v3）',
    );
  }
  return { baseUrl, apiKey, model, language: (body.language || '').trim() };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' || url.pathname === '/') {
    return json(res, 200, {
      ok: true,
      service: 'parser-core',
      providers: ['yt-dlp', 'storyboard', 'narration'],
      cookies: HAS_COOKIES,
    });
  }

  if (url.pathname === '/api/json') {
    try {
      if (!requireKey(req)) return json(res, 401, { status: 'error', text: 'unauthorized' });
      let target = '';
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          target = (JSON.parse(raw) || {}).url || '';
        } catch {
          return json(res, 400, { status: 'error', text: 'invalid json body' });
        }
      } else {
        target = url.searchParams.get('url') || '';
      }
      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });
      const payload = await parse(target);
      return json(res, payload.status === 'error' ? 422 : 200, payload);
    } catch (err) {
      return json(res, 500, { status: 'error', text: String(err?.message || err).slice(0, 300) });
    }
  }

  /**
   * GET /api/fetch?url=<直链> —— 源站流式下载代理
   */
  if (url.pathname === '/api/fetch') {
    try {
      if (!requireKey(req)) return json(res, 401, { status: 'error', text: 'unauthorized' });
      const target = url.searchParams.get('url') || '';
      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return json(res, 400, { status: 'error', text: 'invalid url' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json(res, 400, { status: 'error', text: 'unsupported protocol' });
      }
      if (isPrivateHost(parsed.hostname)) {
        return json(res, 403, { status: 'error', text: 'host not allowed' });
      }
      const headers = { 'User-Agent': UA, Accept: 'video/*,*/*;q=0.8', Referer: buildReferer(parsed) };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await fetch(parsed.toString(), { headers, redirect: 'follow' });
      if (!upstream.ok && upstream.status !== 206) {
        return json(res, 502, { status: 'error', text: `upstream HTTP ${upstream.status}` });
      }
      const out = {
        'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Expose-Headers': 'Content-Length,Content-Disposition',
        'Cache-Control': 'private, max-age=60',
      };
      if (upstream.headers.get('content-length')) out['Content-Length'] = upstream.headers.get('content-length');
      if (upstream.headers.get('content-range')) out['Content-Range'] = upstream.headers.get('content-range');
      const filename = (url.searchParams.get('filename') || parsed.pathname.split('/').pop() || 'video.mp4').slice(0, 100);
      out['Content-Disposition'] =
        `attachment; filename="${filename.replace(/[\r\n"]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      res.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
      return;
    } catch (err) {
      return json(res, 502, { status: 'error', text: String(err?.message || err).slice(0, 300) });
    }
  }

  /**
   * POST /api/storyboard —— 反推分镜（视觉 LLM）
   * body: { url, llmBaseUrl, llmApiKey, llmModel, maxShots?, threshold?, frameWidth?, language?, llmText*? }
   */
  if (url.pathname === '/api/storyboard') {
    try {
      if (req.method !== 'POST') return json(res, 405, { status: 'error', text: 'method not allowed' });
      if (!requireKey(req)) return json(res, 401, { status: 'error', text: 'unauthorized' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { status: 'error', text: 'invalid json body' });
      }
      const target = (body.url || '').trim();
      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });
      let llm;
      try {
        llm = readLlmCfg(body, 'vision');
      } catch (e) {
        return json(res, 400, { status: 'error', text: e.message });
      }
      const dest = tmp('mp4');
      const { meta } = await resolveAndDownload(target, dest);
      try {
        const result = await buildStoryboard(dest, body, llm);
        result.source = { ...result.source, width: meta?.width || 0, height: meta?.height || 0 };
        result.videoMeta = meta;
        return json(res, 200, result);
      } finally {
        await unlink(dest).catch(() => {});
      }
    } catch (err) {
      return json(res, 500, { status: 'error', text: String(err?.message || err).slice(0, 400) });
    }
  }

  /**
   * POST /api/narration —— 完整旁白 / 转写（文本 LLM，优先 llmText*，否则复用视觉配置）
   * body: { url, llmBaseUrl, llmApiKey, llmModel, llmTextBaseUrl?, llmTextApiKey?, llmTextModel?, language? }
   */
  if (url.pathname === '/api/narration') {
    try {
      if (req.method !== 'POST') return json(res, 405, { status: 'error', text: 'method not allowed' });
      if (!requireKey(req)) return json(res, 401, { status: 'error', text: 'unauthorized' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { status: 'error', text: 'invalid json body' });
      }
      const target = (body.url || '').trim();
      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });
      let llm;
      try {
        llm = readLlmCfg(body, 'text');
      } catch (e) {
        return json(res, 400, { status: 'error', text: e.message });
      }
      const dest = tmp('mp4');
      await resolveAndDownload(target, dest);
      try {
        const result = await buildNarration(dest, llm);
        return json(res, 200, result);
      } finally {
        await unlink(dest).catch(() => {});
      }
    } catch (err) {
      return json(res, 500, { status: 'error', text: String(err?.message || err).slice(0, 400) });
    }
  }

  return json(res, 404, { status: 'error', text: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[parser-core] listening on http://0.0.0.0:${PORT}  (requestId demo: ${randomUUID().slice(0, 8)})`);
});
