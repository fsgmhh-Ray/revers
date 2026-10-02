/**
 * lib/llm.js —— 通用 OpenAI 兼容多模态 LLM 客户端（BYOK，密钥不落盘）。
 *
 * 设计目标：用户在前端填 base URL + key + model，可接任何兼容端点：
 *   - NVIDIA NIM (https://integrate.api.nvidia.com/v1)
 *   - Groq (https://api.groq.com/openai/v1)
 *   - DeepSeek (https://api.deepseek.com/v1)
 *   - Grok / xAI (https://api.x.ai/v1)
 *   - OpenAI (https://api.openai.com/v1)
 * 视觉（反推提示词）走 /v1/chat/completions；旁白（转写）走 /v1/audio/transcriptions。
 */
import { readFile } from 'node:fs/promises';
import { File, Blob } from 'node:buffer';

function normBase(base) {
  if (!base) throw new Error('缺少 LLM base URL（请在设置里填写，例如 https://api.groq.com/openai/v1）');
  return base.replace(/\/+$/, '');
}

/**
 * 拼接 OpenAI 兼容端点路径。
 * 用户常把 base 填到 /v1（OpenAI 文档惯例，如 https://host/v1），
 * 也可能只填到 host。两种都兼容，避免拼成 /v1/v1 这种 404。
 */
function endpoint(base, path) {
  const b = normBase(base);
  return b.endsWith('/v1') ? `${b}${path}` : `${b}/v1${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 多模态视觉调用：传入若干 base64 JPEG 帧 + 文本，返回模型原始文本。
 * 不强制 response_format，兼容更多免费端点；由调用方做 JSON 解析。
 */
export async function callVision({ baseUrl, apiKey, model, frames, system, userText, temperature = 0.4 }) {
  const url = endpoint(baseUrl, '/chat/completions');
  const imageParts = frames.map((f) => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${f.b64}`, detail: 'auto' },
  }));
  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        ...imageParts,
      ],
    },
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
    // 强制结构化输出，避免模型返回自然语言导致解析失败（主流兼容端点均支持）
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`视觉 LLM 调用失败 (HTTP ${res.status}): ${t.slice(0, 280)}`);
  }
  const j = await res.json().catch(() => ({}));
  const content = j?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('视觉 LLM 返回为空');
  return content;
}

/**
 * 语音转写：把本地音频文件 POST 到 /v1/audio/transcriptions（OpenAI 兼容）。
 * 注意：DeepSeek 等不支持音频的端点会报错，调用方需提示用户换用支持音频的供应商
 * （Groq whisper-large-v3 / OpenAI / NVIDIA NIM whisper）。
 *
 * 长音频兜底：Groq 等免费端点有硬体积上限（实测 25MB，16k 单声道 ≈13 分钟），
 * 超过会返回 HTTP 413 request_too_large。超过阈值时自动按静音点切块、逐块转写后拼接，
 * 不需要第二个供应商凭据。详见 splitWavChunks。
 */
export async function transcribe({ baseUrl, apiKey, model, audioPath, language }) {
  const url = endpoint(baseUrl, '/audio/transcriptions');
  const buf = await readFile(audioPath);

  // 体积在阈值内：走单次调用（保持原有行为与性能）。
  if (buf.length <= MAX_AUDIO_BYTES) {
    return await transcribeOnce({ url, apiKey, model, language, audio: buf });
  }

  // 超出阈值：切块后逐块转写并拼接。
  const chunks = splitWavChunks(buf, MAX_AUDIO_BYTES);
  if (chunks.length <= 1) {
    return await transcribeOnce({ url, apiKey, model, language, audio: buf });
  }
  const parts = [];
  for (const [i, chunk] of chunks.entries()) {
    const text = await transcribeOnce({ url, apiKey, model, language, audio: chunk });
    if (text) parts.push(text.trim());
    // 进度日志，便于在容器日志里定位卡在哪一段。
    console.log(`[llm] 转写分块 ${i + 1}/${chunks.length} 完成（${(chunk.length / 1048576).toFixed(1)}MB）`);
  }
  const merged = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!merged) throw new Error('转写返回为空（所有分块均无内容）');
  return merged;
}

