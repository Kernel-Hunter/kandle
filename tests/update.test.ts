import { describe, expect, it } from 'vitest';
import { currentBuild, latestBuild } from '../src/update';

const base = 'https://example.org/kandle/';

function fakeFetch(body: unknown, init: { status?: number; fail?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: URL | RequestInfo, opts?: RequestInit) => {
    calls.push({ url: String(url), init: opts });
    if (init.fail) throw new TypeError('offline');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const docWith = (content: string | null) =>
  ({ querySelector: (sel: string) => (content !== null && sel === 'meta[name="kandle-build"]' ? { content } : null) }) as unknown as Document;

describe('update check', () => {
  it('reads the build id of the page from index.html', () => {
    expect(currentBuild(docWith('abc123def456'))).toBe('abc123def456');
    expect(currentBuild(docWith(null))).toBeNull();
    expect(currentBuild(docWith(''))).toBeNull();
  });

  it('fetches version.json next to the page, past every cache', async () => {
    const { fetcher, calls } = fakeFetch({ version: '0.10.1', build: 'b2' });
    expect(await latestBuild(base, fetcher)).toBe('b2');
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://example.org/kandle/version.json');
    expect(url.searchParams.get('t')).toMatch(/^\d+$/);
    expect(calls[0].init?.cache).toBe('no-store');
  });

  it('gives null when the file cannot be read', async () => {
    expect(await latestBuild(base, fakeFetch({}, { fail: true }).fetcher)).toBeNull();
    expect(await latestBuild(base, fakeFetch('not found', { status: 404 }).fetcher)).toBeNull();
    expect(await latestBuild(base, fakeFetch('<html>').fetcher)).toBeNull();
    expect(await latestBuild(base, fakeFetch({ build: 42 }).fetcher)).toBeNull();
  });
});
