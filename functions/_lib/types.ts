/**
 * 与 Cloudflare Pages Functions 兼容的最小契约类型。
 * 生产环境由 Pages 运行时注入，本地开发由 vite-plugin-dev-api 构造同样的上下文。
 */
export interface Env {
  COBALT_INSTANCE_URL?: string;
  COBALT_API_KEY?: string;
  TIKWM_API_URL?: string;
  YTDLP_SERVICE_URL?: string;
  ALLOWED_DOWNLOAD_HOSTS?: string;
  MAX_DOWNLOAD_BYTES?: string;
  MOCK_PARSER?: string;
  ALLOW_ANY_HOST?: string;
  [key: string]: string | undefined;
}

export interface ApiContext<E = Env> {
  request: Request;
  env: E;
  waitUntil: (promise: Promise<unknown>) => void;
}

export type ApiHandler<E = Env> = (ctx: ApiContext<E>) => Response | Promise<Response>;
