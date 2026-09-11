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
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.PORT || 9000);
const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const CACHE_TTL = Number(process.env.CACHE_TTL || 300) * 1000;
/** YouTube / Instagram 对数据中心 IP 风控严重，挂载 cookies.txt 才能稳定解析 */
const COOKIES_PATH = process.env.COOKIES_PATH || '/app/cookies.txt';
const HAS_COOKIES = existsSync(COOKIES_PATH);
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

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--dump-json',
    '--user-agent',
    UA,
  ];
  if (HAS_COOKIES) args.push('--cookies', COOKIES_PATH);
  args.push('--extractor-args', 'youtube:player_client=android_vr,web_safari', url);

  const info = await runYtDlp(args);

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

/** 阻止通过 /api/fetch 打内网（SSRF 防护） */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function buildReferer(target) {
  const h = target.hostname.toLowerCase();
  if (/tiktok|muscdn|byteoversea|musical\.ly/.test(h)) return 'https://www.tiktok.com/';
  if (/instagram|cdninstagram|fbcdn/.test(h)) return 'https://www.instagram.com/';
  if (/youtube|youtu\.be|googlevideo|ytimg/.test(h)) return 'https://www.youtube.com/';
  if (/douyin|iesdouyin/.test(h)) return 'https://www.douyin.com/';
  if (/xiaohongshu|xhscdn/.test(h)) return 'https://www.xiaohongshu.com/';
  return `${target.protocol}//${target.hostname}/`;
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
    return json(res, 200, {
      ok: true,
      service: 'parser-core',
      providers: ['yt-dlp'],
      cookies: HAS_COOKIES,
    });
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

  /**
   * GET /api/fetch?url=<直链> —— 源站流式下载代理
   * YouTube / Instagram 的直链通常绑定首次请求的出口 IP 并带过期签名，
   * Cloudflare 边缘回源拉取会被拒绝；因此由本服务（Tunnel 内网）代为拉取后再吐给边缘。
   */
  if (url.pathname === '/api/fetch') {
    try {
      if (API_KEY && req.headers.authorization !== `Api-Key ${API_KEY}`) {
        return json(res, 401, { status: 'error', text: 'unauthorized' });
      }

      const target = url.searchParams.get('url') || '';
      if (!target) return json(res, 400, { status: 'error', text: 'url is required' });

      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return json(res, 400, { status: 'error', text: 'invalid url' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json(res, 400, { status: 'error', text: 'unsupported protocol' });
      }
      if (isPrivateHost(parsed.hostname)) {
        return json(res, 403, { status: 'error', text: 'host not allowed' });
      }

      const headers = { 'User-Agent': UA, Accept: 'video/*,*/*;q=0.8', Referer: buildReferer(parsed) };
      if (req.headers.range) headers.Range = req.headers.range;

      const upstream = await fetch(parsed.toString(), { headers, redirect: 'follow' });
      if (!upstream.ok && upstream.status !== 206) {
        return json(res, 502, { status: 'error', text: `upstream HTTP ${upstream.status}` });
      }

      const out = {
        'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Expose-Headers': 'Content-Length,Content-Disposition',
        'Cache-Control': 'private, max-age=60',
      };
      if (upstream.headers.get('content-length')) out['Content-Length'] = upstream.headers.get('content-length');
      if (upstream.headers.get('content-range')) out['Content-Range'] = upstream.headers.get('content-range');
      const filename = (url.searchParams.get('filename') || parsed.pathname.split('/').pop() || 'video.mp4').slice(0, 100);
      out['Content-Disposition'] =
        `attachment; filename="${filename.replace(/[\r\n"]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

      res.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
      return;
    } catch (err) {
      return json(res, 502, { status: 'error', text: String(err?.message || err).slice(0, 300) });
    }
  }

  return json(res, 404, { status: 'error', text: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[parser-core] listening on http://0.0.0.0:${PORT}  (requestId demo: ${randomUUID().slice(0, 8)})`);
});
