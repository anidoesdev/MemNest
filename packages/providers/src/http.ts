import { ProviderError } from '@memnest/core';

export interface HttpOptions {
  /** Custom fetch, e.g. for proxies or tests. Default: global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries on network errors, timeouts, 408/409/429 and 5xx. Default 3. */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function trimBaseURL(url: string): string {
  return url.replace(/\/+$/, '');
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * base * 0.25);
}

export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: HttpOptions & { timeoutMs: number },
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...options.headers, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      const message =
        name === 'TimeoutError' || name === 'AbortError'
          ? `request to ${url} timed out after ${options.timeoutMs}ms`
          : `could not reach ${url}: ${(error as Error)?.message ?? error}`;
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new ProviderError(provider, message, { retryable: true });
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new ProviderError(provider, `non-JSON response from ${url}`, { status: response.status, retryable: false });
      }
    }

    const status = response.status;
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    if (retryable && attempt < maxRetries) {
      await sleep(retryAfterMs(response) ?? backoffMs(attempt));
      continue;
    }
    throw new ProviderError(provider, `HTTP ${status} from ${url}: ${text.slice(0, 500)}`, { status, retryable });
  }
}

/** Parses model output as JSON, tolerating a markdown code fence around it. */
export function parseModelJson(provider: string, content: unknown): unknown {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ProviderError(provider, 'model returned no content', { retryable: true });
  }
  const unfenced = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new ProviderError(provider, `model returned invalid JSON: ${unfenced.slice(0, 200)}`, { retryable: true });
  }
}

export function toFloat32(provider: string, vector: unknown, expected: number): Float32Array {
  if (!Array.isArray(vector)) throw new ProviderError(provider, 'embedding response is malformed', { retryable: false });
  if (vector.length !== expected) {
    throw new ProviderError(
      provider,
      `embedding has ${vector.length} dimensions but the provider is configured for ${expected}; set dimensions to match the model`,
      { retryable: false },
    );
  }
  return Float32Array.from(vector as number[]);
}
