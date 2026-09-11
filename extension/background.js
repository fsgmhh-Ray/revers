/**
 * 后台服务进程（MV3 Service Worker）。
 *
 * 所有请求都从这里发出，因此：
 *   1. 出口 IP 是用户的真实住宅 IP，不受机房 IP 封禁影响；
 *   2. 带 credentials: 'include'，天然携带用户浏览器里现成的 YT / IG 登录态；
 *   3. 拥有 host_permissions，不受 CORS 限制；
 *   4. 用 chrome.downloads 落盘，走浏览器下载管理器（自带断点续传）。
 */

const PROTOCOL = 'CINEFLOW_EXT_V1';
const VERSION = '0.1.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const PLATFORMS = ['youtube', 'instagram', 'tiktok'];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  return 'unknown';
}

function normalize(url) {
  if (/youtu\.be\/([A-Za-z0-9_-]{6,})/.test(url)) {
    return `https://www.youtube.com/watch?v=${RegExp.$1}`;
  }
  return url.split('?')[0].includes('youtube.com/shorts')
    ? url.replace('/shorts/', '/watch?v=')
    : url;
}

/** 从 `key = {` 起做花括号配对，避免正则在嵌套对象上失手 */
function extractJsonObject(text, startIndex) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function findPlayerResponse(html) {
  const markers = ['ytInitialPlayerResponse = ', 'var ytInitialPlayerResponse = '];
  for (const marker of markers) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const raw = extractJsonObject(html, at + marker.length - 1);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* 继续尝试下一个 marker */
      }
    }
  }
  return null;
}

function decodeEscapes(str) {
  return str
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* 平台解析器                                                          */
/* ------------------------------------------------------------------ */

async function parseYouTube(url) {
  const target = normalize(url);
  const res = await fetch(`${target}${target.includes('?') ? '&' : '?'}hl=en&has_verified=1`, {
    credentials: 'include',
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`YouTube 返回 HTTP ${res.status}`);

  const html = await res.text();
  const pr = findPlayerResponse(html);
  if (!pr) throw new Error('未能读取播放数据（页面结构变化或触发风控）');

  const status = pr.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new Error(pr.playabilityStatus?.reason || `播放受限：${status}`);
  }

  const details = pr.videoDetails || {};
  const streaming = pr.streamingData || {};
  // 只取未加密的 url；signatureCipher 需要跑播放器 JS 解密，扩展里不做
  const candidates = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])]
    .filter((f) => f.url && f.mimeType && f.mimeType.includes('video/mp4'))
    .map((f) => ({
      url: f.url,
      width: f.width || 0,
      height: f.height || 0,
      bitrate: f.bitrate || 0,
      hasAudio: Boolean(f.audioCodec),
      hasVideo: Boolean(f.videoCodec || f.width),
    }));

  if (!candidates.length) {
    throw new Error('未找到可用直链（可能需要登录，或该视频使用了加密签名）');
  }

  // 优先带音轨的（渐进式），其次按分辨率降序
  candidates.sort(
    (a, b) => Number(b.hasAudio) - Number(a.hasAudio) || b.height - a.height || b.bitrate - a.bitrate,
  );
  const best = candidates[0];
  const withAudio = candidates.filter((c) => c.hasAudio);

  const thumbs = details.thumbnail?.thumbnails || [];
  const cover = thumbs.length ? thumbs[thumbs.length - 1].url : '';

  return {
    id: details.videoId || uid(),
    originalUrl: url,
    platform: 'youtube',
    title: details.title || 'youtube_video',
    author: { name: details.author || 'Unknown' },
    duration: Number(details.lengthSeconds || 0),
    coverUrl: cover,
    // 无音轨时把最佳音频源作为备选，前端可提示
    downloadUrl: best.url,
    fallbackUrls: withAudio.slice(1, 4).map((c) => c.url),
    dimensions: best.width ? { width: best.width, height: best.height } : undefined,
    hasWatermark: false,
    provider: 'extension:user-ip',
    expiresAt: Date.now() + 6 * 3600 * 1000,
  };
}

