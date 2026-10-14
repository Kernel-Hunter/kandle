import type { FetchLike } from '../src/data/types';

export interface FakeResponse {
  status?: number;
  body: unknown;
}

/** A fetch stub that records URLs and answers from a handler. */
export function fakeFetch(handler: (url: URL) => FakeResponse | Promise<FakeResponse>) {
  const calls: URL[] = [];
  const fn: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(url);
    const res = await handler(url);
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => res.body,
    } as Response;
  };
  return { fetch: fn, calls };
}

/** A synthetic Binance kline row. */
export function binanceRow(time: number, close = 100): unknown[] {
  return [time, String(close - 1), String(close + 2), String(close - 3), String(close), '12.5', time + 59_999, '1250', 10, '6', '600', '0'];
}
