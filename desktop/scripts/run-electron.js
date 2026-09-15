/**
 * 跨平台 Electron 启动包装器。
 *
 * 存在的理由：若环境里存在 ELECTRON_RUN_AS_NODE 变量（某些 IDE / 沙箱会注入），
 * electron.exe 会退化成纯 Node 运行，导致 require('electron') 拿到路径字符串而非 API，
 * 表现为「app is undefined」这类看不懂的崩溃。这里统一先清掉该变量再启动。
 *
 * 用法：node scripts/run-electron.js <electron 参数...>
 *   node scripts/run-electron.js .              # 等价 electron .
 *   node scripts/run-electron.js smoke.test.js  # 等价 electron smoke.test.js
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// 以普通 Node 运行时执行时，electron 包导出的是可执行文件路径（字符串）
const electronPath = require('electron');

if (typeof electronPath !== 'string') {
  console.error('[run-electron] 未解析到 Electron 可执行文件，请先执行 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const result = spawnSync(electronPath, args, {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..'),
});

if (result.error) {
  console.error('[run-electron] 启动失败：' + result.error.message);
  process.exit(1);
}

// 被信号终止时 status 为 null，统一按失败处理
process.exit(typeof result.status === 'number' ? result.status : 1);
