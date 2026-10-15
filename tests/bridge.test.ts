import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer, NotConnectedError } from '../packages/mcp/src/bridge';
import { generateToken, normalizeToken, parseMessage, TOKEN_PATTERN, type BridgeMethod } from '../packages/mcp/src/protocol';
import { AttemptLimiter, isAllowedHost, isAllowedOrigin, parseOriginList, tokensEqual } from '../packages/mcp/src/security';
import { BridgeClient, type BridgeStatus, type RequestHandler } from '../src/agent/client';
import type { WebSocketLike } from '../src/data/types';

const TOKEN = 'ABCD-EFGH-JKLM';

describe('protocol messages', () => {
  it('parses each message type and rejects junk', () => {
    expect(parseMessage('{"type":"hello","token":"x","protocol":1,"app":"kandle"}')).toMatchObject({ type: 'hello', token: 'x' });
    expect(parseMessage({ type: 'request', id: 3, method: 'draw', params: { a: 1 } })).toEqual({ type: 'request', id: 3, method: 'draw', params: { a: 1 } });
    expect(parseMessage({ type: 'response', id: 3, ok: false })).toEqual({ type: 'response', id: 3, ok: false, error: 'Unknown error' });
    expect(parseMessage({ type: 'request', id: 3, method: 'rm_rf' })).toBeNull();
    expect(parseMessage({ type: 'request', id: 1.5, method: 'draw' })).toBeNull();
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('[1,2]')).toBeNull();
    expect(parseMessage({ type: 'reject', reason: 'nope' })).toBeNull();
  });

  it('generates pairing codes in the documented shape', () => {
    let seed = 0;
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) % 256));
    const codes = new Set(Array.from({ length: 20 }, () => generateToken(bytes)));
    for (const code of codes) expect(code).toMatch(TOKEN_PATTERN);
    expect(codes.size).toBeGreaterThan(1);
  });

  it('normalises typed codes', () => {
    expect(normalizeToken(' abcd efgh jklm ')).toBe(TOKEN);
    expect(normalizeToken('abcdefghjklm')).toBe(TOKEN);
  });
});

describe('bridge security checks', () => {
  it('allows local origins and listed ones only', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:5173')).toBe(true);
    expect(isAllowedOrigin('http://kandle.localhost')).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('https://kernel-hunter.github.io')).toBe(true);
    expect(isAllowedOrigin('https://kernel-hunter.github.io.evil.example')).toBe(false);
    expect(isAllowedOrigin('http://kernel-hunter.github.io')).toBe(false);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.example')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('file://')).toBe(false);
    expect(isAllowedOrigin('https://me.github.io', parseOriginList('https://me.github.io/, https://x.dev'))).toBe(true);
  });

  it('only accepts loopback Host headers', () => {
    expect(isAllowedHost('127.0.0.1:7457', 7457)).toBe(true);
    expect(isAllowedHost('localhost:7457', 7457)).toBe(true);
    expect(isAllowedHost('evil.example:7457', 7457)).toBe(false);
    expect(isAllowedHost('127.0.0.1:80', 7457)).toBe(false);
    expect(isAllowedHost(undefined, 7457)).toBe(false);
  });

  it('compares tokens and locks after repeated failures', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(TOKEN, 'ABCD-EFGH-JKLN')).toBe(false);
    expect(tokensEqual(TOKEN, 'short')).toBe(false);
    let now = 0;
    const limiter = new AttemptLimiter(3, 1000, () => now);
    limiter.fail();
    limiter.fail();
    expect(limiter.locked()).toBe(false);
    limiter.fail();
    expect(limiter.locked()).toBe(true);
    now = 2000;
    expect(limiter.locked()).toBe(false);
  });
});

// ---------------------------------------------------------------- live server + client

let server: BridgeServer | null = null;
const clients: BridgeClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await server?.close();
  server = null;
});

async function startServer(options: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) {
  server = new BridgeServer({ port: 0, token: TOKEN, requestTimeoutMs: 2000, ...options });
  await server.start();
  return server;
}

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition not met in time'));
      }
    }, 10);
  });
}

