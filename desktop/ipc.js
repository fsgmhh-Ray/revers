/**
 * 桌面端「能力层」：解析 / 下载 / 主站长连接的全部 IPC 处理器。
 *
 * 拆出来的意义：
 *   - main.js 只负责窗口与生命周期（启动层）；
 *   - smoke.test.js 能直接复用同一份处理器做无头自测，验证的就是真实契约，
 *     而不是另写一套"看起来一样"的假处理器。
 *
 * 注意：Electron 主进程里 require.main 是 undefined，
 * 所以不能用 require.main === module 判定入口，只能靠模块拆分隔离副作用。
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APP_URL, VERSION, BIN_DIR, IS_WIN } = require('./config');

/* ------------------------------------------------------------------ */
/* 二进制定位                                                          */
/* ------------------------------------------------------------------ */

function binName(name) {
  return IS_WIN ? `${name}.exe` : name;
}

function resolveBinary(name) {
  const local = path.join(BIN_DIR, binName(name));
  if (fs.existsSync(local)) return local;
  // 未随包分发时退回到 PATH 查找
  return name;
}

function binaryExists(name) {
  const local = path.join(BIN_DIR, binName(name));
  if (fs.existsSync(local)) return true;
  const which = IS_WIN ? 'where' : 'which';
  try {
    execFileSync(which, [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 让 yt-dlp 能找到同目录的 ffmpeg */
function childEnv() {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const sep = IS_WIN ? ';' : ':';
  env.PATH = `${BIN_DIR}${sep}${env.PATH || ''}`;
  return env;
}

/* ------------------------------------------------------------------ */
/* 本机浏览器登录态探测                                                */
/* ------------------------------------------------------------------ */

function browserCandidates() {
  const home = os.homedir();
  const localAppData = IS_WIN ? process.env.LOCALAPPDATA || '' : '';
  const appData = IS_WIN ? process.env.APPDATA || '' : '';

  const map = [];

  if (IS_WIN) {
    map.push(['chrome', path.join(localAppData, 'Google', 'Chrome', 'User Data')]);
    map.push(['edge', path.join(localAppData, 'Microsoft', 'Edge', 'User Data')]);
    map.push(['brave', path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')]);
    map.push(['vivaldi', path.join(localAppData, 'Vivaldi', 'User Data')]);
    map.push(['firefox', path.join(appData, 'Mozilla', 'Firefox', 'profiles.ini')]);
  } else if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    map.push(['chrome', path.join(support, 'Google', 'Chrome')]);
    map.push(['edge', path.join(support, 'Microsoft Edge')]);
    map.push(['brave', path.join(support, 'BraveSoftware', 'Brave-Browser')]);
    map.push(['vivaldi', path.join(support, 'Vivaldi')]);
    map.push(['firefox', path.join(support, 'Firefox', 'profiles.ini')]);
    map.push(['safari', path.join(home, 'Library', 'Cookies')]);
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    map.push(['chrome', path.join(config, 'google-chrome')]);
    map.push(['chromium', path.join(config, 'chromium')]);
    map.push(['edge', path.join(config, 'microsoft-edge')]);
    map.push(['brave', path.join(config, 'BraveSoftware', 'Brave-Browser')]);
    map.push(['vivaldi', path.join(config, 'vivaldi')]);
    map.push(['firefox', path.join(home, '.mozilla', 'firefox', 'profiles.ini')]);
  }

  return map.filter(([, p]) => p && fs.existsSync(p)).map(([name]) => name);
}

/** 浏览器优先级：Chromium 系登录态最常见，Firefox 的 Cookie 最容易被读取 */
const BROWSER_PRIORITY = ['chrome', 'edge', 'brave', 'firefox', 'vivaldi', 'safari', 'chromium'];

/** 本会话内已知「读不出 Cookie」的浏览器，避免反复踩同一个坑 */
const cookieFailed = new Set();

/**
 * 判断是否属于「Cookie 读取失败」类错误。
 * 典型来源：
 *   - Chrome/Edge 正在运行，SQLite 数据库被锁定；
 *   - Chrome 127+ 的 App-Bound Encryption 导致跨进程解密失败（yt-dlp #7271）；
 *   - 浏览器从未使用过（无 Cookie 库）。
 * 这类错误不该让整个解析失败——降级为不带登录态重试即可。
 */
function isCookieError(message) {
  return /could not copy|failed to decrypt|cookie database|dpapi|cookies-from-browser|no such file.*cookie/i.test(
    String(message || ''),
  );
}

/** auto 时按优先级挑一个已安装、且本会话未失败过的浏览器 */
function pickBrowser(preferred) {
  if (preferred && preferred !== 'auto' && preferred !== 'none') return preferred;
  const installed = browserCandidates();
  return BROWSER_PRIORITY.find((b) => installed.includes(b) && !cookieFailed.has(b)) || null;
}

/** 不考虑失败记忆的挑选（用于展示"本机有哪些浏览器"） */
function pickBrowserAny(preferred) {
  if (preferred && preferred !== 'auto' && preferred !== 'none') return preferred;
  const installed = browserCandidates();
  return BROWSER_PRIORITY.find((b) => installed.includes(b)) || null;
}

/** 当前 Cookie 可用状态快照，供 UI 展示"是否已用上本机登录态" */
function cookieStatus() {
  const installed = browserCandidates();
  return {
    installed,
    usable: installed.filter((b) => !cookieFailed.has(b)),
    failed: [...cookieFailed],
    active: pickBrowser('auto'),
  };
}

/* ------------------------------------------------------------------ */
/* yt-dlp 调用                                                         */
/* ------------------------------------------------------------------ */

function runYtDlp(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveBinary('yt-dlp'), args, { env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp 执行超时'));
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp 退出码 ${code}`));
    });
  });
}

/**
 * 带 Cookie 降级的 yt-dlp 调用。
 *
 * 本机浏览器登录态是桌面端的核心优势，但「读得到 Cookie」并不总能成立
 * （浏览器运行中锁定数据库 / Chrome 127+ App-Bound 加密 / 该浏览器从未登录）。
 * 因此策略是：优先带 Cookie → 命中 Cookie 类错误则记住该浏览器并降级重试。
 * 绝不让 Cookie 读取失败拖垮整个解析——TikTok、直链等场景本就不需要登录态。
 *
 * @returns {Promise<{stdout: string, cookies: string|null, warning: string|null}>}
 */
async function runYtDlpWithCookies(args, browser, opts) {
  const picked = pickBrowser(browser);

  if (!picked) {
    return { stdout: await runYtDlp(args, opts), cookies: null, warning: null };
  }

  try {
    const stdout = await runYtDlp([...args, '--cookies-from-browser', picked], opts);
    return { stdout, cookies: picked, warning: null };
  } catch (err) {
    const message = String((err && err.message) || '');
    if (!isCookieError(message)) throw err;

    cookieFailed.add(picked);
    const warning =
      `无法读取 ${picked} 的 Cookie（${message.split('\n')[0].trim()}），已降级为不带登录态解析`;

    return { stdout: await runYtDlp(args, opts), cookies: null, warning };
  }
}

/** 从 yt-dlp 的 JSON 里挑一条既能预览又能直接下载的直链 */
function pickPreviewUrl(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const withBoth = formats
    .filter((f) => f.url && f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (withBoth.length) return withBoth[0];
  const anyVideo = formats
    .filter((f) => f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  return anyVideo[0] || (info.url ? { url: info.url, height: info.height } : null);
}

function mapExtractor(key) {
  const k = (key || '').toLowerCase();
  if (k.includes('youtube')) return 'youtube';
  if (k.includes('instagram')) return 'instagram';
  if (k.includes('tiktok')) return 'tiktok';
  if (k.includes('douyin')) return 'douyin';
  if (k.includes('xiaohongshu')) return 'xiaohongshu';
  return 'unknown';
}

async function ytDlpMetadata(url, browser) {
  // 非平台直链不需要登录态，跳过 Cookie 尝试可省掉一次无谓的失败重试
  const { stdout, cookies, warning } = await runYtDlpWithCookies(
    ['--no-warnings', '--no-playlist', '--dump-json', url],
    isPlatformUrl(url) ? browser : 'none',
    { timeout: 120_000 },
  );
  // 播放列表场景下会输出多行，取第一行
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('yt-dlp 未返回媒体信息');
  const info = JSON.parse(line);
  const best = pickPreviewUrl(info);

  return {
    id: info.id || `${Date.now()}`,
    originalUrl: info.webpage_url || url,
    platform: mapExtractor(info.extractor_key),
    title: info.title || 'video',
    author: { name: info.uploader || info.channel || info.artist || 'Unknown' },
    duration: Number(info.duration || 0),
    coverUrl: info.thumbnail || '',
    // 下载阶段会重新对原始页面跑 yt-dlp 以拿到合并后的最高画质，
    // 这里只用于页面内预览。
    downloadUrl: best?.url || info.url || url,
    dimensions: info.width ? { width: info.width, height: info.height } : undefined,
    hasWatermark: false,
    provider: 'desktop:yt-dlp',
    fileSize: info.filesize || info.filesize_approx || undefined,
    // 本次是否用上了本机登录态；warning 非空表示已降级（前端可据此提示用户）
    cookieUsed: cookies || null,
    cookieWarning: warning,
  };
}

/* ------------------------------------------------------------------ */
/* 下载管理                                                            */
/* ------------------------------------------------------------------ */

/** id -> { proc, percent } */
const downloads = new Map();

function defaultDownloadDir() {
  const dir = path.join(os.homedir(), 'Downloads', 'Cineflowing');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 失败时退回 Downloads */
    return path.join(os.homedir(), 'Downloads');
  }
  return dir;
}

/**
 * 解析出真正可写的下载目录。
 *
 * 用户选的目录可能已经被删除、是只读盘、或被同步盘占用，所以不能直接信任，
 * 必须 mkdir + 可写探测；失败就依次退回默认目录、系统下载目录。
 * 返回值一定是「存在且可写」的路径，调用方可以放心交给 yt-dlp 的 -o。
 */
function resolveDownloadDir(preferred) {
  const candidates = [];
  if (typeof preferred === 'string' && preferred.trim()) candidates.push(preferred.trim());
  candidates.push(defaultDownloadDir());

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* 该候选不可用，试下一个 */
    }
  }

  // 兜底：系统下载目录通常一定可写；再不济交给系统临时目录
  const fallback = path.join(os.homedir(), 'Downloads');
  try {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return os.tmpdir();
  }
}

function isPlatformUrl(url) {
  return /tiktok\.com|instagram\.com|youtube\.com|youtu\.be|douyin\.com|xiaohongshu\.com/i.test(url || '');
}

function parseProgress(line) {
  // 形如：[download]  42.1% of ~  30.00MiB at   1.20MiB/s ETA 00:14
  const m = /\[download\]\s+([\d.]+)%/.exec(line);
  if (!m) return null;
  return Math.min(100, Math.round(Number(m[1])));
}

/** 起一条下载进程并把进度回传给渲染层 */
function spawnDownload({ id, args, dir, base, win }) {
  const proc = spawn(resolveBinary('yt-dlp'), args, { env: childEnv(), windowsHide: true });
  downloads.set(id, { proc, percent: 0 });

  let stderr = '';
  let lastFile = '';

  return new Promise((resolve, reject) => {
    const emit = (percent, done, error) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('cineflow:download-progress', { id, percent, done, error });
      }
    };

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const pct = parseProgress(line);
        if (pct !== null) {
          const entry = downloads.get(id);
          if (entry) entry.percent = pct;
          emit(pct, false);
        }
        const dest = /\[download\] Destination: (.+)$/.exec(line.trim());
        if (dest) lastFile = dest[1].trim();
        if (line.includes('[Merger] Merging formats into')) {
          lastFile = /into "(.+)"$/.exec(line.trim())?.[1] || lastFile;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      downloads.delete(id);
      reject(err);
    });

    proc.on('close', (code) => {
      downloads.delete(id);
      if (code === 0) {
        emit(100, true);
        const finalPath = lastFile && fs.existsSync(lastFile) ? lastFile : path.join(dir, `${base}.mp4`);
        // 把目录一并回传，前端可以直接显示「文件在哪」并一键打开
        resolve({ ok: true, path: finalPath, dir });
      } else {
        emit(100, false, stderr.trim() || `yt-dlp 退出码 ${code}`);
        reject(new Error(stderr.trim() || `yt-dlp 退出码 ${code}`));
      }
    });
  });
}

async function startDownload(payload, win) {
  const { id, url, sourceUrl, filename, cookieBrowser, dir: preferredDir } = payload;
  if (!url) throw new Error('缺少下载链接');

  // 原始页面链接优先：让 yt-dlp 自己选最佳格式并用 FFmpeg 合并音视频
  const target = isPlatformUrl(sourceUrl) ? sourceUrl : url;
  // 用户设置的目录优先；不可写时自动退回，绝不因为目录问题让下载失败
  const dir = resolveDownloadDir(preferredDir);
  const base = (filename || 'video').replace(/\.mp4$/i, '');
  const output = path.join(dir, `${base}.%(ext)s`);

  const baseArgs = [
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '-f',
    'bestvideo+bestaudio/best',
    '--merge-output-format',
    'mp4',
    '-o',
    output,
  ];

  const picked = pickBrowser(isPlatformUrl(target) ? cookieBrowser : 'none');

  if (picked) {
    try {
      return await spawnDownload({
        id,
        dir,
        base,
        win,
        args: [...baseArgs, '--cookies-from-browser', picked, target],
      });
    } catch (err) {
      // 与解析路径一致的降级策略：Cookie 读不出来就记住该浏览器，去掉登录态重试
      if (!isCookieError(String((err && err.message) || ''))) throw err;
      cookieFailed.add(picked);
    }
  }

  return spawnDownload({ id, dir, base, win, args: [...baseArgs, target] });
}

/* ------------------------------------------------------------------ */
/* Stage 2：分镜逆向（本地 FFmpeg 场景切分 + 关键帧抽取）               */
/* ------------------------------------------------------------------ */

/**
 * Stage 2 的「物理层」：把视频切成镜头、抽关键帧、给出时间轴与剪辑节奏。
 *
 * 为什么放在桌面端而不是云端：抽帧是纯算力活，本机 FFmpeg 免上传、
 * 免带宽、免排队，长视频也不会卡在网络 IO 上。语义层（台词 / 画面描述 /
 * Prompt 逆向）需要多模态大模型，走 `buildStoryboard` 之外的增强通道。
 *
 * 产物结构对齐前端既有契约 StoryboardNode（见 StoryboardDrawer.tsx）。
 */

const STORYBOARD_TMP = path.join(os.tmpdir(), 'cineflow-storyboard');

/** 跑一个 ffmpeg / ffprobe 子进程；stdout 按二进制收集（抽帧可能用到） */
function runFf(bin, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveBinary(bin), args, { env: childEnv(), windowsHide: true });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} 执行超时`));
    }, timeout);

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else {
        const tail = stderr.trim().split('\n').filter(Boolean).pop() || `${bin} 退出码 ${code}`;
        reject(new Error(tail));
      }
    });
  });
}

