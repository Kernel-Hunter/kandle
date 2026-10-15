import type { FetchLike } from './types';

/**
 * Shared request plumbing for the newer adapters: typed errors with messages a user can act
 * on, a per-provider request budget with backoff after 429, and a small response cache.
 */

export type ProviderErrorKind = 'auth' | 'no-key' | 'rate' | 'plan' | 'not-found' | 'bad-request' | 'network' | 'server';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function rateLimitMessage(seconds: number): string {
  return `Free plan limit reached, try again in ${Math.max(1, Math.ceil(seconds))} s`;
}

export class RateLimitError extends ProviderError {
  constructor(readonly retryAfter: number) {
    super(rateLimitMessage(retryAfter), 'rate', 429);
    this.name = 'RateLimitError';
  }
}

export function missingKeyError(provider: string): ProviderError {
  return new ProviderError(`Add your ${provider} API key in Data sources to load this chart.`, 'no-key');
}

export interface RateLimiterOptions {
  /** Requests allowed in any 60 second window. Leave out for no client-side budget. */
  perMinute?: number;
  now?: () => number;
}

/**
 * Keeps a provider within its free plan. `take()` throws a RateLimitError instead of sending a
 * request that would be refused, and `backoff()` stops all requests for a while after a 429.
 */
export class RateLimiter {
  private stamps: number[] = [];
  private blockedUntil = 0;
  private strikes = 0;
  private readonly now: () => number;

  constructor(private readonly options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Seconds until a request may be sent, 0 when one can go now. */
  wait(): number {
    const now = this.now();
    if (now < this.blockedUntil) return (this.blockedUntil - now) / 1000;
    const limit = this.options.perMinute;
    if (limit) {
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length >= limit) return (this.stamps[0] + 60_000 - now) / 1000;
    }
    return 0;
  }

  take(): void {
    const wait = this.wait();
    if (wait > 0) throw new RateLimitError(wait);
    if (this.options.perMinute) this.stamps.push(this.now());
  }

  /** Call after a 429. Uses the server's Retry-After when given, otherwise 15 s doubling up to 5 min. */
  backoff(retryAfterSeconds?: number): number {
    this.strikes += 1;
    const seconds = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : Math.min(300, 15 * 2 ** (this.strikes - 1));
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
    return seconds;
  }

  success(): void {
    this.strikes = 0;
  }
}

/** Least-recently-used cache with a time to live. */
export class TtlCache<T> {
  private readonly map = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 100,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Retry-After as seconds. Accepts a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? (date - now) / 1000 : undefined;
}

/** What a provider-specific check found wrong with a response. */
export interface Problem {
  kind: ProviderErrorKind;
  message?: string;
  retryAfter?: number;
}

export interface JsonRequest {
  url: string;
  provider: string;
  fetch: FetchLike;
  headers?: Record<string, string>;
  limiter?: RateLimiter;
  cache?: TtlCache<unknown>;
  /** Cache key. Defaults to the URL. Never include secrets in it. */
  cacheKey?: string;
  /** Spots errors that arrive with a 200 status or need a better message. */
  classify?: (status: number, body: unknown) => Problem | null;
}

const DEFAULT_MESSAGES: Partial<Record<ProviderErrorKind, string>> = {
  auth: 'rejected the API key. Check it in Data sources.',
  plan: 'says your plan does not include this data.',
  'not-found': 'does not know this symbol.',
  server: 'is having problems right now. Try again shortly.',
};

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'auth';
  if (status === 402 || status === 403) return 'plan';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'bad-request';
}

/** GET a JSON document with the shared error handling, budget and cache. */
export async function requestJson(req: JsonRequest): Promise<unknown> {
  const key = req.cacheKey ?? req.url;
  const hit = req.cache?.get(key);
  if (hit !== undefined) return hit;
  req.limiter?.take();

  let res: Response;
  try {
    res = await req.fetch(req.url, req.headers ? { headers: req.headers } : undefined);
  } catch {
    throw new ProviderError(`${req.provider} could not be reached. Check your connection or try again.`, 'network');
  }
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const problem: Problem | null =
    req.classify?.(res.status, body) ?? (res.ok ? null : { kind: kindForStatus(res.status) });
  if (problem) {
    if (problem.kind === 'rate') {
      const retry = problem.retryAfter ?? parseRetryAfter(res.headers?.get?.('retry-after'));
      const seconds = req.limiter ? req.limiter.backoff(retry) : (retry ?? 30);
      throw new RateLimitError(seconds);
    }
    const fallback = DEFAULT_MESSAGES[problem.kind];
    const message = problem.message ?? (fallback ? `${req.provider} ${fallback}` : `${req.provider} responded ${res.status}`);
    throw new ProviderError(message, problem.kind, res.status);
  }
  req.limiter?.success();
  req.cache?.set(key, body);
  return body;
}

/** Short user-facing text for any error thrown by an adapter. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
