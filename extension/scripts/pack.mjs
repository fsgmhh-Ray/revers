#!/usr/bin/env node
/**
 * 打包 Chrome 插件为可分发的 zip —— 零依赖，纯 Node 内置模块（含手写 ZIP 容器）。
 *
 * 为什么要自己写 ZIP：本机没有 `zip` 命令，且这是**内测分发包**，
 * 必须只含运行时文件（排除 test/ scripts/ *.md），不能直接把工作目录压进去。
 *
 * 用法：
 *   node scripts/pack.mjs            # 输出 dist/cineflowing-reverse-<version>.zip
 *   node scripts/pack.mjs --out x.zip
 *
 * 产出即"加载已解压"的等价物，也用于内部 zip 分发；自校验失败会以非 0 退出。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 只打包这些运行时文件 —— 新增文件必须显式登记，避免把开发物带进分发包。 */
const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'icons/16.png',
  'icons/32.png',
  'icons/48.png',
  'icons/128.png',
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const argOut = process.argv.indexOf('--out');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const OUT =
  argOut > -1
    ? resolve(process.argv[argOut + 1])
    : join(ROOT, 'dist', `cineflowing-reverse-${manifest.version}.zip`);

if (manifest.manifest_version !== 3) {
  console.error(`[FAIL] manifest_version = ${manifest.manifest_version}，预期 3`);
  process.exit(1);
}

// 图标必须在 manifest 里登记过，防止漏打导致商店审核报缺图
const declaredIcons = Object.values(manifest.icons || {});
for (const f of FILES) {
  if (f.startsWith('icons/') && !declaredIcons.includes(f)) {
    console.error(`[FAIL] ${f} 未在 manifest.icons 中登记`);
    process.exit(1);
  }
}

const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

const locals = [];
const centrals = [];
let offset = 0;
const report = [];

for (const name of FILES) {
  const abs = join(ROOT, name);
  if (!existsSync(abs)) {
    console.error(`[FAIL] 缺少文件：${name}`);
    process.exit(1);
  }
  const raw = readFileSync(abs);
  const deflated = deflateRawSync(raw, { level: 9 });
  // 压缩后反而更大时退回 store（不压缩），符合 ZIP 惯例
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(raw);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  locals.push(lh, nameBuf, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(dosTime, 12);
  cd.writeUInt16LE(dosDate, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  centrals.push(cd, nameBuf);

  report.push({ name, raw: raw.length, zip: body.length, method });
  offset += lh.length + nameBuf.length + body.length;
}

const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, cdBuf, eocd]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip);

// ---- 自校验：重新解析中央目录并逐个 inflate + 校验 CRC ----
const buf = readFileSync(OUT);
const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocdPos < 0) {
  console.error('[FAIL] 找不到 EOCD');
  process.exit(1);
}
const total = buf.readUInt16LE(eocdPos + 10);
const cdStart = buf.readUInt32LE(eocdPos + 16);
let p = cdStart;
let verified = 0;
for (let i = 0; i < total; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) {
    console.error(`[FAIL] 中央目录第 ${i} 项签名错误`);
    process.exit(1);
  }
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nlen = buf.readUInt16LE(p + 28);
  const elen = buf.readUInt16LE(p + 30);
  const clen = buf.readUInt16LE(p + 32);
  const lo = buf.readUInt32LE(p + 42);
  const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
  const lhlen = 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(lo + lhlen, lo + lhlen + csize);
  const raw = method === 8 ? inflateRawSync(data) : data;
  if (raw.length !== usize || crc32(raw) !== crc) {
    console.error(`[FAIL] ${name} 校验失败（长度或 CRC 不符）`);
    process.exit(1);
  }
  verified++;
  p += 46 + nlen + elen + clen;
}

if (verified !== FILES.length) {
  console.error(`[FAIL] 中央目录条目数 ${verified} != ${FILES.length}`);
  process.exit(1);
}

console.log(`PACK_OK ${OUT}`);
console.log(`  版本 ${manifest.version} · ${verified} 个文件 · 未压缩 ${report.reduce((s, r) => s + r.raw, 0)} B · zip ${zip.length} B`);
for (const r of report) {
  console.log(`  - ${r.name.padEnd(16)} ${String(r.raw).padStart(8)} B -> ${r.method === 8 ? 'deflate' : 'store  '} ${r.zip} B`);
}
