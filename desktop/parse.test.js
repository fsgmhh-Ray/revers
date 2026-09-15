/**
 * 真机解析自测：走完整的 ipc 调用链（renderer → preload → ipc.js → yt-dlp → 元数据映射），
 * 验证桌面端「真的能解析出视频」，而不只是契约存在。
 *
 * 用法（在 desktop/ 下）：
 *   npm run parse                       # 用默认的通用直链做链路验证
 *   npm run parse -- "<视频页面链接>"     # 用真实的 TikTok / YouTube / Instagram 链接
 *
 * 退出码：0=解析成功，1=解析失败，2=超时，3=运行环境不对。
 */

const path = require('node:path');

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('PARSE_ERROR=检测到 ELECTRON_RUN_AS_NODE，请通过 npm run parse 运行');
  process.exit(3);
}

const { app, BrowserWindow } = require('electron');

if (!app || typeof app.whenReady !== 'function') {
  console.error('PARSE_ERROR=当前进程不是 Electron 主进程');
  process.exit(3);
}

const { registerIpcHandlers } = require('./ipc');

// 默认用一条稳定的直链做链路自检；真实平台链接请用 -- 传入
const DEFAULT_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
const cliArgs = process.argv.slice(2).filter((a) => a !== '--');
const TARGET = cliArgs[0] || process.env.PARSE_URL || DEFAULT_URL;

const hardTimeout = setTimeout(() => {
  console.error('PARSE_TIMEOUT=120s 内未完成');
  app.exit(2);
}, 120_000);

let win = null;

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    registerIpcHandlers({ getWindow: () => win });
    await win.loadURL('data:text/html,<html><body>parse</body></html>');
    await win.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 300))');

    console.log('PARSE_TARGET=' + TARGET);
    const t0 = Date.now();

    // 注意：解析失败时 IPC 会 reject，这里捕获后按失败处理
    const result = await win.webContents.executeJavaScript(
      `window.electronAPI.parse({ url: ${JSON.stringify(TARGET)} }).then(
         (r) => ({ ok: true, data: r }),
         (e) => ({ ok: false, error: String((e && e.message) || e) })
       )`,
    );

    const ms = Date.now() - t0;

    if (!result || !result.ok) {
      console.error('PARSE_FAIL=' + (result && result.error ? result.error : '未知错误'));
      clearTimeout(hardTimeout);
      app.exit(1);
      return;
    }

    const d = result.data;
    console.log('PARSE_MS=' + ms);
    console.log('PARSE_TITLE=' + d.title);
    console.log('PARSE_PLATFORM=' + d.platform);
    console.log('PARSE_DURATION=' + d.duration);
    console.log('PARSE_AUTHOR=' + (d.author && d.author.name));
    console.log('PARSE_PROVIDER=' + d.provider);
    console.log('PARSE_HAS_DOWNLOAD_URL=' + Boolean(d.downloadUrl && /^https?:/.test(d.downloadUrl)));
    console.log('PARSE_COVER=' + Boolean(d.coverUrl));

    const ok =
      typeof d.title === 'string' &&
      d.title.length > 0 &&
      typeof d.duration === 'number' &&
      Boolean(d.downloadUrl && /^https?:/.test(d.downloadUrl));

    console.log(ok ? 'PARSE_OK' : 'PARSE_FAIL=关键字段缺失');
    clearTimeout(hardTimeout);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('PARSE_ERROR=' + (err && err.message ? err.message : err));
    clearTimeout(hardTimeout);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
