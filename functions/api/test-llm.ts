import type { ApiHandler } from '../_lib/types';
import { json, corsPreflight } from '../_lib/http';

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/**
 * 把用户填的 Base URL 归一化成 `…/v1` 形态。
 *
 * 与桌面端 desktop/ipc.js 的 normalizeBaseUrl 保持完全一致（同一套契约）：
 * 末尾带斜线（复制地址栏的常见形态）或误粘完整端点，都会拼出 `/v1//v1/...`
 * 这种 404 路径。这里统一处理，四种写法都收敛到同一个结果。
 */
function normalizeBaseUrl(raw: unknown): string {
  let b = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  b = b.replace(/\/(chat\/completions|completions|audio\/transcriptions|audio\/translations|models)$/i, '');
  b = b.replace(/\/+$/, '');
  if (!/\/v\d+[a-z]*$/i.test(b)) b = `${b}/v1`;
  return b;
}

/** 带超时的 fetch —— 代理侧不能让供应商的冷启动把 Pages Function 一起拖死 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err: any) {
    if (ac.signal.aborted) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）——供应商可能正在冷启动`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

  const rawBase = String(body?.baseUrl || '').trim();
  const model = String(body?.model || '').trim();
  const kind = body?.kind === 'text' ? 'text' : 'vision';

  if (!rawBase) return json({ ok: false, message: '未填 Base URL' }, 200);
  if (!model) return json({ ok: false, message: '未填 Model' }, 200);

  const root = normalizeBaseUrl(rawBase);
  // 把规范化结果回报，用户一眼看出「我填的」与「实际请求的」差在哪
  const note = root !== rawBase.replace(/\/+$/, '') ? `（已自动规范为 ${root}）` : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
  // 90B 级视觉模型冷启动实测可达 76s，超时给足余量
  const timeout = kind === 'text' ? 90_000 : 150_000;

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
      const upstream = await fetchWithTimeout(
        `${root}/audio/transcriptions`,
        { method: 'POST', headers: fh, body: form },
        timeout,
      );
      const ms = Date.now() - started;
      if (upstream.ok) {
        return json({ ok: true, message: `可用（${ms}ms，探针音频无内容属正常）${note}` });
      }
      const t = await upstream.text().catch(() => '');
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ ok: false, message: `Key 无效或无权限（401/403）${note}` });
      }
      if (upstream.status === 404) {
        return json({
          ok: false,
          message: `该端点不存在（404）——此供应商可能不支持音频转写${note} 返回：${t.slice(0, 100) || '(空)'}`,
        });
      }
      return json({ ok: false, message: `HTTP ${upstream.status}：${t.slice(0, 140)}${note}` });
    }

    const upstream = await fetchWithTimeout(
      `${root}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      },
      timeout,
    );
    const ms = Date.now() - started;
    if (upstream.ok) {
      const slow = ms > 20_000 ? `，首次调用约 20–80s 属冷启动正常现象` : '';
      return json({ ok: true, message: `可用（${ms}ms${slow}）${note}` });
    }
    const t = await upstream.text().catch(() => '');
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ ok: false, message: `Key 无效或无权限（401/403）${note}` });
    }
    if (upstream.status === 404) {
      // 供应商对「模型名不存在」也回 404，响应体往往只有一句 "404 page not found"，
      // 所以不能只怪 URL —— 两种可能都要说清楚，并把上游原文带出来。
      return json({
        ok: false,
        message:
          `404：路径或模型名不对${note}。请核对 Base URL 与 Model（NVIDIA 的模型名形如 meta/llama-3.2-11b-vision-instruct）。` +
          ` 上游返回：${t.slice(0, 100) || '(空)'}`,
      });
    }
    if (upstream.status === 429) {
      return json({ ok: false, message: `速率限制或额度用尽（429）${note}` });
    }
    return json({ ok: false, message: `HTTP ${upstream.status}：${t.slice(0, 140)}${note}` });
  } catch (err: any) {
    return json({ ok: false, message: `连接失败：${err?.message || 'unknown'}${note}` });
  }
};
