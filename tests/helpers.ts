import type { FetchLike, WebSocketFactory, WebSocketLike } from '../src/data/types';

export interface FakeResponse {
  status?: number;
  body: unknown;
  /** Raw body text, for non-JSON answers such as an HTML error page. */
  raw?: string;
  headers?: Record<string, string>;
}

/** A fetch stub that records URLs (and request headers) and answers from a handler. */
export function fakeFetch(handler: (url: URL, init?: RequestInit) => FakeResponse | Promise<FakeResponse>) {
  const calls: URL[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const fn: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push(url);
    inits.push(init);
    const res = await handler(url, init);
    const status = res.status ?? 200;
    const headers = new Map(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => res.body,
      text: async () => res.raw ?? (res.body === undefined ? '' : JSON.stringify(res.body)),
    } as unknown as Response;
  };
  /** Request headers of call `i` as a plain object. */
  const headersOf = (i: number): Record<string, string> => (inits[i]?.headers ?? {}) as Record<string, string>;
  return { fetch: fn, calls, inits, headersOf };
}

/** A websocket stand-in the test drives by hand. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /** Sent messages parsed as JSON where possible. */
  messages(): unknown[] {
    return this.sent.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return m;
      }
    });
  }
}

export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { factory, sockets, last: () => sockets[sockets.length - 1] };
}

/** A synthetic Binance kline row. */
export function binanceRow(time: number, close = 100): unknown[] {
  return [time, String(close - 1), String(close + 2), String(close - 3), String(close), '12.5', time + 59_999, '1250', 10, '6', '600', '0'];
}
