import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** The dashboard needs nothing from other origins; it may not be framed. */
export const DASHBOARD_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const isApi = (path: string) => path === '/healthz' || path === '/v1' || path.startsWith('/v1/');

/**
 * Serves a built dashboard (`apps/dashboard/dist`) from the server's origin, so the session cookie and
 * the API need no CORS. API paths are never served from disk. Paths without an extension fall back to
 * index.html; anything resolving outside the root is refused.
 */
export function createDashboardHandler(root: string): (request: Request) => Promise<Response | null> {
  const base = resolve(root);
  const index = join(base, 'index.html');

  const file = async (path: string, status = 200): Promise<Response> => {
    const body = await readFile(path);
    const immutable = path.startsWith(join(base, 'assets') + sep);
    return new Response(body, {
      status,
      headers: {
        ...DASHBOARD_HEADERS,
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  };

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const { pathname } = new URL(request.url);
    if (isApi(pathname)) return null;

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response('bad path', { status: 400, headers: DASHBOARD_HEADERS });
    }
    if (decoded.includes('\0')) return new Response('bad path', { status: 400, headers: DASHBOARD_HEADERS });
    const target = resolve(base, `.${decoded}`);
    if (target !== base && !target.startsWith(base + sep)) return new Response('not found', { status: 404, headers: DASHBOARD_HEADERS });

    const info = await stat(target).catch(() => null);
    if (info?.isFile()) return file(target);
    if (info?.isDirectory() || !extname(decoded)) return file(index);
    return new Response('not found', { status: 404, headers: DASHBOARD_HEADERS });
  };
}
