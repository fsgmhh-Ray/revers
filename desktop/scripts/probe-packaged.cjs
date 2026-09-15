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
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

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

/* ------------------------------------------------------------------ */
/* Stage 2 分镜管线：用打包后的 ffmpeg / ffprobe 真跑一遍              */
/* ------------------------------------------------------------------ */
/*
 * 只验证「二进制能启动」是不够的 —— 分镜依赖的是
 * 「ffmpeg 能以 select+showinfo 过滤器链跑完并吐出 pts_time」，
 * 这是参数正确性 + 二进制完整性 + 解包路径三件事同时成立才有的结果。
 */
const ffprobePath = path.join(binDir, 'ffprobe.exe');
result.ffprobePath = ffprobePath;
result.ffprobeExists = fs.existsSync(ffprobePath);

const tmpDir = path.join(os.tmpdir(), `cineflow-probe-${Date.now()}`);
const testVideo = path.join(tmpDir, 'scenes.mp4');

try {
  fs.mkdirSync(tmpDir, { recursive: true });

  // 合成「红 → 蓝 → 绿」三段各 1 秒的测试片，与 storyboard.test.js 同一套素材
  const gen = spawnSync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=15:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=15:d=1',
      '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=15:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
      '-map', '[out]', '-pix_fmt', 'yuv420p',
      testVideo,
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  result.storyboardTestVideo = gen.status === 0 && fs.existsSync(testVideo);

  // 与 ipc.js detectScenes 完全相同的过滤器链
  const cut = spawnSync(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'info',
      '-i', testVideo,
      '-filter:v', "scale=160:-2,select='gt(scene,0.3)',showinfo",
      '-an', '-f', 'null', '-',
    ],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  );
  const stderr = cut.stderr || '';
  result.storyboardCutCount = (stderr.match(/pts_time:([0-9]+(?:\.[0-9]+)?)/g) || []).length;
  result.storyboardOk = result.storyboardCutCount >= 2;

  if (result.ffprobeExists) {
    const info = spawnSync(
      ffprobePath,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', testVideo],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
    result.ffprobeOk = info.status === 0 && /"width"/.test(info.stdout || '');
  }
} catch (err) {
  result.storyboardError = String((err && err.message) || err);
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 探针不该因为清理失败而报错 */
  }
}

result.ok = Boolean(
  result.ytDlpExists &&
    result.ffmpegExists &&
    result.ytDlpVersion &&
    result.ffprobeExists &&
    result.storyboardOk &&
    result.ffprobeOk,
);

// GUI 子系统进程 stdout 不可靠，一律落盘
const outFile = path.join(process.cwd(), 'probe-result.json');
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.exit(result.ok ? 0 : 1);
