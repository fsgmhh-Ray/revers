import type { ApiHandler } from '../_lib/types';
import { corsPreflight, detectPlatform, json } from '../_lib/http';
import { ProviderError, resolveVideo } from '../_lib/providers';

export const onRequestOptions: ApiHandler = async () => corsPreflight();

/** GET /api/parse —— 健康检查与当前解析链配置 */
export const onRequestGet: ApiHandler = async (ctx) => {
  const { env } = ctx;
  return json({
    ok: true,
    service: 'reverse.cineflowing.com / parse-gateway',
    providers: {
      mock: env.MOCK_PARSER === '1',
      cobalt: Boolean(env.COBALT_INSTANCE_URL),
      ytdlp: Boolean(env.YTDLP_SERVICE_URL),
      tikwm: env.TIKWM_API_URL !== 'off',
    },
  });
};

/** POST /api/parse —— { url } -> 统一 VideoMetadata */
export const onRequestPost: ApiHandler = async (ctx) => {
  let payload: { url?: string };
  try {
    payload = (await ctx.request.json()) as { url?: string };
  } catch {
    return json({ success: false, error: '请求体必须是 JSON' }, 400);
  }

  const url = (payload?.url || '').trim();
  if (!url) return json({ success: false, error: 'URL 不能为空' }, 400);

  let normalized = url;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  try {
    new URL(normalized);
  } catch {
    return json({ success: false, error: 'URL 格式不合法' }, 400);
  }

  const platform = detectPlatform(normalized);
  if (platform === 'unknown') {
    return json(
      { success: false, error: '暂不支持该平台（当前支持 TikTok / Instagram Reels / YouTube Shorts / 抖音 / 小红书）' },
      422,
    );
  }

  try {
    const result = await resolveVideo(normalized, platform, ctx.env);
    return json({
      success: true,
      data: { ...result.data, provider: result.provider },
      provider: result.provider,
    });
  } catch (err: any) {
    const known = err instanceof ProviderError;
    return json(
      { success: false, error: err?.message || '解析失败', hint: known ? '请检查解析内核配置或稍后重试' : undefined },
      known ? 502 : 500,
    );
  }
};
