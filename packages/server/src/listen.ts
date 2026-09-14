import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { MemnestServer } from './app';
import { createDashboardHandler } from './dashboard';

export interface ListeningServer {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  port: number;
  /** Stops accepting connections and ends open ones, including SSE streams. */
  close(): Promise<void>;
}

export interface ListenOptions {
  /** Default 8787. */
  port?: number;
  /** Default 127.0.0.1: listening on every interface is an explicit choice. */
  hostname?: string;
  /** A built dashboard directory to serve from the same origin as the API. */
  dashboard?: string;
}

/** Serves on Node's HTTP server. */
export function listen(server: MemnestServer, options: ListenOptions = {}): Promise<ListeningServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const dashboard = options.dashboard ? createDashboardHandler(options.dashboard) : null;
  const fetch = dashboard ? async (request: Request) => (await dashboard(request)) ?? server.fetch(request) : server.fetch;
  return new Promise((resolve, reject) => {
    const http = serve({ fetch, port: options.port ?? 8787, hostname }, (info: AddressInfo) => {
      const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
      resolve({
        url: `http://${host}:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            (http as Server).close((error) => (error ? fail(error) : done()));
            (http as Server).closeAllConnections();
          }),
      });
    }) as Server;
    http.once('error', reject);
  });
}
