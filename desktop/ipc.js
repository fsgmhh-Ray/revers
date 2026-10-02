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

/* ------------------------------------------------------------------ */
/* 显式导入的 cookies.txt（唯一稳定的登录态通道）                       */
/* ------------------------------------------------------------------ */

/**
 * 为什么必须有这条路。
 *
 * `--cookies-from-browser` 在 Windows + Chrome 127+ 上是**双重死锁**：
 *   ① Chrome 运行期间独占锁定 Cookies 数据库，yt-dlp 连复制都失败
 *      （报 "Could not copy Chrome cookie database"，yt-dlp #7271）；
 *   ② 即使复制出来也白搭 —— Local State 里存在 app_bound_encrypted_key，
 *      说明启用了 App-Bound 加密，密文无法在浏览器进程外解开。
 * 关掉浏览器只能绕过 ①，绕不过 ②。
 *
 * 因此对"需要登录态的内容"（TikTok 短剧 / 限区内容 / 年龄限制等），
 * 让用户用一个浏览器扩展导出 Netscape 格式的 cookies.txt，是最靠得住的办法。
 */
function resolveCookieFile(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const p = file.trim();
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return null;
    return p;
  } catch {
    return null;
  }
}

/** 校验是不是可用的 Netscape cookies.txt，并数出 Cookie 条目 */
function inspectCookieFile(file) {
  const p = resolveCookieFile(file);
  if (!p) return { ok: false, count: 0, error: '文件不存在或为空' };
  try {
    const text = fs.readFileSync(p, 'utf8');
    const count = text
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return Boolean(t) && !t.startsWith('#') && t.includes('\t');
      }).length;
    if (!count) return { ok: false, count: 0, error: '不像 Netscape 格式的 Cookie 文件（没有 Cookie 行）' };
    return {
      ok: true,
      count,
      path: p,
      // 有 TikTok 的 Cookie 才谈得上给短剧解锁
      hasTikTok: /(^|\.)tiktok\.com/m.test(text),
    };
  } catch (err) {
    return { ok: false, count: 0, error: String((err && err.message) || err) };
  }
}

/* ------------------------------------------------------------------ */
/* 报错翻译                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把 yt-dlp 的原始报错翻译成「用户能据以行动」的说明。
 *
 * yt-dlp 的文案是写给开发者看的（"No video formats found!"），
 * 原样丢到界面上等于什么都没说 —— 用户既不知道是自己的问题还是内容的问题，
 * 也不知道下一步该做什么。这里按已知失败模式补上原因与建议。
 */
