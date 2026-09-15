/**
 * 生成扩展图标（16/32/48/128），纯 Node 内置模块，无第三方依赖。
 *
 * 用法：node scripts/make-icons.mjs
 *
 * 设计：紫色→蓝色渐变圆角方块 + 白色左向三角（"反向"语义）。
 * 采用 4x 超采样做抗锯齿，输出标准 RGBA PNG。
 * 脚本会顺带把 manifest.json 的 icons 字段补上（幂等，可重复执行）。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, '..');
const ICON_DIR = join(EXT_DIR, 'icons');
const SIZES = [16, 32, 48, 128];

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 图形渲染 ------------------------------ */

/** 圆角矩形命中测试（SDF 负值即内部） */
function inRoundRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r < 0;
}

function edge(ax, ay, bx, by, px, py) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

/** 三角形命中测试（重心符号法） */
function inTriangle(px, py, v) {
  const d1 = edge(v[0][0], v[0][1], v[1][0], v[1][1], px, py);
  const d2 = edge(v[1][0], v[1][1], v[2][0], v[2][1], px, py);
  const d3 = edge(v[2][0], v[2][1], v[0][0], v[0][1], px, py);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function renderIcon(size) {
  const SS = 4; // 超采样倍数
  const W = size * SS;
  const radius = W * 0.22;

  // 左向三角 = "反向"语义
  const tri = [
    [W * 0.3, W * 0.5],
    [W * 0.72, W * 0.26],
    [W * 0.72, W * 0.74],
  ];

  const out = Buffer.alloc(size * size * 4);
  const total = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let cover = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          if (!inRoundRect(px, py, W, W, radius)) continue;
          cover++;
          if (inTriangle(px, py, tri)) {
            sr += 255;
            sg += 255;
            sb += 255;
          } else {
            // #6D28D9 -> #2563EB 纵向渐变
            const t = py / W;
            sr += 109 + (37 - 109) * t;
            sg += 40 + (99 - 40) * t;
            sb += 217 + (235 - 217) * t;
          }
        }
      }

      const o = (y * size + x) * 4;
      if (cover > 0) {
        out[o] = Math.round(sr / cover);
        out[o + 1] = Math.round(sg / cover);
        out[o + 2] = Math.round(sb / cover);
        out[o + 3] = Math.round((cover / total) * 255);
      }
    }
  }

  return out;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  mkdirSync(ICON_DIR, { recursive: true });

  for (const size of SIZES) {
    const file = join(ICON_DIR, `${size}.png`);
    writeFileSync(file, encodePng(size, renderIcon(size)));
    console.log(`  \u2713 icons/${size}.png`);
  }

  // 幂等补写 manifest.json 的 icons 字段
  const manifestPath = join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const icons = {};
  for (const size of SIZES) icons[String(size)] = `icons/${size}.png`;

  if (JSON.stringify(manifest.icons) === JSON.stringify(icons)) {
    console.log('  \u00b7 manifest.json 的 icons 字段已是最新，跳过');
  } else {
    manifest.icons = icons;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('  \u2713 manifest.json 已补写 icons 字段');
  }

  console.log('\n完成。回到 chrome://extensions 点刷新，即可看到新图标。');
}

try {
  main();
} catch (err) {
  console.error('生成失败：', err?.message || err);
  process.exitCode = 1;
}