function startClient(
  port: number,
  token: string,
  handle: RequestHandler = vi.fn(async (method: BridgeMethod, params: Record<string, unknown>) => ({ ok: true as const, result: { method, params } })),
) {
  const statuses: BridgeStatus[] = [];
  const client = new BridgeClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    app: 'kandle',
    version: 'test',
    handle,
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    onStatus: (s) => statuses.push(s),
    retryMs: 50,
  });
  clients.push(client);
  client.start();
  return { client, statuses, handle };
}

describe('BridgeServer and BridgeClient', () => {
  it('pairs and round-trips a request', async () => {
    const s = await startServer();
    const { client, handle } = startClient(s.boundPort, TOKEN);
    await until(() => client.status === 'connected' && s.connected);
    await expect(s.request('get_chart_state', { pane: 2 })).resolves.toEqual({ method: 'get_chart_state', params: { pane: 2 } });
    expect(handle).toHaveBeenCalledWith('get_chart_state', { pane: 2 });
    expect(s.status()).toMatchObject({ state: 'listening', connected: true, app: { name: 'kandle', version: 'test' } });
  });

  it('passes handler errors back as rejections', async () => {
    const s = await startServer();
    const { client } = startClient(s.boundPort, TOKEN, vi.fn(async () => ({ ok: false as const, error: 'Unknown symbol NOPE' })));
    await until(() => client.status === 'connected');
    await expect(s.request('set_symbol', { symbol: 'NOPE' })).rejects.toThrow('Unknown symbol NOPE');
  });

  it('rejects a wrong pairing code and stops retrying', async () => {
    const s = await startServer();
    const { client, statuses } = startClient(s.boundPort, 'WRNG-CODE-XXXX');
    await until(() => client.status === 'bad_token');
    await new Promise((r) => setTimeout(r, 200));
    expect(statuses.filter((x) => x === 'bad_token')).toHaveLength(1);
    expect(s.connected).toBe(false);
    await expect(s.request('list_alerts')).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('refuses browser origins that are not local', async () => {
    const s = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${s.boundPort}`, { headers: { Origin: 'https://evil.example' } });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it('refuses a Host header that is not loopback', async () => {
    const s = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${s.boundPort}`, { headers: { Host: `rebind.example:${s.boundPort}` } });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it('locks pairing after too many wrong codes', async () => {
    const s = await startServer();
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${s.boundPort}`);
      await new Promise<void>((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: `BAD${i}`, protocol: 1, app: 'x' })));
        ws.on('message', (data) => reasons.push(JSON.parse(String(data)).reason));
        ws.on('close', () => resolve());
      });
    }
    expect(reasons.slice(0, 5)).toEqual(['bad_token', 'bad_token', 'bad_token', 'bad_token', 'bad_token']);
    expect(reasons[5]).toBe('locked');
  });

  it('lets a newer tab take over and tells the old one', async () => {
    const s = await startServer();
    const first = startClient(s.boundPort, TOKEN);
    await until(() => first.client.status === 'connected');
    const second = startClient(s.boundPort, TOKEN);
    await until(() => second.client.status === 'connected' && first.client.status === 'replaced');
    expect(s.connected).toBe(true);
  });

  it('times out when the app does not answer', async () => {
    const s = await startServer({ requestTimeoutMs: 100 });
    const { client } = startClient(s.boundPort, TOKEN, vi.fn(() => new Promise<never>(() => undefined)));
    await until(() => client.status === 'connected');
    await expect(s.request('screenshot')).rejects.toThrow(/did not answer/);
  });

  it('reconnects when the server comes back', async () => {
    const s = await startServer();
    const port = s.boundPort;
    const { client } = startClient(port, TOKEN);
    await until(() => client.status === 'connected');
    await s.close();
    await until(() => client.status === 'waiting');
    await startServer({ port });
    await until(() => client.status === 'connected', 5000);
  });

  it('reports a busy port and keeps retrying', async () => {
    const s = await startServer();
    const other = new BridgeServer({ port: s.boundPort, token: TOKEN, retryMs: 50 });
    await other.start();
    expect(other.state).toBe('port_in_use');
    expect(other.status().error).toMatch(/in use/);
    await other.close();
  });
});