function describeYtDlpError(rawMessage, { url = '', cookieWarning = null } = {}) {
  const raw = String(rawMessage || '').trim();
  const first = raw.split('\n').find((l) => l.trim()) || '解析失败';
  const isTikTok = /tiktok/i.test(url);

  let title = '解析失败';
  let reasons = [];
  let advice = [];

  if (/no video formats found/i.test(raw)) {
    if (isTikTok) {
      title = 'TikTok 没有返回可播放地址';
      reasons = [
        '该内容多半是短剧 / 限免付费剧集，TikTok 只把播放地址发给"有权限的账号"',
        '也可能受地区限制，或该集已下架/被审核',
      ];
    } else {
      title = '服务端没有返回可播放地址';
      reasons = ['内容可能已下架、需要登录，或对当前地区不可见'];
    }
    advice = [
      cookieWarning
        ? '本机浏览器登录态读取失败（见下方说明），可在「设置 → 登录态」导入 cookies.txt 后重试'
        : '若该内容需要登录，请在「设置 → 登录态」导入已登录的 cookies.txt 后重试',
      '同一部短剧换个"免费试看"集数试试，限免内容通常只有前几集可匿名获取',
      '也可换其它来源（抖音 / YouTube 上的同剧）',
    ];
  } else if (/could not copy|failed to decrypt|dpapi|cookie database/i.test(raw)) {
    title = '读不到浏览器里的登录态';
    reasons = [
      'Chrome / Edge 运行时独占锁定了 Cookie 数据库，或启用了 App-Bound 加密（Chrome 127+），密文无法在浏览器外解开',
    ];
    advice = ['在「设置 → 登录态」导入浏览器扩展导出的 cookies.txt，比读浏览器数据库可靠得多'];
  } else if (/video unavailable|not available in your country|removed|no longer exists|404/i.test(raw)) {
    title = '该内容已下架或对当前地区不可见';
    reasons = ['服务端明确返回"不可用"，通常不是本机问题'];
    advice = ['换一个链接，或使用对应地区的网络环境'];
  } else if (/login required|sign in|private video|age.?restricted|confirm you'?re not a bot|please log in/i.test(raw)) {
    title = '该内容需要登录后才能访问';
    reasons = ['平台要求登录态，匿名请求被拒'];
    advice = ['在「设置 → 登录态」导入已登录该平台的 cookies.txt 后重试'];
  } else if (/http error 403|forbidden/i.test(raw)) {
    title = '直链被拒绝（403）';
    reasons = ['媒体直链通常带时效签名与防盗链校验，过期或被限制来源会直接 403'];
    advice = ['重新解析一次拿到新直链；下载交给桌面端，它会回到原始页面重新取流'];
  } else if (/unsupported url/i.test(raw)) {
    title = '这个链接不被支持';
    reasons = ['链接形态不完整，或是 yt-dlp 尚未支持的站点'];
    advice = ['用平台里的"分享 → 复制链接"重新取一次地址'];
  } else if (/unable to download webpage|failed to resolve|getaddrinfo|timed out|temporary failure|connection/i.test(raw)) {
    title = '网络请求失败';
    reasons = ['无法访问平台页面，可能是网络不通、DNS 异常或需要代理'];
    advice = ['确认本机能正常打开该平台网页后重试'];
  }

  const lines = [title];
  for (const r of reasons) lines.push(`· ${r}`);
  for (const a of advice) lines.push(`→ ${a}`);
  if (cookieWarning) lines.push(`⚠ ${cookieWarning}`);
  lines.push(`（yt-dlp: ${first}）`);
  return lines.join('\n');
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
async function runYtDlpWithCookies(args, browser, opts = {}) {
  // 导入的 cookies.txt 优先：它绕开了浏览器数据库锁定与 App-Bound 加密两重障碍
  const file = resolveCookieFile(opts.cookieFile);
  if (file) {
    const stdout = await runYtDlp([...args, '--cookies', file], opts);
    return { stdout, cookies: 'file', warning: null };
  }

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

    try {
      return { stdout: await runYtDlp(args, opts), cookies: null, warning };
    } catch (retryErr) {
      // 降级后依然失败：把"登录态没拿到"这层事实附在错误上，
      // 否则用户只会看到一句无头无尾的 yt-dlp 原文，无从判断该做什么
      if (retryErr && typeof retryErr === 'object') retryErr.cookieWarning = warning;
      throw retryErr;
    }
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

async function ytDlpMetadata(url, browser, cookieFile) {
  // 非平台直链不需要登录态，跳过 Cookie 尝试可省掉一次无谓的失败重试
  const needsLogin = isPlatformUrl(url);
  const { stdout, cookies, warning } = await runYtDlpWithCookies(
    ['--no-warnings', '--no-playlist', '--dump-json', url],
    needsLogin ? browser : 'none',
    { timeout: 120_000, cookieFile: needsLogin ? cookieFile : null },
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
  const { id, url, sourceUrl, filename, cookieBrowser, cookieFile, dir: preferredDir } = payload;
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

  const loginTarget = isPlatformUrl(target);
  const cookieFilePath = loginTarget ? resolveCookieFile(cookieFile) : null;

  // 导入的 cookies.txt 优先（理由同 runYtDlpWithCookies）
  if (cookieFilePath) {
    try {
      return await spawnDownload({
        id,
        dir,
        base,
        win,
        args: [...baseArgs, '--cookies', cookieFilePath, target],
      });
    } catch (err) {
      // Cookie 文件过期/失效不该让下载直接失败，退回匿名再试一次
      if (!/cookie/i.test(String((err && err.message) || ''))) throw err;
    }
  }

  const picked = pickBrowser(loginTarget ? cookieBrowser : 'none');

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
/* OpenAI 兼容端点规范化                                               */
/* ------------------------------------------------------------------ */

/**
 * 把用户填的 Base URL 归一化成 `…/v1` 形态。
 *
 * 为什么必须归一化（实测踩过）：用户把 Base URL 写成
 * `https://integrate.api.nvidia.com/v1/`（**末尾带斜线**，这是复制浏览器地址栏的
 * 最常见形态），若只用 `endsWith('/v1')` 判断，末尾斜线会让判断落空，于是拼成
 * `…/v1//v1/chat/completions` → 供应商返回 404，用户看到「端点不存在」却查不出原因。
 * 反过来，用户把**完整端点**（`…/v1/chat/completions`）粘进来，也会拼出双份路径。
 *
 * 处理顺序：去空白 → 去尾斜线 → 补协议 → 剥掉误粘的端点路径 → 补 /v1。
 * 这样下面四种写法都能得到同一个结果：
 *   https://integrate.api.nvidia.com/v1/
 *   https://integrate.api.nvidia.com/v1
 *   integrate.api.nvidia.com/v1
 *   https://integrate.api.nvidia.com/v1/chat/completions
 */
function normalizeBaseUrl(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  // 用户常只填 host（忘写协议）——补上 https:// 而不是直接报「解析失败」
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  // 剥掉误粘进来的端点路径（含 /v1 之后的尾巴）
  b = b.replace(/\/(chat\/completions|completions|audio\/transcriptions|audio\/translations|models)$/i, '');
  b = b.replace(/\/+$/, '');
  // 版本段收尾（/v1、/openai/v1、/v1beta 等）才算合法根；否则补 /v1
  if (!/\/v\d+[a-z]*$/i.test(b)) b = `${b}/v1`;
  return b;
}

/** 规范化 Base URL + 拼端点路径；语法错误时抛出人类可读的原因 */
function apiEndpoint(rawBase, endpointPath) {
  const base = normalizeBaseUrl(rawBase);
  if (!base) throw new Error('缺少 Base URL');
  const url = `${base}${endpointPath}`;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`Base URL 无法识别：${String(rawBase || '').trim()}（应形如 https://api.groq.com/openai/v1）`);
  }
  return url;
}

/** 带超时的 fetch —— 供应商冷启动/挂死时不能把整条流水线一起拖住 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 120_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted || /abort/i.test(String((err && err.name) || err))) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）——供应商可能正在冷启动，或网络被拦`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * 跑一个 ffmpeg / ffprobe 子进程；stdout 按二进制收集（抽帧可能用到）。
 *
 * onStdout/onStderr 是「流式钩子」，给长任务用来实时解析进度
 * （例如场景切分要让用户看到百分比，而不是盯着一个不动的文案等一分钟）。
 */
function runFf(bin, args, { timeout = 300_000, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveBinary(bin), args, { env: childEnv(), windowsHide: true });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} 执行超时`));
    }, timeout);

    proc.stdout.on('data', (c) => {
      chunks.push(c);
      if (onStdout) {
        try {
          onStdout(c.toString());
        } catch {
          /* 进度回调失败不影响主流程 */
        }
      }
    });
    proc.stderr.on('data', (c) => {
      const text = c.toString();
      stderr += text;
      if (onStderr) {
        try {
          onStderr(text);
        } catch {
          /* 同上 */
        }
      }
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
 *
 * 为什么必须回传进度：这一步是整条流水线最慢的环节（实测 4K AV1 的 5:51 视频
 * 要 56 秒，长视频更久），期间 UI 只显示一句固定文案会让人以为卡死了。
 * 用 `-nostats -progress pipe:1` 让 ffmpeg 把处理时间写到 stdout（顺便关掉 stderr
 * 上每帧一行的统计刷屏，减少 IO），据此换算百分比。
 *
 * @param {string} file
 * @param {number} threshold  场景切换阈值
 * @param {(processedSeconds: number) => void} [onProgress] 已处理的视频时间（秒）
 */
async function detectScenes(file, threshold = 0.3, onProgress) {
  const th = Math.min(0.9, Math.max(0.05, Number(threshold) || 0.3));
  const { stderr } = await runFf(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'info',
      '-nostats',
      '-progress', 'pipe:1',
      '-i', file,
      '-filter:v', `scale=320:-2,select='gt(scene,${th})',showinfo`,
      '-an',
      '-f', 'null',
      '-',
    ],
    {
      timeout: 900_000,
      onStdout: onProgress
        ? (text) => {
            // -progress 每行形如 out_time=00:00:12.345678
            const m = /out_time=(\d+):(\d+):([\d.]+)/.exec(text);
            if (!m) return;
            const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
            if (sec > 0) onProgress(sec);
          }
        : undefined,
    },
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
    llmBaseUrl,
    llmApiKey,
    llmModel,
    language,
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

  // 场景切分是最慢的一步（4K AV1 约 10~12 秒/分钟素材）。把 ffmpeg 的处理进度
  // 换算成百分比回传，避免用户盯着不动的文案误以为卡死。
  const sceneStart = Date.now();
  const sceneTick = (processedSec) => {
    const ratio = duration > 0 ? Math.min(1, processedSec / duration) : 0;
    const pct = Math.round(ratio * 100);
    const elapsed = Math.round((Date.now() - sceneStart) / 1000);
    send(2 + Math.round(ratio * 10), `场景切分 ${pct}%（已处理 ${processedSec.toFixed(0)}s / 用时 ${elapsed}s）`);
  };
  send(2, duration ? `场景切分 0%（共 ${Math.round(duration)}s 素材）` : '场景切分 0%');
  const cuts = await detectScenes(file, sceneThreshold, duration > 0 ? sceneTick : undefined);

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
  // 视觉 LLM 补全画面描述与提示词（可选；未配则保持纯本地抽帧结果）
  let llmEnriched = 0;
  let llmUsed = false;
  let llmError = '';
  if (llmBaseUrl && llmModel && shotCount) {
    try {
      const r = await enrichStoryboardWithLLM({
        nodes,
        llm: { llmBaseUrl, llmApiKey, llmModel },
        language,
        send,
        maxShots,
      });
      llmEnriched = r.enriched;
      llmUsed = !r.skipped;
      // 关键：以前这里的失败被 catch{} 完全吞掉，用户只看到「提示词是空的」却不知道为什么。
      // 现在把首个失败原因带回去，让 UI 能直接告诉用户是 URL 错、Key 错还是超时。
      llmError = r.error || '';
    } catch (err) {
      llmUsed = false;
      llmError = String((err && err.message) || err);
    }
  }

  // 关键帧已内联成 data URL，临时目录留着只是垃圾（长期会堆满 %TEMP%）：
  // 先扫掉历史遗留，再删本次的目录。
  sweepStoryboardTmp(dir);

  let note;
  if (!llmUsed) {
    note = '镜头类型/运镜由剪辑时长推断；未配置视觉 LLM，台词与画面描述为空（可在 LLM 配置里填视觉 LLM 补全）';
  } else if (llmEnriched === 0) {
    note = `视觉 LLM 未能补全任何镜头，画面描述与提示词为空。原因：${llmError || '未知（可在 LLM 配置里点「测试」核对）'}`;
  } else {
    note = `镜头类型/运镜由剪辑时长推断；${llmEnriched}/${shotCount} 个镜头已由视觉 LLM 补全画面描述与提示词${
      llmError ? `（部分帧失败：${llmError}）` : ''
    }`;
  }

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
      analyzedBy: llmEnriched ? `local-ffmpeg+llm(${llmEnriched}/${shotCount})` : 'local-ffmpeg',
      llmError: llmError || undefined,
      note,
    },
  };
}

/**
 * 清理抽帧临时目录：只删「已经跑完的本次目录」与「超过 6 小时的历史遗留」。
 * 用 mtime 判断，避免误删正在并发跑的另一个任务的目录。
 */
function sweepStoryboardTmp(currentDir, maxAgeMs = 6 * 3600 * 1000) {
  let entries = [];
  try {
    entries = fs.readdirSync(STORYBOARD_TMP);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(STORYBOARD_TMP, name);
    if (p === currentDir) continue;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      if (Date.now() - st.mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
  if (currentDir) {
    try {
      fs.rmSync(currentDir, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 送进视觉 LLM 的关键帧上限。
 *
 * 为什么要封顶：大模型（尤其 NVIDIA 上 90B 级别的视觉模型）单次冷启动实测要
 * **76 秒**，串行跑 20 多帧就是一小时的等待，用户只会以为卡死。
 * 封顶 + 并发后，最坏情况也被限制在几分钟内，且多抽的帧照样有缩略图。
 */
const LLM_MAX_FRAMES = 12;
/** 视觉 LLM 单次调用超时：冷启动可到 80s 量级，留足余量但不允许无限等 */
const VISION_CALL_TIMEOUT_MS = 150_000;

/**
 * 用视觉 LLM 补全分镜的画面描述与提示词（本地执行，请求从本机 IP 发出）。
 *
 * 复用 buildStoryboard 已抽好的关键帧（data URL），不再重复抽帧。
 * NVIDIA 免费端点每请求仅接受 1 张图，因此逐帧调用后再合并。
 * 任一帧失败不影响其余帧，保证「有多少算多少」；但会记录首个失败原因上浮给用户。
 */
async function enrichStoryboardWithLLM({ nodes, llm, language, send, maxShots }) {
  const model = String(llm.llmModel || '').trim();
  if (!String(llm.llmBaseUrl || '').trim() || !model) return { enriched: 0, skipped: true };

  // 归一化后再拼端点：修掉用户 Base URL 末尾带斜线 / 误粘完整端点导致的 404
  const endpoint = apiEndpoint(llm.llmBaseUrl, '/chat/completions');
  const isNvidia = /nvidia/i.test(String(llm.llmBaseUrl));

  // 帧数太多时按镜头间隔取样，避免一次请求过大、时间过长
  const budget = Math.min(LLM_MAX_FRAMES, Math.max(1, maxShots || LLM_MAX_FRAMES));
  const step = Math.max(1, Math.ceil(nodes.length / budget));
  const targets = nodes.filter((node, i) => i % step === 0 && node?.thumbnailUrl).slice(0, LLM_MAX_FRAMES);

  let enriched = 0;
  let done = 0;
  let firstError = '';
  const started = Date.now();

  // 并发 2：NVIDIA 免费端点对并发敏感，2 路既压住等待又不容易触发 429。
  const worker = async () => {
    for (;;) {
      const node = targets.shift();
      if (!node) return;
      try {
        const content = await callVisionEndpoint({
          endpoint,
          apiKey: llm.llmApiKey,
          model,
          frame: node.thumbnailUrl,
          language,
          isNvidia,
        });
        if (content) {
          node.visualDescription = content.visualDescription || node.visualDescription;
          node.dialogue = content.dialogue || node.dialogue;
          node.aiPrompt = {
            imagePrompt: content.imagePrompt || '',
            videoPrompt: content.videoPrompt || '',
          };
          enriched += 1;
        }
      } catch (err) {
        if (!firstError) firstError = String((err && err.message) || err).slice(0, 200);
      } finally {
        done += 1;
        if (send) {
          const elapsed = Math.round((Date.now() - started) / 1000);
          // 用已完成数估算剩余时间，让长等待「看得见」
          const eta = done ? Math.round((elapsed / done) * (targets.length + 1)) : 0;
          send(
            Math.min(97, 50 + Math.round((done / Math.max(1, done + targets.length || 1)) * 46)),
            `AI 反推提示词 ${done}/${done + targets.length}（用时 ${elapsed}s${eta > elapsed ? `，约剩 ${eta - elapsed}s` : ''}）`,
          );
        }
      }
    }
  };

  await Promise.all([worker(), worker()]);
  return { enriched, skipped: false, error: firstError };
}

/**
 * LLM 配置连通性自测（桌面端直连，不受浏览器 CORS 限制）。
 *
 * 为什么必须有这个：NVIDIA 等 API 的 CORS 预检响应里没有
 * `Access-Control-Allow-Origin`，浏览器直接 fetch 必然 "Failed to fetch"，
 * 但服务端（桌面端/内核）调用完全正常。所以「测试按钮」在桌面端要走后端通道，
 * 否则用户会误以为自己的配置有问题。
 *
 * kind: 'vision' → 打 /v1/chat/completions（最小文本请求）
 *       'text'   → 打 /v1/audio/transcriptions（0.2s 静音 WAV）
 */
async function testLlmConfig({ kind, baseUrl, apiKey, model }) {
  const rawBase = String(baseUrl || '').trim();
  const m = String(model || '').trim();
  if (!rawBase) return { ok: false, message: '未填 Base URL' };
  if (!m) return { ok: false, message: '未填 Model' };

  let url;
  let normalized;
  try {
    url = kind === 'text' ? apiEndpoint(rawBase, '/audio/transcriptions') : apiEndpoint(rawBase, '/chat/completions');
    normalized = normalizeBaseUrl(rawBase);
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err) };
  }

  // 把规范化结果一并回报：用户一眼能看出「我填的」与「实际请求的」差在哪
  const note = normalized !== rawBase.replace(/\/+$/, '') ? `（已自动规范为 ${normalized}）` : '';
  const started = Date.now();
  const timeout = kind === 'text' ? 90_000 : VISION_CALL_TIMEOUT_MS;

  try {
    if (kind === 'text') {
      // 44 字节 WAV 头 + 3200 字节静音（0.2s @16k mono）
      const header = Buffer.alloc(44);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(36 + 3200, 4);
      header.write('WAVE', 8, 'ascii');
      header.write('fmt ', 12, 'ascii');
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(16000, 24);
      header.writeUInt32LE(32000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36, 'ascii');
      header.writeUInt32LE(3200, 40);
      const audio = Buffer.concat([header, Buffer.alloc(3200)]);

      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'probe.wav');
      form.append('model', m);
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, body: form },
        timeout,
      );
      const ms = Date.now() - started;
      if (res.ok) return { ok: true, message: `可用（${ms}ms，探针音频无内容属正常）${note}` };
      const t = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Key 无效或无权限（401/403）${note}` };
      if (res.status === 404) {
        return { ok: false, message: `该端点不存在（404）——此供应商可能不支持音频转写${note} 返回：${t.slice(0, 100)}` };
      }
      return { ok: false, message: `HTTP ${res.status}：${t.slice(0, 140)}${note}` };
    }

    // vision：最小文本请求
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      },
      timeout,
    );
    const ms = Date.now() - started;
    if (res.ok) {
      // 90B 级别的视觉模型冷启动实测要 76 秒，慢不等于坏——把预期讲清楚
      const slow = ms > 20_000 ? `，首次调用约 20–80s 属冷启动正常现象` : '';
      return { ok: true, message: `可用（${ms}ms${slow}）${note}` };
    }
    const t = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Key 无效或无权限（401/403）${note}` };
    if (res.status === 404) {
      // NVIDIA 对「模型名不存在」也回 404，且响应体只有一句 "404 page not found"，
      // 所以不能只怪 URL——两种可能都要说清楚，并把上游原文带出来。
      return {
        ok: false,
        message:
          `404：路径或模型名不对${note}。请核对 Base URL 与 Model（NVIDIA 的模型名形如 meta/llama-3.2-11b-vision-instruct）。` +
          ` 上游返回：${t.slice(0, 100) || '(空)'}`,
      };
    }
    if (res.status === 429) return { ok: false, message: `速率限制或额度用尽（429）${note}` };
    return { ok: false, message: `HTTP ${res.status}：${t.slice(0, 140)}${note}` };
  } catch (err) {
    return { ok: false, message: `连接失败：${String((err && err.message) || err)}${note}` };
  }
}

async function callVisionEndpoint({ endpoint, apiKey, model, frame, language, isNvidia }) {
  const messages = [
    {
      role: 'system',
      content:
        '你是专业影视分镜师。看图后输出 JSON，字段：' +
        'visualDescription（中文画面描述，40字内）、dialogue（画面中的人物台词，无则空串）、' +
        'imagePrompt（英文图像提示词，逗号分隔，40词内）、videoPrompt（英文视频运镜提示词，30词内）。' +
        '只输出 JSON，不要任何解释。',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: language ? `请用${language}描述。` : '请分析这个镜头。' },
        { type: 'image_url', image_url: { url: frame, detail: 'auto' } },
      ],
    },
  ];
  const body = { model, messages, temperature: 0.4, max_tokens: 1024 };
  // NVIDIA 免费端点需要显式 JSON 模式；其他端点加了也能兼容主流服务
  body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    },
    VISION_CALL_TIMEOUT_MS,
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`视觉 LLM HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  const j = await res.json().catch(() => ({}));
  const raw = j?.choices?.[0]?.message?.content || '';
  if (!raw) return null;
  // 稳健解析：容忍 ```json 包裹
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 完整旁白 / 语音转写                                                */
/* ------------------------------------------------------------------ */
/**
 * 单次转写的音频体积上限（字节）。Groq 免费端点实测 25MB 即 413
 * （16k 单声道 WAV ≈ 13 分钟），留 2MB 余量避免 multipart 边界顶过线。
 */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** 判断视频是否含音轨（ffprobe 查音频流） */
