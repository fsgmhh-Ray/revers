import type { ApiHandler } from '../_lib/types';
import { json, corsPreflight } from '../_lib/http';

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/** POST /api/narration —— 边缘网关：把完整旁白/转写请求代理到 parser-core 内核 */
export const onRequestPost: ApiHandler = async (ctx) => {
  const base = (ctx.env.COBALT_INSTANCE_URL || '').replace(/\/+$/, '');
  if (!base) return json({ success: false, error: '解析内核未配置（Pages 环境变量缺少 COBALT_INSTANCE_URL）' }, 502);

  let body: { url?: string } & Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return json({ success: false, error: '请求体必须是 JSON' }, 400);
  }
  if (!body?.url) return json({ success: false, error: 'url 不能为空' }, 400);

  const kernelUrl = `${base}/api/narration`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.env.COBALT_API_KEY) headers['Authorization'] = `Api-Key ${ctx.env.COBALT_API_KEY}`;

  try {
    const upstream = await fetch(kernelUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    return json({ success: false, error: `内核不可达：${err?.message || 'unknown'}（请确认 Oracle VPS 内核已启动且 cloudflared 已连接）` }, 502);
  }
};
