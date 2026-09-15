/**
 * 桌面端共享配置：main.js（启动层）与 ipc.js（能力层）都从这里取值，
 * 避免各写一份导致漂移。
 */

const path = require('node:path');

/** 客户端加载的站点地址；可用 REVERSE_URL 覆盖（本地联调时指到 dev server） */
const APP_URL = process.env.REVERSE_URL || 'https://reverse.cineflowing.com';

/** 客户端版本号：升级判定依赖它，发版时必须与 src/config.ts 的 APP_VERSION 同步递增 */
const VERSION = '0.2.0';

/** 随包分发的 yt-dlp / ffmpeg 所在目录 */
// 打包后代码运行在 app.asar 归档内，而子进程无法从 asar 里启动
//（asar 不是真实文件系统，spawn 会 ENOENT）。
// 因此随包的二进制必须落在 app.asar.unpacked 下（见 package.json 的 asarUnpack），
// 这里把路径重写到解包目录。
const APP_DIR = __dirname.includes('app.asar')
  ? __dirname.replace('app.asar', 'app.asar.unpacked')
  : __dirname;

const BIN_DIR = path.join(APP_DIR, 'bin');

const IS_WIN = process.platform === 'win32';

module.exports = { APP_URL, VERSION, BIN_DIR, IS_WIN };