async function hasAudioStream(file) {
  try {
    const { stdout } = await runFf(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { timeout: 60_000 },
    );
    return stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 把 WAV 缓冲区切成若干 ≤maxBytes 的合法 WAV 块，切点尽量落在静音处。
 * 与 parser-core 内核的同名逻辑保持一致（纯 Node 实现，不引第三方依赖）。
 * 非 16-bit PCM 或非 WAV 时返回 []，由调用方回退单次请求。
 */
function splitWavChunks(buf, maxBytes) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return [];
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) return [];
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return [];

  const bytesPerFrame = 2 * fmt.channels;
  const targetData = maxBytes - 44 - 4096;
  if (dataLen <= targetData) return [];
  const threshold = targetData - targetData * 0.15;
  const windowFrames = Math.max(1, Math.floor(fmt.sampleRate * 0.02));

  const isSilentAround = (frameIdx) => {
    const startFrame = Math.max(0, frameIdx - windowFrames);
    const endFrame = Math.min(dataLen / bytesPerFrame, frameIdx + windowFrames);
    let peak = 0;
    for (let f = startFrame; f < endFrame; f++) {
      const s = Math.abs(buf.readInt16LE(dataStart + f * bytesPerFrame));
      if (s > peak) peak = s;
    }
    return peak < 900;
  };

  const chunks = [];
  let segStart = 0;
  const totalFrames = Math.floor(dataLen / bytesPerFrame);
  while (segStart < dataLen) {
    if (dataLen - segStart <= targetData) {
      chunks.push(makeWav(buf, fmt, dataStart + segStart, dataLen - segStart));
      break;
    }
    const targetFrame = Math.floor((segStart + threshold) / bytesPerFrame);
    const searchRadius = fmt.sampleRate * 5;
    let cutFrame = -1;
    for (let f = targetFrame; f < Math.min(totalFrames, targetFrame + searchRadius); f++) {
      if (isSilentAround(f)) {
        cutFrame = f;
        break;
      }
    }
    const cutByte = cutFrame > 0 ? cutFrame * bytesPerFrame : Math.floor(threshold);
    if (cutByte <= 0) break;
    chunks.push(makeWav(buf, fmt, dataStart + segStart, cutByte));
    segStart += cutByte;
  }
  return chunks;
}

