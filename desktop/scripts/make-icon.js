/**
 * 生成 Windows 安装包图标 desktop/build/icon.ico（纯 Node 内置模块，零依赖）。
 *
 * 用法：node scripts/make-icon.js
 *
 * 视觉与浏览器插件图标保持一致：紫色→蓝色渐变圆角方块 + 白色左向三角（"反向"语义）。
 * 输出多尺寸 ICO（16/24/32/48/64/128/256），采用 32 位 BGRA DIB，兼容性最好。
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

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

/** 渲染为 RGBA（top-down）像素缓冲 */
function renderRGBA(size) {
  const SS = 4; // 4x 超采样抗锯齿
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

/* --------------------------- ICO（32 位 DIB） --------------------------- */

/** 把 RGBA(top-down) 转成 ICO 用的 BITMAPINFOHEADER + BGRA(bottom-up) + AND 掩码 */
function toDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = 高 * 2（含 AND 掩码）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  // 像素数据：BGRA，自下而上
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND 掩码：1bpp，每行补到 4 字节边界，全 0（有 alpha 通道时系统会用 alpha）
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirEntries = [];
  const blobs = [];

  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 宽（0 表示 256）
    e[1] = size >= 256 ? 0 : size; // 高
    e[2] = 0; // 调色板数
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(data.length, 8); // 数据长度
    e.writeUInt32LE(offset, 12); // 数据偏移
    dirEntries.push(e);
    blobs.push(data);
    offset += data.length;
  }

  return Buffer.concat([dir, ...dirEntries, ...blobs]);
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const entries = SIZES.map((size) => ({ size, data: toDib(renderRGBA(size), size) }));
  const ico = buildIco(entries);
  const target = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(target, ico);

  console.log('  \u2713 build/icon.ico  (' + SIZES.join('/') + '，共 ' + ico.length + ' 字节)');
  console.log('\n完成。重新执行 npm run dist 后，安装包与 exe 图标即为该图标。');
}

try {
  main();
} catch (err) {
  console.error('生成失败：', (err && err.message) || err);
  process.exitCode = 1;
}
