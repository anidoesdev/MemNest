import type { Readable, Writable } from 'node:stream';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMemnestMcpServer, type MemnestMcpOptions } from './server';

export interface ServeMemnestStdioOptions extends MemnestMcpOptions {
  /** Default `process.stdin`. */
  stdin?: Readable;
  /** Default `process.stdout`. Nothing else may write to it: it carries the protocol. */
  stdout?: Writable;
  onerror?: (error: Error) => void;
}

export interface MemnestStdioHandle {
  /** Resolves when the client disconnects (its end of stdin closes). */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Serves the Memnest MCP server over stdio, the transport local MCP clients launch servers with. */
export function serveMemnestStdio(options: ServeMemnestStdioOptions): MemnestStdioHandle {
  const { stdin = process.stdin, stdout = process.stdout, onerror, ...serverOptions } = options;
  const closed = new Promise<void>((resolve) => {
    stdin.once('end', resolve);
    stdin.once('close', resolve);
  });
  const handle = serveStdio(() => createMemnestMcpServer(serverOptions), {
    transport: new StdioServerTransport(stdin, stdout),
    ...(onerror ? { onerror } : {}),
  });
  return { closed, close: () => handle.close() };
}
