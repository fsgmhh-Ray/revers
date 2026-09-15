/**
 * 无头冒烟自测：用 Electron 跑一个 hidden 窗口，
 * 加载真实的 ipc.js 处理器 + preload.js 桥接，验证核心 IPC 契约。
 *
 * 用法（在 desktop/ 下，已 npm install 后）：
 *   npm run smoke
 * 等价于：
 *   electron smoke.test.js
 *
 * 特点：
 *   - 不依赖外网或已部署站点（纯本地 IPC 验证，心跳不启动）；
 *   - 30s 硬性超时，绝不会挂起；
 *   - 退出码 0=通过，1=断言失败，2=超时，3=运行环境不对。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 前置守卫：若环境里存在 ELECTRON_RUN_AS_NODE=1，electron.exe 会退化成纯 Node，
// 此时 require('electron') 只会返回一个路径字符串（app 为 undefined）。
// 明确报出来，避免看到一个看不懂的 TypeError。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('SMOKE_ERROR=检测到 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE);
  console.error('SMOKE_HINT=该变量会让 Electron 退化成纯 Node；请先清除再运行（PowerShell: Remove-Item Env:ELECTRON_RUN_AS_NODE）');
  process.exit(3);
}

// 注意：electron 由 Electron 运行时注入，不是 Node 内置模块，
// 必须写 require('electron') 而非 require('node:electron')。
const { app, BrowserWindow } = require('electron');

if (!app || typeof app.whenReady !== 'function') {
  console.error('SMOKE_ERROR=require("electron") 未返回 Electron API，当前进程不是 Electron 主进程');
  process.exit(3);
}

const { registerIpcHandlers, VERSION, describeYtDlpError, inspectCookieFile } = require('./ipc');

/** 期望 preload 暴露的全部方法（与 src/services/electronBridge.ts 的 ElectronAPI 对齐） */
const EXPECTED_API = [
  'hello',
  'parse',
  'download',
  'cancel',
  'reveal',
  'pickDir',
  'defaultDir',
  'pickCookies',
  'cookieInfo',
  'storyboard',
  'onStoryboardProgress',
  'onDownloadProgress',
  'fetchFeed',
  'feedState',
  'onFeed',
  'onConnection',
];

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log('  \u2713 ' + label);
  } else {
    failures.push(label + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? ' -> ' + detail : ''));
  }
}