async function parseInstagram(url) {
  const match = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/.exec(url);
  if (!match) throw new Error('无法从链接中解析出 Instagram 短代码');
  const code = match[1];

  let videoUrl = '';
  let title = 'instagram_reel';
  let author = 'Unknown';
  let cover = '';
  let duration = 0;

  // 路径一：已登录时请求私有接口，画质最好
  try {
    const api = await fetch(`https://www.instagram.com/api/v1/media/${code}/info/`, {
      credentials: 'include',
      headers: { 'User-Agent': UA, 'X-IG-App-ID': '936619743392459' },
    });
    if (api.ok) {
      const json = await api.json();
      const item = json?.items?.[0];
      const versions = item?.video_versions || [];
      if (versions.length) {
        videoUrl = versions[0].url;
        title = item?.caption?.text?.slice(0, 80) || code;
        author = item?.user?.username || author;
        cover = item?.image_versions2?.candidates?.[0]?.url || '';
        duration = Math.round((item?.video_duration || 0) * 10) / 10;
      }
    }
  } catch {
    /* 落到路径二 */
  }

  // 路径二：embed 端点，无需登录也能拿到部分公开内容
  if (!videoUrl) {
    const embed = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
      credentials: 'include',
      headers: { 'User-Agent': UA },
    });
    if (!embed.ok) throw new Error(`Instagram 返回 HTTP ${embed.status}`);
    const html = await embed.text();

    const m = /"video_url"\s*:\s*"([^"]+)"/.exec(html) || /<video[^>]+src="([^"]+)"/.exec(html);
    if (m) videoUrl = decodeEscapes(m[1]);
    const t = /"title"\s*:\s*"([^"]+)"/.exec(html);
    if (t) title = decodeEscapes(t[1]).slice(0, 80) || code;
    const c = /"thumbnail_url"\s*:\s*"([^"]+)"/.exec(html);
    if (c) cover = decodeEscapes(c[1]);
    const d = /"video_duration"\s*:\s*([\d.]+)/.exec(html);
    if (d) duration = Number(d[1]);
  }

  if (!videoUrl) {
    throw new Error('未取到视频直链（该内容可能需要登录，或已被限制）');
  }

  return {
    id: code,
    originalUrl: url,
    platform: 'instagram',
    title,
    author: { name: author },
    duration,
    coverUrl: cover,
    downloadUrl: videoUrl,
    hasWatermark: false,
    provider: 'extension:user-ip',
  };
}

async function parseTikTok(url) {
  const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const res = await fetch(api, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TikWM 返回 HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(json.msg || 'TikWM 解析失败');
  }
  const d = json.data;
  const direct = d.hdplay || d.play || d.wmplay;
  if (!direct) throw new Error('TikWM 未返回视频直链');

  return {
    id: d.id || uid(),
    originalUrl: url,
    platform: 'tiktok',
    title: d.title || 'tiktok_video',
    author: { name: d.author?.unique_id || 'Unknown', avatar: d.author?.avatar },
    duration: Number(d.duration || 0),
    coverUrl: d.cover || d.origin_cover || '',
    downloadUrl: direct,
    hasWatermark: false,
    provider: 'extension:tikwm',
  };
}

async function parseVideo(url, platform) {
  const kind = platform || detectPlatform(url);
  if (kind === 'youtube') return parseYouTube(url);
  if (kind === 'instagram') return parseInstagram(url);
  if (kind === 'tiktok') return parseTikTok(url);
  throw new Error(`插件暂不支持该平台：${kind}`);
}

/* ------------------------------------------------------------------ */
/* 登录态探测                                                          */
/* ------------------------------------------------------------------ */

const LOGIN_COOKIES = {
  youtube: { domain: 'youtube.com', names: ['LOGIN_INFO', 'SID', 'HSID'] },
  instagram: { domain: 'instagram.com', names: ['ds_user_id', 'sessionid'] },
  tiktok: { domain: 'tiktok.com', names: ['sessionid', 'sessionid_ss'] },
};

async function detectAuthed() {
  const authed = [];
  for (const [platform, cfg] of Object.entries(LOGIN_COOKIES)) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: cfg.domain });
      const hit = cookies.some((c) => cfg.names.includes(c.name));
      if (hit) authed.push(platform);
    } catch {
      /* 无 cookies 权限时静默跳过 */
    }
  }
  return authed;
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

/** id -> chrome.downloads.downloadId，供进度轮询 */
const downloads = new Map();

const handlers = {
  async HELLO() {
    return {
      version: VERSION,
      platforms: PLATFORMS,
      authed: await detectAuthed(),
      downloadApi: Boolean(chrome.downloads),
    };
  },

  async PARSE({ url, platform }) {
    if (!url) throw new Error('缺少链接');
    return parseVideo(url, platform);
  },

  async DOWNLOAD({ url, filename, referer }) {
    if (!chrome.downloads) throw new Error('当前环境不支持下载 API');
    if (!url) throw new Error('缺少下载直链');

    const id = uid();
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: filename && filename.endsWith('.mp4') ? filename : `${filename || 'video'}.mp4`,
          conflictAction: 'uniquify',
          saveAs: false,
        },
        (resultId) => {
          const err = chrome.runtime.lastError;
          if (err || resultId === undefined) reject(new Error(err?.message || '下载启动失败'));
          else resolve(resultId);
        },
      );
    });
    downloads.set(id, downloadId);
    return { downloadId, id };
  },

  async DOWNLOAD_STATE({ downloadId }) {
    if (!chrome.downloads) throw new Error('当前环境不支持下载 API');
    const items = await new Promise((resolve, reject) => {
      chrome.downloads.search({ id: Number(downloadId) }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res || []);
      });
    });
    const item = items[0];
    if (!item) throw new Error('找不到该下载任务');
    return {
      state: item.state,
      bytesReceived: item.bytesReceived || 0,
      totalBytes: item.totalBytes || item.fileSize || 0,
      error: item.error || undefined,
    };
  },

  async DOWNLOAD_CANCEL({ downloadId }) {
    if (!chrome.downloads) return { ok: false };
    await new Promise((resolve) => chrome.downloads.cancel(Number(downloadId), resolve));
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== PROTOCOL) return false;

  const handler = handlers[message.action];
  if (!handler) {
    sendResponse({ ok: false, error: `未知指令：${message.action}` });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || '处理失败' }));

  // 返回 true 以保持 sendResponse 通道在异步期间有效
  return true;
});
