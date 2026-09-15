/**
 * Electron 主进程（启动层）。
 *
 * 只负责生命周期与窗口；解析 / 下载 / 主站长连接等能力都在 ipc.js 里，
 * 这样无头自测（smoke.test.js）能复用同一份处理器，测的就是真实契约。
 *
 * 桌面端是三层架构里能力最强的一层：
 *   - 解析/下载都从用户本机发出，出口 IP 是真实住宅 IP；
 *   - yt-dlp 用 --cookies-from-browser 直读本机浏览器登录态，无需导出 Cookie；
 *   - 内置 FFmpeg 可以合并 YouTube 的高清视频流与音频流（1080p+ 画质）；
 *   - 第三阶段（本地抽帧 / 分镜逆向）可直接复用同一套本地算力。
 *
 * 页面侧契约见 src/services/electronBridge.ts。
 */

// 注意：electron 由 Electron 运行时注入，不是 Node 内置模块，
// 必须写 require('electron')；加 node: 前缀会被判为未知内置模块而崩溃。
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APP_URL } = require('./config');
const { registerIpcHandlers, startHeartbeat, selfCheck } = require('./ipc');

let mainWindow = null;

/**
 * 自检模式：`npm run selfcheck`
 *
 * 不建窗口，只验证随包二进制能否被定位与执行，然后把结果写到
 * %TEMP%/cineflowing-self-check.json 并退出。
 *
 * 注意两点：
 *   1. 打包后的 Electron 是 Windows GUI 子系统进程，拿不到父终端的 stdout，
 *      所以结果必须落文件才能看到；
 *   2. 触发方式用环境变量而非 CLI 参数 —— 打包后的可执行文件会把未知的
 *      `--xxx` 参数当作 Chromium 开关校验并直接报 "bad option" 退出。
 */
const SELF_CHECK =
  process.env.CINEFLOW_SELF_CHECK === '1' || process.argv.includes('--self-check');
const SELF_CHECK_FILENAME = 'cineflowing-self-check.json';

/**
 * 依次尝试多个可写位置落盘自检报告。
 * 单点路径（尤其 os.tmpdir() 在部分环境下会被重定向或短名化）容易静默失败，
 * 因此按「exe 同目录 → 系统临时目录 → 当前工作目录」顺序兜底，并回传实际写入路径。
 */
function writeSelfCheckReport(report) {
  const candidates = [
    path.join(path.dirname(process.execPath), SELF_CHECK_FILENAME),
    path.join(os.tmpdir(), SELF_CHECK_FILENAME),
    path.join(process.cwd(), SELF_CHECK_FILENAME),
  ];

  for (const file of candidates) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      return file;
    } catch {
      /* 换下一个位置 */
    }
  }
  return null;
}

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

  return mainWindow;
}

// 能力层注册（窗口引用用 getter 延迟取，避免注册时机与建窗时机耦合）
registerIpcHandlers({ getWindow: () => mainWindow });

if (SELF_CHECK) {
  // 立刻（同步、在 Electron 初始化之前）落一个"已启动"标记。
  // 这样即使后续 app.whenReady() 或自检环节出问题，也能区分
  // 「进程根本没跑起来」与「跑起来了但自检失败」。
  writeSelfCheckReport({
    phase: 'boot',
    ok: false,
    note: '主进程已启动，等待 Electron ready 后输出完整自检结果',
    execPath: process.execPath,
    electron: process.versions.electron,
    node: process.versions.node,
  });

  app.whenReady().then(async () => {
    let report;
    try {
      report = await selfCheck();
    } catch (err) {
      report = { ok: false, error: String((err && err.message) || err) };
    }

    report.phase = 'done';
    const written = writeSelfCheckReport(report);

    console.log(JSON.stringify(report));
    console.log('SELF_CHECK_FILE=' + (written || '(写入失败)'));
    console.log(report.ok ? 'SELF_CHECK_OK' : 'SELF_CHECK_FAIL');

    // 退出码即结论：0 = 二进制齐全可用，1 = 有问题
    app.exit(report.ok ? 0 : 1);
  });
} else {
  app.whenReady().then(() => {
    createWindow();
    startHeartbeat();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
