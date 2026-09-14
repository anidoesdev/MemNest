import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryAuthStore, createMemnest } from '@memnest/core';
import { createInMemoryStore } from '@memnest/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboardHandler, createServer, listen, type ListeningServer } from '../src/index';

describe('serving the dashboard', () => {
  let root: string;
  let outside: string;
  let http: ListeningServer;

  beforeAll(async () => {
    const parent = mkdtempSync(join(tmpdir(), 'memnest-dashboard-'));
    root = join(parent, 'dist');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Memnest</title>');
    writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
    outside = join(parent, 'secret.txt');
    writeFileSync(outside, 'not for the browser');
    const server = createServer({ memnest: createMemnest({ store: createInMemoryStore() }), auth: createInMemoryAuthStore() });
    http = await listen(server, { port: 0, dashboard: root });
  });

  afterAll(async () => {
    await http.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('serves the app with security headers, and hashed assets as immutable', async () => {
    const page = await fetch(`${http.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const asset = await fetch(`${http.url}/assets/index-abc123.js`);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for app routes, but 404s missing files', async () => {
    expect(await (await fetch(`${http.url}/graph`)).text()).toContain('<title>Memnest</title>');
    expect((await fetch(`${http.url}/assets/missing.js`)).status).toBe(404);
  });

  it('never serves API paths from disk, and never leaves the root', async () => {
    const api = await fetch(`${http.url}/v1/memories?containerTag=user:1`);
    expect(api.status).toBe(401);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    expect((await fetch(`${http.url}/healthz`)).status).toBe(200);

    const handler = createDashboardHandler(root);
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt']) {
      const response = await handler(new Request(`http://memnest.test${path}`));
      expect(response === null ? '' : await response.text(), path).not.toContain('not for the browser');
    }
    expect(await handler(new Request('http://memnest.test/', { method: 'POST' }))).toBeNull();
    expect((await handler(new Request('http://memnest.test/%E0%A4%A')))!.status).toBe(400);
  });
});
