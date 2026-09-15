/**
 * 打包产物验证器：用打包后的客户端以「Node 模式」运行定位探针。
 *
 * 为什么需要它：开发环境的 npm run smoke 永远不会暴露 asar 打包问题，
 * 而直接以 GUI 模式启动打包后的客户端又需要桌面会话（CI / 无头环境跑不了）。
 * 走 Node 模式既绕开了桌面会话依赖，又能真实验证「打包后能否定位并执行随包二进制」。
 *
 * 用法（先 npm run pack 或 npm run dist）：
 *   npm run probe:packaged
 *
 * 退出码：0=打包产物可用，1=有问题。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(DESKTOP_DIR, 'dist', 'win-unpacked');
const PROBE = path.join(__dirname, 'probe-packaged.cjs');
const RESULT = path.join(OUT_DIR, 'probe-result.json');

if (!fs.existsSync(OUT_DIR)) {
  console.error('[probe] 未找到 ' + OUT_DIR);
  console.error('[probe] 请先执行 npm run pack（或 npm run dist）');
  process.exit(1);
}

const exe = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .find((f) => !/elevate|squirrel/i.test(f));

if (!exe) {
  console.error('[probe] 在 ' + OUT_DIR + ' 中未找到主程序 exe');
  process.exit(1);
}

// 以 Node 模式运行：不需要桌面会话，且 stdout 可用
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

const res = spawnSync(path.join(OUT_DIR, exe), [PROBE], {
  cwd: OUT_DIR,
  env,
  stdio: 'inherit',
});

if (res.error) {
  console.error('[probe] 启动失败：' + res.error.message);
  process.exit(1);
}

if (!fs.existsSync(RESULT)) {
  console.error('[probe] 探针未产出 ' + RESULT);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(RESULT, 'utf8'));

console.log('\n[probe] 打包产物定位验证：');
console.log('  packed exe      : ' + path.basename(report.execPath));
console.log('  app.asar        : ' + (report.asarExists ? '存在' : '缺失'));
console.log('  app.asar.unpacked: ' + (report.asarUnpackedExists ? '存在' : '缺失'));
console.log('  binDir          : ' + report.binDir);
console.log('  yt-dlp.exe      : ' + (report.ytDlpExists ? '存在' : '缺失'));
console.log('  ffmpeg.exe      : ' + (report.ffmpegExists ? '存在' : '缺失'));
console.log('  yt-dlp 版本     : ' + (report.ytDlpVersion || '(未能执行)'));
console.log('  ffmpeg 版本     : ' + (report.ffmpegVersion || '(未能执行)'));

if (report.spawnError) console.log('  yt-dlp 错误     : ' + report.spawnError);
if (report.ffmpegSpawnError) console.log('  ffmpeg 错误     : ' + report.ffmpegSpawnError);

console.log(report.ok ? '\nPROBE_OK' : '\nPROBE_FAIL');
process.exit(report.ok ? 0 : 1);