/** 从源 WAV 的 data 段切一段，拼成独立合法 WAV */
function makeWav(buf, fmt, dataOffset, dataLen) {
  const header = Buffer.alloc(44);
  const byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((fmt.channels * fmt.bitsPerSample) / 8, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, buf.subarray(dataOffset, dataOffset + dataLen)]);
}

/** 拼接 OpenAI 兼容的转写端点（统一走 normalizeBaseUrl，避免 /v1/v1） */
function transcriptionEndpoint(base) {
  return apiEndpoint(base, '/audio/transcriptions');
}

/** 转写单块音频的超时：一块最长约 12 分钟音频，给足 10 分钟 */
const TRANSCRIBE_TIMEOUT_MS = 600_000;

/** 送一块音频到 OpenAI 兼容端点转写 */
async function transcribeOnce({ url, apiKey, model, language, audio }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model || 'whisper-1');
  if (language) form.append('language', language);

  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, body: form },
    TRANSCRIBE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`转写失败 (HTTP ${res.status}): ${t.slice(0, 220)}`);
  }
  const j = await res.json().catch(() => ({}));
  const text = j?.text || j?.transcript || '';
  if (!text) throw new Error('转写返回为空（供应商未返回 text 字段）');
  return text;
}

/**
 * 完整旁白 / 转写：抽音轨 → OpenAI 兼容 ASR。
 * 超过体积上限时自动按静音切块逐块转写再拼接（长视频兜底）。
 */
