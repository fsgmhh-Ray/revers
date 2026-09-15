/**
 * 打包后二进制定位探针。
 *
 * 用打包好的客户端以「Node 模式」运行本文件（ELECTRON_RUN_AS_NODE=1），
 * 这样既不需要 Electron API，也绕开了 Windows GUI 子系统进程拿不到 stdout、
 * 以及 shell 等待语义不明的问题。结果落盘到 cwd。
 *
 * 它复刻的正是 desktop/config.js 里那段路径重写逻辑，用来验证
 * 「打包后能否真正定位并执行随包的 yt-dlp / ffmpeg」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const exeDir = path.dirname(process.execPath);
const resourcesDir = path.join(exeDir, 'resources');
const asarPath = path.join(resourcesDir, 'app.asar');

// —— 与 config.js 完全一致的重写规则 ——
const appDir = asarPath.includes('app.asar') ? asarPath.replace('app.asar', 'app.asar.unpacked') : asarPath;
const binDir = path.join(appDir, 'bin');

const ytDlpPath = path.join(binDir, 'yt-dlp.exe');
const ffmpegPath = path.join(binDir, 'ffmpeg.exe');

const result = {
  execPath: process.execPath,
  exeDir,
  resourcesDir,
  asarExists: fs.existsSync(asarPath),
  asarUnpackedExists: fs.existsSync(appDir),
  binDir,
  binDirExists: fs.existsSync(binDir),
  ytDlpPath,
  ytDlpExists: fs.existsSync(ytDlpPath),
  ffmpegPath,
  ffmpegExists: fs.existsSync(ffmpegPath),
};

// 关键一步：真的把随包的 yt-dlp 跑起来
try {
  result.ytDlpVersion = execFileSync(ytDlpPath, ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  }).trim();
} catch (err) {
  result.spawnError = String((err && err.message) || err);
}

try {
  const probe = execFileSync(ffmpegPath, ['-version'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  result.ffmpegVersion = probe.split('\n')[0].trim();
} catch (err) {
  result.ffmpegSpawnError = String((err && err.message) || err);
}

result.ok = Boolean(result.ytDlpExists && result.ffmpegExists && result.ytDlpVersion);

// GUI 子系统进程 stdout 不可靠，一律落盘
const outFile = path.join(process.cwd(), 'probe-result.json');
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.exit(result.ok ? 0 : 1);
