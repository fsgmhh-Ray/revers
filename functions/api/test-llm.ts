import type { ApiHandler } from '../_lib/types';
import { json, corsPreflight } from '../_lib/http';

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/**
 * POST /api/test-llm —— LLM 配置连通性自测（服务端代理）。
 *
 * 为什么需要：NVIDIA 等供应商的 CORS 预检响应里没有 Access-Control-Allow-Origin，
 * 浏览器直接 fetch 必然 "Failed to fetch"，但请求本身完全合法。
 * 这里由 Pages Functions 转发，绕开浏览器 CORS 限制。
 *
 * body: { kind: 'vision'|'text', baseUrl, apiKey, model }
 * 返回: { ok, message }
 */
export const onRequestPost: ApiHandler = async (ctx) => {
  let body: { kind?: string; baseUrl?: string; apiKey?: string; model?: string };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: '请求体必须是 JSON' }, 400);
  }

  const base = String(body?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(body?.model || '').trim();
  const kind = body?.kind === 'text' ? 'text' : 'vision';

  if (!base) return json({ ok: false, message: '未填 Base URL' }, 200);
  if (!model) return json({ ok: false, message: '未填 Model' }, 200);

  // 用户可能填到 /v1 或只填 host，这里都兼容
  const root = base.endsWith('/v1') ? base : `${base}/v1`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;

  const started = Date.now();
  try {
    if (kind === 'text') {
      const form = new FormData();
      // 0.2s 16k mono 静音 WAV（44 字节头 + 3200 字节零）
      const header = new Uint8Array(44);
      const dv = new DataView(header.buffer);
      const put = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i);
      };
      put(0, 'RIFF');
      dv.setUint32(4, 36 + 3200, true);
      put(8, 'WAVE');
      put(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true);
      dv.setUint32(24, 16000, true);
      dv.setUint32(28, 32000, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      put(36, 'data');
      dv.setUint32(40, 3200, true);
      const audio = new Uint8Array(44 + 3200);
      audio.set(header, 0);
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'probe.wav');
      form.append('model', model);

      const fh: Record<string, string> = {};
      if (body.apiKey) fh.Authorization = `Bearer ${body.apiKey}`;
      const upstream = await fetch(`${root}/audio/transcriptions`, { method: 'POST', headers: fh, body: form });
      const ms = Date.now() - started;
      if (upstream.ok) {
        return json({ ok: true, message: `可用（${ms}ms，探针音频无内容属正常）` });
      }
      const t = await upstream.text().catch(() => '');
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ ok: false, message: 'Key 无效或无权限（401/403）' });
      }
      if (upstream.status === 404) {
        return json({ ok: false, message: '该端点不存在（404）——此供应商可能不支持音频转写' });
      }
      return json({ ok: false, message: `HTTP ${upstream.status}：${t.slice(0, 140)}` });
    }

    const upstream = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    const ms = Date.now() - started;
    if (upstream.ok) return json({ ok: true, message: `可用（${ms}ms）` });
    const t = await upstream.text().catch(() => '');
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ ok: false, message: 'Key 无效或无权限（401/403）' });
    }
    if (upstream.status === 404) {
      return json({ ok: false, message: '端点不存在（404，检查 Base URL 是否含 /v1）' });
    }
    if (upstream.status === 429) {
      return json({ ok: false, message: '速率限制或额度用尽（429）' });
    }
    return json({ ok: false, message: `HTTP ${upstream.status}：${t.slice(0, 140)}` });
  } catch (err: any) {
    return json({ ok: false, message: `连接失败：${err?.message || 'unknown'}` });
  }
};