async function buildNarration(payload, win) {
  const {
    id = `nr_${Date.now()}`,
    path: file,
    llmTextBaseUrl,
    llmTextApiKey,
    llmTextModel,
    language,
  } = payload || {};

  if (!file || !fs.existsSync(file)) {
    throw new Error('找不到本地视频文件，请先下载到本机再转写');
  }
  if (!llmTextBaseUrl || !String(llmTextBaseUrl).trim()) {
    throw new Error('请在设置里填写「文本 LLM（旁白转写）」的 Base URL（如 https://api.groq.com/openai/v1）');
  }

  const send = (percent, stage) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('cineflow:storyboard-progress', { id, percent, stage });
    }
  };

  send(5, '检测音轨');
  if (!(await hasAudioStream(file))) {
    throw new Error('该视频不含音轨，无法生成旁白/转写');
  }

  const dir = path.join(STORYBOARD_TMP, String(id).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'audio.wav');

  try {
    send(18, '抽取音轨 0%');
    const extractStart = Date.now();
    await runFf('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
      '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav,
    ], {
      timeout: 900_000,
      // 长视频抽轨也要几十秒，回传已处理的音频时长，别让进度条看着不动
      onStdout: (text) => {
        const m = /out_time=(\d+):(\d+):([\d.]+)/.exec(text);
        if (!m) return;
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        if (sec <= 0) return;
        send(18 + Math.min(20, Math.round(sec / 60)), `抽取音轨 ${sec.toFixed(0)}s（用时 ${Math.round((Date.now() - extractStart) / 1000)}s）`);
      },
    });

    const buf = fs.readFileSync(wav);
    const url = transcriptionEndpoint(String(llmTextBaseUrl).trim());
    const opts = { url, apiKey: (llmTextApiKey || '').trim(), model: (llmTextModel || '').trim(), language };

    let transcript;
    if (buf.length <= MAX_AUDIO_BYTES) {
      send(45, '语音转写中');
      transcript = await transcribeOnce({ ...opts, audio: buf });
    } else {
      const chunks = splitWavChunks(buf, MAX_AUDIO_BYTES);
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        send(40 + Math.round(((i + 1) / chunks.length) * 55), `转写分块 ${i + 1}/${chunks.length}`);
        const text = await transcribeOnce({ ...opts, audio: chunks[i] });
        if (text) parts.push(text.trim());
      }
      transcript = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!transcript) throw new Error('转写返回为空（所有分块均无内容）');
    }

    send(100, '完成');
    return { ok: true, id, transcript, provider: url, model: opts.model };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
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
    const url = (payload && payload.url) || '';
    try {
      const data = await ytDlpMetadata(url, payload && payload.cookieBrowser, payload && payload.cookieFile);
      return { ok: true, data };
    } catch (err) {
      // 返回结构化失败而不是 throw：throw 会被 Electron 包成
      // "Error invoking remote method 'cineflow:parse': Error: ..."，
      // 既难看又把真正的原因埋在后面。
      return {
        ok: false,
        error: describeYtDlpError(err && err.message, {
          url,
          cookieWarning: (err && err.cookieWarning) || null,
        }),
      };
    }
  });

  ipcMain.handle('cineflow:download', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      return await startDownload(payload, win);
    } catch (err) {
      return {
        ok: false,
        error: describeYtDlpError(err && err.message, {
          url: (payload && (payload.sourceUrl || payload.url)) || '',
        }),
      };
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

  // 完整旁白 / 语音转写（本地抽音轨 + OpenAI 兼容 ASR，长音频自动分块）
  ipcMain.handle('cineflow:narration', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      return await buildNarration(payload, win);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '旁白转写失败' };
    }
  });

  // LLM 配置自测（桌面端直连，绕开浏览器 CORS）
  ipcMain.handle('cineflow:test-llm', async (_event, payload) => {
    try {
      return await testLlmConfig(payload || {});
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
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

  ipcMain.handle('cineflow:pick-cookies', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win || undefined, {
      properties: ['openFile'],
      filters: [
        { name: 'Cookie 文件 (cookies.txt)', extensions: ['txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
      title: '选择导出的 cookies.txt',
      buttonLabel: '用这个文件',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const info = inspectCookieFile(res.filePaths[0]);
    return { path: res.filePaths[0], ...info };
  });

  ipcMain.handle('cineflow:cookie-info', async (_event, payload) => {
    const info = inspectCookieFile(payload && payload.path);
    return { path: (payload && payload.path) || null, ...info };
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
  resolveCookieFile,
  inspectCookieFile,
  describeYtDlpError,
  resolveBinary,
  binaryExists,
  defaultDownloadDir,
  resolveDownloadDir,
  // Stage 2 分镜逆向（供自测断言）
  buildStoryboard,
  // 完整旁白 / 语音转写
  buildNarration,
  testLlmConfig,
  splitWavChunks,
  transcriptionEndpoint,
  hasAudioStream,
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
