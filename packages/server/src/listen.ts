import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { MemnestServer } from './app';

export interface ListeningServer {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  port: number;
  /** Stops accepting connections and ends open ones, including SSE streams. */
  close(): Promise<void>;
}

/** Serves on Node's HTTP server. Default host 127.0.0.1: listening on every interface is an explicit choice. */
export function listen(server: MemnestServer, options: { port?: number; hostname?: string } = {}): Promise<ListeningServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    const http = serve({ fetch: server.fetch, port: options.port ?? 8787, hostname }, (info: AddressInfo) => {
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