const hardTimeout = setTimeout(() => {
  console.error('SMOKE_TIMEOUT=30s 内未完成，判定失败');
  app.exit(2);
}, 30_000);

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

    // 注册真实处理器；getWindow 指向测试窗口，使事件广播路径也可验证
    registerIpcHandlers({ getWindow: () => win });

    await win.loadURL('data:text/html,<html><body><h1>smoke</h1></body></html>');
    // 等 preload 注入完成
    await win.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 300))');

    console.log('--- 运行时与桥接 ---');
    const runtime = await win.webContents.executeJavaScript('window.CINEFLOW_RUNTIME');
    check('window.CINEFLOW_RUNTIME === "electron"', runtime === 'electron', String(runtime));

    const apiKeys = await win.webContents.executeJavaScript('Object.keys(window.electronAPI || {})');
    check('window.electronAPI 已注入', Array.isArray(apiKeys) && apiKeys.length > 0);
    for (const name of EXPECTED_API) {
      check('electronAPI.' + name + ' 存在且为函数', apiKeys.includes(name));
    }
    const missing = EXPECTED_API.filter((n) => !apiKeys.includes(n));
    if (missing.length) failures.push('electronAPI 缺失方法: ' + missing.join(', '));

    console.log('--- IPC 契约 ---');
    const hello = await win.webContents.executeJavaScript('window.electronAPI.hello()');
    console.log('SMOKE_HELLO=' + JSON.stringify(hello));
    check('hello() 返回对象', !!hello && typeof hello === 'object');
    check('hello.version 与 config 一致', hello && hello.version === VERSION, String(hello && hello.version));
    check('hello.runtime === "electron"', hello && hello.runtime === 'electron');
    check('hello.ytDlp 为布尔', hello && typeof hello.ytDlp === 'boolean', String(hello && hello.ytDlp));
    check('hello.ffmpeg 为布尔', hello && typeof hello.ffmpeg === 'boolean', String(hello && hello.ffmpeg));
    check('hello.browsers 为数组', hello && Array.isArray(hello.browsers));
    console.log('SMOKE_BINARIES=' + JSON.stringify({ ytDlp: hello && hello.ytDlp, ffmpeg: hello && hello.ffmpeg, ytDlpVersion: hello && hello.ytDlpVersion }));

    const feedState = await win.webContents.executeJavaScript('window.electronAPI.feedState()');
    console.log('SMOKE_FEEDSTATE=' + JSON.stringify(feedState));
    check('feedState() 返回对象', !!feedState && typeof feedState === 'object');
    check('feedState.online 为布尔', feedState && typeof feedState.online === 'boolean');
    check('feedState.interval 为数字', feedState && typeof feedState.interval === 'number');
    check('feedState.lastSync 为数字', feedState && typeof feedState.lastSync === 'number');

    check('pickDir 为函数（不实际弹窗）', apiKeys.includes('pickDir'));

    console.log('--- 下载目录 ---');
    const dirInfo = await win.webContents.executeJavaScript('window.electronAPI.defaultDir()');
    console.log('SMOKE_DEFAULT_DIR=' + JSON.stringify(dirInfo));
    check('defaultDir() 返回对象', !!dirInfo && typeof dirInfo === 'object');
    check('defaultDir().dir 非空', !!(dirInfo && dirInfo.dir), String(dirInfo && dirInfo.dir));
    check('defaultDir().effective 可写', !!(dirInfo && dirInfo.effective), String(dirInfo && dirInfo.effective));

    console.log('--- 登录态（cookies.txt 通道）---');
    const noFile = await win.webContents.executeJavaScript(
      'window.electronAPI.cookieInfo({ path: "Z:/__no_such_cookie_file__.txt" })',
    );
    check('cookieInfo() 对不存在的文件返回 ok:false', !!noFile && noFile.ok === false, JSON.stringify(noFile));
    check('cookieInfo() 带错误说明', !!(noFile && noFile.error), String(noFile && noFile.error));

    // 用真实文件验证校验器，而不是只信"格式对不对"的猜测
    const tmpCookie = path.join(os.tmpdir(), 'cineflow-smoke-cookies.txt');
    fs.writeFileSync(
      tmpCookie,
      [
        '# Netscape HTTP Cookie File',
        '# 这是注释行，不该被计入',
        '',
        '.tiktok.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tabc123',
        '.tiktok.com\tTRUE\t/\tTRUE\t1999999999\ttt_csrf_token\tdef456',
      ].join('\n'),
      'utf8',
    );
    const cookieInfo = inspectCookieFile(tmpCookie);
    check('inspectCookieFile 认可 Netscape 格式', cookieInfo.ok === true, JSON.stringify(cookieInfo));
    check('inspectCookieFile 只数 Cookie 行（应为 2）', cookieInfo.count === 2, String(cookieInfo.count));
    check('inspectCookieFile 识别出 tiktok.com', cookieInfo.hasTikTok === true);

    fs.writeFileSync(tmpCookie, 'this is not a cookie file', 'utf8');
    check('非 Cookie 文件被判为无效', inspectCookieFile(tmpCookie).ok === false);
    fs.rmSync(tmpCookie, { force: true });
    check('空白路径被判为无效', inspectCookieFile('').ok === false);

    console.log('--- yt-dlp 报错翻译 ---');
    // 纯函数，直接在主进程断言，不必跨 IPC
    const noFmt = describeYtDlpError('ERROR: [TikTok] 7683668329: No video formats found!; please report', {
      url: 'https://www.tiktok.com/@x/video/7683668329',
    });
    check('短剧类报错给出 TikTok 短剧判断', /短剧/.test(noFmt), noFmt.split('\n')[0]);
    check('短剧类报错给出可行动建议', /cookies\.txt/.test(noFmt));
    check('短剧类报错保留原始错误', /No video formats found/.test(noFmt));

    const cookieErr = describeYtDlpError('ERROR: Could not copy Chrome cookie database. See ...', {
      url: 'https://www.tiktok.com/@x/video/1',
    });
    check('Cookie 读取失败给出导入建议', /cookies\.txt/.test(cookieErr), cookieErr.split('\n')[0]);

    const unknownErr = describeYtDlpError('some brand new yt-dlp failure', { url: 'https://example.com/a.mp4' });
    check('未知报错回落到通用文案且不丢原文', /some brand new/.test(unknownErr), unknownErr.split('\n')[0]);

    console.log('--- 结果 ---');
    if (failures.length === 0) {
      console.log('SMOKE_OK');
      clearTimeout(hardTimeout);
      app.exit(0);
    } else {
      console.error('SMOKE_FAIL=' + failures.length + ' 项失败');
      failures.forEach((f) => console.error('  - ' + f));
      clearTimeout(hardTimeout);
      app.exit(1);
    }
  } catch (err) {
    console.error('SMOKE_ERROR=' + (err && err.message ? err.message : err));
    clearTimeout(hardTimeout);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
