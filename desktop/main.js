/**
 * Electron 主进程。
 *
 * 桌面端是整个架构里能力最强的一层：
 *   - 解析/下载都从用户本机发出，出口 IP 是真实住宅 IP；
 *   - yt-dlp 用 --cookies-from-browser 直读本机浏览器登录态，无需导出 Cookie；
 *   - 内置 FFmpeg 可以合并 YouTube 的高清视频流与音频流（1080p+ 画质）；
 *   - 第三阶段（本地抽帧 / 分镜逆向）可直接复用同一套本地算力。
 *
 * 页面侧契约见 src/services/electronBridge.ts。
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('node:electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = process.env.REVERSE_URL || 'https://reverse.cineflowing.com';
const VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* 二进制定位                                                          */
/* ------------------------------------------------------------------ */

const BIN_DIR = path.join(__dirname, 'bin');
const IS_WIN = process.platform === 'win32';

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
    require('node:child_process').execFileSync(which, [name], { stdio: 'ignore' });
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

/** auto 时按优先级挑一个已安装的浏览器 */
function pickBrowser(preferred) {
  const installed = browserCandidates();
  if (preferred && preferred !== 'auto') return preferred;
  const priority = ['chrome', 'edge', 'brave', 'firefox', 'vivaldi', 'safari', 'chromium'];
  return priority.find((b) => installed.includes(b)) || null;
}

function cookieArgs(browser) {
  const picked = pickBrowser(browser);
  return picked ? ['--cookies-from-browser', picked] : [];
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

/** 从 yt-dlp 的 JSON 里挑一条既能预览又能直接下载的直链 */
function pickPreviewUrl(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const withBoth = formats
    .filter((f) => f.url && f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (withBoth.length) return withBoth[0];
  const anyVideo = formats.filter((f) => f.url && f.vcodec && f.vcodec !== 'none').sort((a, b) => (b.height || 0) - (a.height || 0));
  return anyVideo[0] || (info.url ? { url: info.url, height: info.height } : null);
}

async function ytDlpMetadata(url, browser) {
  const out = await runYtDlp(
    ['--no-warnings', '--no-playlist', '--dump-json', ...cookieArgs(browser), url],
    { timeout: 120_000 },
  );
  // 播放列表场景下会输出多行，取第一行
  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
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
  };
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

/* ------------------------------------------------------------------ */
/* 下载管理                                                            */
/* ------------------------------------------------------------------ */

/** id -> { proc, percent, file } */
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

async function startDownload(payload, win) {
  const { id, url, sourceUrl, filename, cookieBrowser } = payload;
  if (!url) throw new Error('缺少下载链接');

  // 原始页面链接优先：让 yt-dlp 自己选最佳格式并用 FFmpeg 合并音视频
  const target = isPlatformUrl(sourceUrl) ? sourceUrl : url;
  const dir = defaultDownloadDir();
  const base = (filename || 'video').replace(/\.mp4$/i, '');
  const output = path.join(dir, `${base}.%(ext)s`);

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '-f',
    'bestvideo+bestaudio/best',
    '--merge-output-format',
    'mp4',
    '-o',
    output,
    ...cookieArgs(cookieBrowser),
    target,
  ];

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
      const entry = downloads.get(id);
      downloads.delete(id);
      if (code === 0) {
        emit(100, true);
        const finalPath = lastFile && fs.existsSync(lastFile) ? lastFile : path.join(dir, `${base}.mp4`);
        resolve({ ok: true, path: finalPath });
      } else {
        const failed = downloads.size === 0;
        emit(100, false, failed ? stderr.trim() || `yt-dlp 退出码 ${code}` : undefined);
        reject(new Error(stderr.trim() || `yt-dlp 退出码 ${code}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 窗口与 IPC                                                          */
/* ------------------------------------------------------------------ */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    title: 'Cineflowing Reverse',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // 外链交给系统浏览器，站内导航留在客户端
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL) || url.includes('cineflowing.com')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
    ytDlp,
    ytDlpVersion: version,
    ffmpeg: binaryExists('ffmpeg'),
    browsers: browserCandidates(),
  };
});

ipcMain.handle('cineflow:parse', async (_event, payload) => {
  try {
    const data = await ytDlpMetadata(payload.url, payload.cookieBrowser);
    return data;
  } catch (err) {
    throw new Error(err?.message || '解析失败');
  }
});

ipcMain.handle('cineflow:download', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    return await startDownload(payload, win);
  } catch (err) {
    return { ok: false, error: err?.message || '下载失败' };
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
  if (!payload?.path) return { ok: false };
  if (fs.existsSync(payload.path)) shell.showItemInFolder(payload.path);
  return { ok: true };
});

ipcMain.handle('cineflow:pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

/* ------------------------------------------------------------------ */
/* 主站长连接：心跳拉取 feed（升级 / 广告 / 推广）+ 连接状态            */
/* ------------------------------------------------------------------ */

const FEED_URL = `${APP_URL}/api/client-feed`;
const feedState = { latest: null, interval: 45_000, timer: null, lastSync: 0, online: false };

async function fetchFeedRemote() {
  const u = new URL(FEED_URL);
  u.searchParams.set('v', VERSION);
  const res = await fetch(u.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return res.json();
}

function broadcastFeed(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cineflow:feed', payload);
  }
}

function broadcastConnection(online) {
  feedState.online = online;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cineflow:connection', { online, at: Date.now() });
  }
}

async function heartbeat() {
  try {
    const data = await fetchFeedRemote();
    feedState.latest = data;
    feedState.lastSync = Date.now();
    if (data?.heartbeatIntervalSec) {
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

app.whenReady().then(() => {
  createWindow();
  startHeartbeat();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