/** 读取视频基础信息（时长 / 分辨率 / 帧率） */
async function probeMedia(file) {
  const { stdout } = await runFf(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ],
    { timeout: 60_000 },
  );

  let parsed = {};
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch {
    parsed = {};
  }
  const stream = (parsed.streams && parsed.streams[0]) || {};
  const fmt = parsed.format || {};

  let fps = 0;
  if (typeof stream.r_frame_rate === 'string' && stream.r_frame_rate.includes('/')) {
    const [num, den] = stream.r_frame_rate.split('/').map(Number);
    if (num && den) fps = num / den;
  }

  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    fps: Math.round(fps * 100) / 100,
    duration: Number(stream.duration || fmt.duration || 0),
  };
}

/**
 * 场景切分：检测镜头切换时间点。
 *
 * 先 `scale=320:-2` 再算 scene 分数 —— 缩略后再比较帧差，速度快一个数量级，
 * 对"哪一帧是切换点"的判定几乎没有影响（差异是全画面级的）。
 * showinfo 会把每帧信息打到 stderr，从中解析 pts_time 即切换时刻。
 */
async function detectScenes(file, threshold = 0.3) {
  const th = Math.min(0.9, Math.max(0.05, Number(threshold) || 0.3));
  const { stderr } = await runFf(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'info',
      '-i', file,
      '-filter:v', `scale=320:-2,select='gt(scene,${th})',showinfo`,
      '-an',
      '-f', 'null',
      '-',
    ],
    { timeout: 600_000 },
  );

  const cuts = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) cuts.push(t);
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/** 抽某一时刻的帧，返回 data URL（前端可直接塞进 <img src>） */
async function grabFrame(file, atSec, outPath, width = 480) {
  await runFf(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(Math.max(0, atSec)),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      '-y',
      outPath,
    ],
    { timeout: 60_000 },
  );

  if (!fs.existsSync(outPath)) throw new Error('抽帧失败：未生成图像');
  const buf = fs.readFileSync(outPath);
  if (!buf.length) throw new Error('抽帧失败：图像为空');
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * 没有语义模型时的镜头类型推断。
 * 依据是剪辑时长——快切通常是特写/情绪镜头，长镜多为全景或空镜。
 * 标注 inferred=true，UI 上明确区分「推断」与「AI 识别」。
 */
