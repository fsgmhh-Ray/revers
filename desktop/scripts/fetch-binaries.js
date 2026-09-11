/**
 * 下载 yt-dlp 与 FFmpeg 到 desktop/bin/。
 *
 * 用法：npm run binaries
 *
 * Windows 依赖系统自带的 tar（Win10 17063+ 内置）解压 ffmpeg 压缩包，
 * 无额外依赖；macOS / Linux 直接下载静态构建产物。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    https
      .get(url, { headers: { 'User-Agent': 'cineflowing-reverse' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
  });
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const platform = process.platform;

  // --- yt-dlp ---
  const ytName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDest = path.join(BIN_DIR, ytName);
  const ytUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytName}`;
  console.log(`↓ yt-dlp  ->  ${ytDest}`);
  await download(ytUrl, ytDest);
  if (platform !== 'win32') fs.chmodSync(ytDest, 0o755);

  // --- FFmpeg ---
  if (platform === 'win32') {
    const zip = path.join(os.tmpdir(), 'ffmpeg-win.zip');
    console.log('↓ ffmpeg (win64 gpl)');
    await download(
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      zip,
    );
    const extractDir = path.join(os.tmpdir(), 'ffmpeg-win');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await run('tar', ['-xf', zip, '-C', extractDir]);
    const found = findFile(extractDir, ['ffmpeg.exe', 'ffprobe.exe']);
    for (const [name, src] of Object.entries(found)) {
      fs.copyFileSync(src, path.join(BIN_DIR, name));
      console.log(`✓ ${name}`);
    }
    fs.rmSync(zip, { force: true });
  } else if (platform === 'darwin') {
    console.log('FFmpeg：请用 brew install ffmpeg，或从 evermeet.cx 下载静态构建放到 bin/');
  } else {
    const tarPath = path.join(os.tmpdir(), 'ffmpeg-linux.tar.xz');
    console.log('↓ ffmpeg (linux static)');
    await download('https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', tarPath);
    const extractDir = path.join(os.tmpdir(), 'ffmpeg-linux');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await run('tar', ['-xf', tarPath, '-C', extractDir, '--strip-components=1']);
    for (const name of ['ffmpeg', 'ffprobe']) {
      const src = path.join(extractDir, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(BIN_DIR, name));
        fs.chmodSync(path.join(BIN_DIR, name), 0o755);
        console.log(`✓ ${name}`);
      }
    }
    fs.rmSync(tarPath, { force: true });
  }

  console.log('\n完成。现在可以 npm start');
}

function findFile(dir, names) {
  const result = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (names.includes(entry.name) && !result[entry.name]) result[entry.name] = full;
    }
  };
  walk(dir);
  return result;
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
