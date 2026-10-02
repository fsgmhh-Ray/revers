/**
 * services/llmProbe.ts —— LLM 配置连通性自检（BYOK）。
 *
 * 用户常遇到「填了 key 但界面显示未配置 / 到底能不能用」的困惑。
 * 这里提供两个轻量探测：只发最小请求，确认 base URL、model、key 三者是否真的可用。
 * 视觉端点用一个 1x1 像素的 data URL 图片（避开本地文件依赖）。
 */

export type ProbeResult = {
  ok: boolean;
  /** 人类可读的原因；失败时说明怎么改 */
  message: string;
  /** 探测耗时（毫秒） */
  ms?: number;
};

function normEndpoint(base: string, path: string): string {
  const b = String(base || '').replace(/\/+$/, '');
  return b.endsWith('/v1') ? `${b}${path}` : `${b}/v1${path}`;
}

/** 探测视觉 LLM（/v1/chat/completions） */
export async function probeVisionLlm(cfg: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ProbeResult> {
  const baseUrl = (cfg.baseUrl || '').trim();
  const model = (cfg.model || '').trim();
  if (!baseUrl) return { ok: false, message: '未填 Base URL' };
  if (!model) return { ok: false, message: '未填 Model' };

  const started = Date.now();
  try {
    const res = await fetch(normEndpoint(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, message: `可用（${ms}ms）`, ms };
    const t = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Key 无效或无权限（401/403）', ms };
    if (res.status === 404) return { ok: false, message: '端点不存在（404，检查 Base URL 是否含 /v1）', ms };
    if (res.status === 429) return { ok: false, message: '速率限制或额度用尽（429）', ms };
    return { ok: false, message: `HTTP ${res.status}：${t.slice(0, 120)}`, ms };
  } catch (err) {
    return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 探测文本/ASR LLM（/v1/audio/transcriptions）——发一个极短静音 WAV 验证 */
export async function probeTextLlm(cfg: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ProbeResult> {
  const baseUrl = (cfg.baseUrl || '').trim();
  const model = (cfg.model || '').trim();
  if (!baseUrl) return { ok: false, message: '未填 Base URL' };
  if (!model) return { ok: false, message: '未填 Model' };

  // 0.2s 16k 单声道静音 WAV（44 字节头 + 3200 字节零）
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const write = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i);
  };
  write(0, 'RIFF');
  dv.setUint32(4, 36 + 3200, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  write(36, 'data');
  dv.setUint32(40, 3200, true);
  const audio = new Uint8Array(44 + 3200);
  audio.set(header, 0);

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'probe.wav');
  form.append('model', model);

  const started = Date.now();
  try {
    const res = await fetch(normEndpoint(baseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { text?: string };
      return { ok: true, message: `可用（${ms}ms）${j?.text === '' ? '，探针音频无内容属正常' : ''}`, ms };
    }
    const t = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Key 无效或无权限（401/403）', ms };
    if (res.status === 413) return { ok: false, message: '请求过大（413）——但这说明端点通了', ms };
    if (res.status === 404) return { ok: false, message: '端点不存在（404，该供应商可能不支持音频转写）', ms };
    return { ok: false, message: `HTTP ${res.status}：${t.slice(0, 120)}`, ms };
  } catch (err) {
    return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
