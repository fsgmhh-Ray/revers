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
        resolve({ ok: true, path: finalPath });
      } else {
        emit(100, false, stderr.trim() || `yt-dlp 退出码 ${code}`);
        reject(new Error(stderr.trim() || `yt-dlp 退出码 ${code}`));
      }
    });
  });
}

async function startDownload(payload, win) {
  const { id, url, sourceUrl, filename, cookieBrowser } = payload;
  if (!url) throw new Error('缺少下载链接');

  // 原始页面链接优先：让 yt-dlp 自己选最佳格式并用 FFmpeg 合并音视频
  const target = isPlatformUrl(sourceUrl) ? sourceUrl : url;
  const dir = defaultDownloadDir();
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

  ipcMain.handle('cineflow:pick-dir', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win || undefined, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

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
  feedState,
  APP_URL,
  VERSION,
};
