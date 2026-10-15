import { timingSafeEqual } from 'node:crypto';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Browsers always send an Origin header on WebSocket upgrades and pages cannot fake it,
 * so this is what keeps a random website from talking to the bridge.
 *
 * Allowed: pages served from this machine (localhost, 127.0.0.1, ::1, *.localhost) on any
 * port, plus any origins the user lists in KANDLE_ALLOWED_ORIGINS. A missing Origin means
 * a non-browser client on this machine (for example a test script); those are allowed
 * because they still need the pairing code.
 */
export function isAllowedOrigin(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false; // sandboxed iframes, file:// pages
  const wanted = origin.toLowerCase().replace(/\/+$/, '');
  if (extra.some((o) => o.toLowerCase().replace(/\/+$/, '') === wanted)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // Desktop shells (Tauri) use their own schemes; only allow ones listed explicitly.
    return false;
  }
  const host = url.hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(host) || host === '::1' || host.endsWith('.localhost');
}

/**
 * The Host header must name the loopback interface. This blocks DNS rebinding, where an
 * attacker's domain is pointed at 127.0.0.1 after the page loads.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}

export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Constant-time comparison so response timing does not leak how much of a code matched. */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Counts failed pairing attempts. After `max` failures inside `windowMs` the bridge refuses
 * new hellos until the window passes, which makes guessing the code impractical.
 */
export class AttemptLimiter {
  private failures: number[] = [];

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  locked(): boolean {
    this.prune();
    return this.failures.length >= this.max;
  }

  fail(): void {
    this.failures.push(this.now());
  }

  reset(): void {
    this.failures = [];
  }
}
