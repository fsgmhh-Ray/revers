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

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 多模态视觉调用：传入若干 base64 JPEG 帧 + 文本，返回模型原始文本。
 * 不强制 response_format，兼容更多免费端点；由调用方做 JSON 解析。
 */
export async function callVision({ baseUrl, apiKey, model, frames, system, userText, temperature = 0.4 }) {
  const url = `${normBase(baseUrl)}/v1/chat/completions`;
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
    body: JSON.stringify({ model, messages, temperature, max_tokens: 4096 }),
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
 */
export async function transcribe({ baseUrl, apiKey, model, audioPath, language }) {
  const url = `${normBase(baseUrl)}/v1/audio/transcriptions`;
  const buf = await readFile(audioPath);
  const file = new File([new Blob([buf])], 'audio.wav', { type: 'audio/wav' });

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
