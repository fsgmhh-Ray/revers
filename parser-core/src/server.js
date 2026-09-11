/**
 * parser-core —— 自建解析内核
 *
 * 以 Cobalt 兼容协议（POST /api/json）对外提供服务，内部使用 yt-dlp 解析，
 * 部署在独立 VPS 上可规避 Cloudflare / 数据中心 IP 被 YouTube、Instagram 封禁的问题。
 *
 * 环境变量：
 *   PORT           默认 9000
 *   API_KEY        可选；设置后需在请求头带 Authorization: Api-Key <key>
 *   ALLOWED_ORIGIN 可选；CORS 白名单（默认 *）
 *   YTDLP_PATH     yt-dlp 可执行文件路径（默认 yt-dlp）
 *   CACHE_TTL      解析结果缓存秒数（默认 300）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 9000);
const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const CACHE_TTL = Number(process.env.CACHE_TTL || 300) * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** 内存缓存：url -> { payload, expiresAt } */
const cache = new Map();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited with ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('yt-dlp 输出无法解析为 JSON'));
      }
    });
  });
}

/** 选出画质最高的 mp4 直链 */
function pickBestFormat(info) {
  const formats = (info?.formats || []).filter((f) => f.url);
  if (!formats.length) return { url: info?.url, height: info?.height, width: info?.width };

  const videoOnly = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && !/storyboard/i.test(f.format_id || ''));
  const progressive = videoOnly.filter((f) => f.acodec && f.acodec !== 'none');
  const pool = progressive.length ? progressive : videoOnly;
  const best = pool.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || formats[formats.length - 1];
  return { url: best.url, height: best.height, width: best.width, hasAudio: Boolean(best?.acodec && best.acodec !== 'none') };
}

async function parse(url) {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const info = await runYtDlp([
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--dump-json',
    '--user-agent',
    UA,
    '--extractor-args',
    'youtube:player_client=android_vr,web_safari',
    url,
  ]);

  const best = pickBestFormat(info);
  if (!best?.url) {
    return { status: 'error', text: 'yt-dlp 未返回可用直链（多为风控或登录墙）' };
  }

  const payload = {
    status: 'redirect',
    url: best.url,
    filename: `${(info.title || 'video').slice(0, 80)}.mp4`,
    meta: {
      id: info.id,
      title: info.title,
      duration: info.duration,
      uploader: info.uploader || info.channel,
      thumbnail: info.thumbnail,
      width: best.width || info.width,
      height: best.height || info.height,
      extractor: info.extractor_key,
      webpage_url: info.webpage_url || url,
    },
  };

  cache.set(url, { payload, expiresAt: Date.now() + CACHE_TTL });
  return payload;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' || url.pathname === '/') {
    return json(res, 200, { ok: true, service: 'parser-core', providers: ['yt-dlp'] });
  }

  if (url.pathname === '/api/json') {
    try {
      if (API_KEY && req.headers.authorization !== `Api-Key ${API_KEY}`) {
        return json(res, 401, { status: 'error', text: 'unauthorized' });
      }

      let target = '';
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          target = (JSON.parse(raw) || {}).url || '';
        } catch {
          return json(res, 400, { status: 'error', text: 'invalid json body' });
        }
      } else {
        target = url.searchParams.get('url') || '';
      }

      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });

      const payload = await parse(target);
      return json(res, payload.status === 'error' ? 422 : 200, payload);
    } catch (err) {
      return json(res, 500, { status: 'error', text: String(err?.message || err).slice(0, 300) });
    }
  }

  return json(res, 404, { status: 'error', text: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[parser-core] listening on http://0.0.0.0:${PORT}  (requestId demo: ${randomUUID().slice(0, 8)})`);
});