function inferShotType(seconds) {
  if (seconds < 1.2) return '特写(CU)';
  if (seconds < 2.5) return '近景(MCU)';
  if (seconds < 5) return '中景(MS)';
  return '全景(WS)';
}

function inferCamera(seconds) {
  if (seconds < 0.8) return '快切(Cut)';
  if (seconds < 4) return '固定(Static)';
  return '缓推(Slow push)';
}

/** 把过密的切点抽稀到 maxShots 以内，保持时间上的均匀覆盖 */
function thinEdges(edges, maxShots) {
  if (edges.length - 1 <= maxShots) return edges;
  const keep = [edges[0]];
  const step = (edges.length - 1) / maxShots;
  for (let k = 1; k < maxShots; k++) keep.push(edges[Math.round(k * step)]);
  keep.push(edges[edges.length - 1]);
  return [...new Set(keep)];
}

/**
 * 主入口：视频 → 分镜节点数组。
 *
 * @param {{ id: string, path: string, sceneThreshold?: number, maxShots?: number, frameWidth?: number }} payload
 */
async function buildStoryboard(payload, win) {
  const {
    id = `sb_${Date.now()}`,
    path: file,
    sceneThreshold = 0.3,
    maxShots = 48,
    frameWidth = 480,
  } = payload || {};

  if (!file || !fs.existsSync(file)) {
    throw new Error('找不到本地视频文件，请先下载到本机再拆解');
  }

  const send = (percent, stage) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('cineflow:storyboard-progress', { id, percent, stage });
    }
  };

  send(2, '读取媒体信息');
  const media = await probeMedia(file);
  const duration = media.duration || 0;

  send(12, '场景切分');
  const cuts = await detectScenes(file, sceneThreshold);

  // 边界：起点 + 切点 + 终点；过滤掉过近的切点，避免产生 0.1s 的碎片镜头
  const raw = [0, ...cuts.filter((t) => !duration || t < duration - 0.15), duration || cuts[cuts.length - 1] + 1];
  const edges = raw.filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.25);
  const finalEdges = thinEdges(edges, Math.max(1, maxShots));

  const dir = path.join(STORYBOARD_TMP, String(id).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });

  const shotCount = Math.max(0, finalEdges.length - 1);
  const nodes = [];

  for (let i = 0; i < shotCount; i++) {
    const startMs = Math.round(finalEdges[i] * 1000);
    const endMs = Math.round(finalEdges[i + 1] * 1000);
    const seconds = (endMs - startMs) / 1000;
    const mid = (finalEdges[i] + finalEdges[i + 1]) / 2;

    // 抽帧占整体进度的大头（12% → 96%）
    send(12 + Math.round(((i + 0.5) / shotCount) * 84), `抽取关键帧 ${i + 1}/${shotCount}`);

    let thumbnailDataUrl = '';
    try {
      thumbnailDataUrl = await grabFrame(file, mid, path.join(dir, `f${i}.jpg`), frameWidth);
    } catch {
      // 单帧抽失败（损坏段 / 极短镜头）不该让整个拆解失败
      thumbnailDataUrl = '';
    }

    nodes.push({
      id: `${id}_${i}`,
      index: i + 1,
      startTime: startMs,
      endTime: endMs,
      duration: Math.round(seconds * 1000),
      thumbnailUrl: thumbnailDataUrl,
      shotType: inferShotType(seconds),
      cameraMovement: inferCamera(seconds),
      dialogue: '',
      visualDescription: '',
      aiPrompt: { imagePrompt: '', videoPrompt: '' },
      inferred: true,
    });
  }

  send(98, '汇总');
  const avgShot = shotCount ? duration / shotCount : 0;
  const cutRhythm = avgShot < 1.5 ? '快剪（平均 < 1.5s）' : avgShot < 3 ? '中速（平均 1.5–3s）' : '慢节奏（平均 > 3s）';

  return {
    ok: true,
    id,
    source: {
      file,
      duration: Math.round(duration * 1000),
      width: media.width,
      height: media.height,
      fps: media.fps,
    },
    nodes,
    stats: {
      sceneCount: shotCount,
      sceneThreshold: Math.min(0.9, Math.max(0.05, Number(sceneThreshold) || 0.3)),
      avgShotDuration: Math.round(avgShot * 1000),
      cutRhythm,
      analyzedBy: 'local-ffmpeg',
      note: '镜头类型/运镜由剪辑时长推断，台词与画面描述需接入多模态模型补全',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

/**
 * 装机自检：验证打包后能否真正定位并执行随包分发的二进制。
 *
 * 打包场景下最容易踩的坑是「二进制被塞进 app.asar 导致 spawn ENOENT」，
 * 而这个问题在开发环境永远不会暴露。此函数专门用来在真实安装包里验证。
 */
async function selfCheck() {
  const ytDlpPath = resolveBinary('yt-dlp');
  const ffmpegPath = resolveBinary('ffmpeg');
  const ytDlp = binaryExists('yt-dlp');
  const ffmpeg = binaryExists('ffmpeg');

  let ytDlpVersion = null;
  let error = null;
  if (ytDlp) {
    try {
      ytDlpVersion = (await runYtDlp(['--version'], { timeout: 20_000 })).trim();
    } catch (err) {
      error = String((err && err.message) || err);
    }
  }

  return {
    ok: Boolean(ytDlp && ffmpeg && ytDlpVersion),
    version: VERSION,
    appUrl: APP_URL,
    binDir: BIN_DIR,
    packed: __dirname.includes('app.asar'),
    ytDlp,
    ytDlpPath,
    ytDlpVersion,
    ffmpeg,
    ffmpegPath,
    browsers: browserCandidates(),
    cookies: cookieStatus(),
    error,
  };
}

/* ------------------------------------------------------------------ */
/* 主站长连接：心跳拉取 feed（升级 / 广告 / 推广）+ 连接状态            */
/* ------------------------------------------------------------------ */

const FEED_URL = `${APP_URL}/api/client-feed`;
const feedState = { latest: null, interval: 45_000, timer: null, lastSync: 0, online: false };

let getWindow = () => null;

async function fetchFeedRemote() {
  const u = new URL(FEED_URL);
  u.searchParams.set('v', VERSION);
  const res = await fetch(u.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return res.json();
}

function send(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcastFeed(payload) {
  send('cineflow:feed', payload);
}

function broadcastConnection(online) {
  feedState.online = online;
  send('cineflow:connection', { online, at: Date.now() });
}

async function heartbeat() {
  try {
    const data = await fetchFeedRemote();
    feedState.latest = data;
    feedState.lastSync = Date.now();
    if (data && data.heartbeatIntervalSec) {
      feedState.interval = Math.max(15, data.heartbeatIntervalSec) * 1000;
    }
    broadcastFeed(data);
    broadcastConnection(true);
  } catch {
    broadcastConnection(false);
  }
}

function startHeartbeat() {
  if (feedState.timer) clearInterval(feedState.timer);
  heartbeat();
  feedState.timer = setInterval(heartbeat, feedState.interval);
}

function stopHeartbeat() {
  if (feedState.timer) {
    clearInterval(feedState.timer);
    feedState.timer = null;
  }
}

/* ------------------------------------------------------------------ */
/* IPC 注册                                                            */
/* ------------------------------------------------------------------ */

let registered = false;

/**
 * 注册全部 IPC 处理器。幂等——重复调用不会重复注册（ipcMain.handle 重复注册会抛错）。
 * @param {{ getWindow?: () => import('electron').BrowserWindow | null }} opts
 */
function registerIpcHandlers(opts = {}) {
  if (typeof opts.getWindow === 'function') getWindow = opts.getWindow;
  if (registered) return;
  registered = true;

  ipcMain.handle('cineflow:hello', async () => {
    const ytDlp = binaryExists('yt-dlp');
    let version = null;
    if (ytDlp) {
      try {
        version = (await runYtDlp(['--version'], { timeout: 20_000 })).trim();
      } catch {
        version = null;
      }
    }
    return {
      version: VERSION,
      runtime: 'electron',
      ytDlp,
      ytDlpVersion: version,
      ffmpeg: binaryExists('ffmpeg'),
      browsers: browserCandidates(),
      // Cookie 可用性：browsers 是"装了哪些"，cookies 是"哪些真的能读出来"
      cookies: cookieStatus(),
    };
  });

  ipcMain.handle('cineflow:parse', async (_event, payload) => {
    try {
      return await ytDlpMetadata(payload.url, payload.cookieBrowser);
    } catch (err) {
      throw new Error(err && err.message ? err.message : '解析失败');
    }
  });

  ipcMain.handle('cineflow:download', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      return await startDownload(payload, win);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '下载失败' };
    }
  });

  ipcMain.handle('cineflow:cancel', async (_event, payload) => {
    const entry = downloads.get(payload.id);
    if (entry) {
      entry.proc.kill('SIGTERM');
      downloads.delete(payload.id);
    }
    return { ok: true };
  });

  ipcMain.handle('cineflow:reveal', async (_event, payload) => {
    if (!payload || !payload.path) return { ok: false };
    if (fs.existsSync(payload.path)) shell.showItemInFolder(payload.path);
    return { ok: true };
  });

  ipcMain.handle('cineflow:storyboard', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      return await buildStoryboard(payload, win);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '分镜拆解失败' };
    }
  });

  ipcMain.handle('cineflow:pick-dir', async (_event, payload) => {
    const win = getWindow();
    // 从当前生效目录开始浏览，而不是每次从"文档"这种无关位置起步
    const startIn = resolveDownloadDir(payload && payload.current);
    const res = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: startIn,
      title: '选择视频下载目录',
      buttonLabel: '用这个目录',
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('cineflow:default-dir', async () => ({
    dir: defaultDownloadDir(),
    effective: resolveDownloadDir(null),
  }));

  ipcMain.handle('cineflow:feed', async () => {
    if (feedState.latest) return feedState.latest;
    try {
      const data = await fetchFeedRemote();
      feedState.latest = data;
      feedState.lastSync = Date.now();
      return data;
    } catch {
      return null;
    }
  });

  ipcMain.handle('cineflow:feed-state', async () => ({
    online: feedState.online,
    lastSync: feedState.lastSync,
    interval: feedState.interval,
  }));

  // 跟随系统网络状态变化
  try {
    app.on('online', () => broadcastConnection(true));
    app.on('offline', () => broadcastConnection(false));
  } catch {
    /* 部分 Electron 版本未暴露该事件，忽略即可 */
  }
}

module.exports = {
  registerIpcHandlers,
  startHeartbeat,
  stopHeartbeat,
  heartbeat,
  selfCheck,
  // 导出给自测脚本做断言
  browserCandidates,
  pickBrowser,
  pickBrowserAny,
  cookieStatus,
  isCookieError,
  resolveBinary,
  binaryExists,
  defaultDownloadDir,
  resolveDownloadDir,
  // Stage 2 分镜逆向（供自测断言）
  buildStoryboard,
  probeMedia,
  detectScenes,
  grabFrame,
  inferShotType,
  thinEdges,
  STORYBOARD_TMP,
  feedState,
  APP_URL,
  VERSION,
};