/** 单块转写（内部）：POST 一段 WAV 到 OpenAI 兼容端点并取回文本。 */
async function transcribeOnce({ url, apiKey, model, language, audio }) {
  const file = new File([new Blob([audio])], 'audio.wav', { type: 'audio/wav' });
  const form = new FormData();
  form.append('file', file);
  form.append('model', model || 'whisper-1');
  if (language) form.append('language', language);

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const hint = /audio|transcri|whisper|file/i.test(t)
      ? ' 该供应商可能不支持音频转写，建议改用 Groq(whisper-large-v3) / OpenAI / NVIDIA NIM。'
      : '';
    throw new Error(`转写失败 (HTTP ${res.status}): ${t.slice(0, 220)}${hint}`);
  }
  const j = await res.json().catch(() => ({}));
  const text = j?.text || j?.transcript || (typeof j === 'string' ? j : '');
  if (!text) throw new Error('转写返回为空（供应商未返回 text 字段）');
  return text;
}

/**
 * 单次转写的音频体积上限（字节）。Groq 免费端点实测 25MB 即 413，
 * 这里留 2MB 余量（24MB），避免 multipart 边界把请求顶过线。
 */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * 把一个 WAV 缓冲区按体积上限切成多个合法 WAV 块。
 *
 * 关键点：切点尽量落在「静音处」，避免把一个词切成两半导致识别质量下降。
 * 做法：解析 16-bit PCM WAV 头 → 逐样本算短时能量 → 在能量低于阈值的帧里
 * 找最接近目标切点的位置。找不到静音就硬切（质量略降但不会失败）。
 *
 * 非 16-bit PCM（如浮点/8bit）或非 WAV（webm/mp3 等）时返回 []，由调用方回退单次。
 */
function splitWavChunks(buf, maxBytes) {
  // 解析 RIFF/WAVE，找 fmt 与 data 块。
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return [];
  }
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }
  if (!fmt || dataStart < 0) return [];
  // 只处理 16-bit PCM（内核 ffmpeg 抽轨固定 -ar 16000 -ac 1，样本宽 16）。
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return [];

  const bytesPerFrame = 2 * fmt.channels; // 16bit * channels
  const dataBytes = dataLen;
  // 每块的目标体积（留 44 字节头 + 少量余量）。
  const targetData = maxBytes - 44 - 4096;
  if (dataBytes <= targetData) return [];

  const threshold = targetData - targetData * 0.15; // 在 85% 附近找静音，避免切太晚
  const windowFrames = Math.max(1, Math.floor(fmt.sampleRate * 0.02)); // 20ms 能量窗

  const isSilentAround = (frameIdx) => {
    // 检查 frameIdx 附近一个窗的能量是否低于静音阈值。
    const startFrame = Math.max(0, frameIdx - windowFrames);
    const endFrame = Math.min(dataBytes / bytesPerFrame, frameIdx + windowFrames);
    let peak = 0;
    for (let f = startFrame; f < endFrame; f++) {
      const off = dataStart + f * bytesPerFrame;
      const s = Math.abs(buf.readInt16LE(off));
      if (s > peak) peak = s;
    }
    return peak < 900; // 静音阈值（16bit 满幅 32767，900≈-31dB）
  };

  const chunks = [];
  let segStart = 0; // 相对 dataStart 的字节偏移
  const totalFrames = Math.floor(dataBytes / bytesPerFrame);
  let frame = 0;

  while (segStart < dataBytes) {
    const remaining = dataBytes - segStart;
    if (remaining <= targetData) {
      chunks.push(makeWav(buf, fmt, dataStart + segStart, dataBytes - segStart));
      break;
    }
    // 目标切点（帧）
    const targetFrame = Math.floor((segStart + threshold) / bytesPerFrame);
    // 在目标附近 ±5s 搜索静音帧。
    const searchRadius = fmt.sampleRate * 5;
    let cutFrame = -1;
    for (let f = targetFrame; f < Math.min(totalFrames, targetFrame + searchRadius); f++) {
      if (isSilentAround(f)) {
        cutFrame = f;
        break;
      }
    }
    let cutByte;
    if (cutFrame > 0) {
      cutByte = cutFrame * bytesPerFrame;
    } else {
      // 找不到静音 → 硬切在目标点（略提前，避免超限）。
      cutByte = Math.floor(threshold);
    }
    const len = cutByte;
    if (len <= 0) break;
    chunks.push(makeWav(buf, fmt, dataStart + segStart, len));
    segStart += len;
    frame = segStart / bytesPerFrame;
  }
  return chunks;
}

/** 从源 WAV 缓冲区的 data 段切出一段，拼成独立合法 WAV 文件。 */
function makeWav(buf, fmt, dataOffset, dataLen) {
  const header = Buffer.alloc(44);
  const byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((fmt.channels * fmt.bitsPerSample) / 8, 32); // block align
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, buf.subarray(dataOffset, dataOffset + dataLen)]);
}
