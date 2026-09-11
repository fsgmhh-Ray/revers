import type { Plugin, ViteDevServer } from 'vite';
import { loadEnv } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 本地开发时复用 functions/ 下的 Cloudflare Pages Functions 源码，
 * 保证 /api/* 在 `npm run dev` 与 Cloudflare 生产环境行为一致（单一代码源）。
 */
interface ApiContext {
  request: Request;
  env: Record<string, string | undefined>;
  waitUntil: (promise: Promise<unknown>) => void;
}

type ApiHandler = (ctx: ApiContext) => Response | Promise<Response>;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function devApiPlugin(): Plugin {
  let server: ViteDevServer;

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith('/api/')) return next();

    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    if (!/^[a-z0-9-]+$/i.test(route)) return next();

    const modulePath = `/functions/api/${route}.ts`;
    try {
      const mod = (await server.ssrLoadModule(modulePath)) as Record<string, unknown>;
      const method = (req.method || 'GET').toUpperCase();
      const handler = (mod[`onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`] ||
        mod.onRequest) as ApiHandler | undefined;

      if (!handler) return next();

      const methodUpper = method;
      const body = methodUpper === 'GET' || methodUpper === 'HEAD' ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }

      const request = new Request(url.toString(), {
        method: methodUpper,
        headers,
        body: body && body.length > 0 ? (new Uint8Array(body) as unknown as BodyInit) : undefined,
      });

      const env = { ...loadEnv(server.config.mode, process.cwd(), ''), ...process.env };
      const response = await handler({ request, env, waitUntil: () => {} });

      const payload = Buffer.from(await response.arrayBuffer());
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) return;
        res.setHeader(key, value);
      });
      res.setHeader('content-length', String(payload.length));
      res.end(payload);
    } catch (err: any) {
      if (String(err?.message || '').includes('Failed to load url')) return next();
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err?.message || 'Dev API Error' }));
    }
  };

  return {
    name: 'reverse-cineflowing:dev-api',
    configureServer(s) {
      server = s;
      s.middlewares.use(handle);
    },
  };
}
