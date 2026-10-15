import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  BRIDGE_HOST,
  CLOSE_CODES,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseMessage,
  type BridgeMethod,
  type RejectMessage,
  type RequestMessage,
} from './protocol.js';
import { AttemptLimiter, isAllowedHost, isAllowedOrigin, tokensEqual } from './security.js';

export interface BridgeOptions {
  port: number;
  token: string;
  /** Extra browser origins allowed to connect, e.g. a hosted copy of the app. */
  allowedOrigins?: readonly string[];
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
  /** How often to retry when another process holds the port. */
  retryMs?: number;
  log?: (message: string) => void;
}

export type BridgeState = 'starting' | 'listening' | 'port_in_use' | 'error' | 'closed';

export class NotConnectedError extends Error {}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  socket: WebSocket;
}

interface AppConnection {
  socket: WebSocket;
  app: string;
  version?: string;
  connectedAt: number;
}

export interface BridgeStatus {
  state: BridgeState;
  url: string;
  connected: boolean;
  app?: { name: string; version?: string; connectedAt: string };
  error?: string;
}

/**
 * WebSocket server on 127.0.0.1 that the Kandle app connects to. Only one app is active
 * at a time; a newer authenticated connection replaces the older one.
 */
export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private app: AppConnection | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly limiter = new AttemptLimiter();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private stateValue: BridgeState = 'starting';
  private lastError: string | undefined;
  private readonly listeners = new Set<() => void>();
  boundPort: number;

  constructor(private readonly options: BridgeOptions) {
    this.boundPort = options.port;
  }

  get state(): BridgeState {
    return this.stateValue;
  }

  get connected(): boolean {
    return this.app !== null;
  }

  /** Called whenever the connection state changes. Used by tests and the CLI log. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  status(): BridgeStatus {
    const status: BridgeStatus = {
      state: this.stateValue,
      url: `ws://${BRIDGE_HOST}:${this.boundPort}`,
      connected: this.app !== null,
    };
    if (this.app) {
      status.app = { name: this.app.app, version: this.app.version, connectedAt: new Date(this.app.connectedAt).toISOString() };
    }
    if (this.lastError) status.error = this.lastError;
    return status;
  }

  /** Resolves once the server is listening or has failed; it keeps retrying if the port is busy. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: BRIDGE_HOST,
        port: this.options.port,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: (info: { origin: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
          const origin = info.origin || (info.req.headers.origin as string | undefined);
          const port = this.boundPort;
          if (!isAllowedHost(info.req.headers.host, port)) {
            this.log(`Rejected connection with Host ${info.req.headers.host ?? '(none)'}`);
            done(false, 403, 'Host not allowed');
            return;
          }
          if (!isAllowedOrigin(origin, this.options.allowedOrigins)) {
            this.log(`Rejected connection from origin ${origin}`);
            done(false, 403, 'Origin not allowed');
            return;
          }
          done(true);
        },
      });
      const onError = (error: NodeJS.ErrnoException) => {
        wss.close();
        if (error.code === 'EADDRINUSE') {
          this.stateValue = 'port_in_use';
          this.lastError = `Port ${this.options.port} is in use, probably by another kandle-mcp. Retrying.`;
          this.log(this.lastError);
          this.retryTimer = setTimeout(() => void this.start(), this.options.retryMs ?? 3000);
          this.retryTimer.unref?.();
        } else {
          this.stateValue = 'error';
          this.lastError = error.message;
          this.log(`Bridge error: ${error.message}`);
        }
        this.emit();
        resolve();
      };
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        wss.on('error', (error) => this.log(`Bridge error: ${error.message}`));
        const address = wss.address();
        if (address && typeof address === 'object') this.boundPort = address.port;
        this.wss = wss;
        this.stateValue = 'listening';
        this.lastError = undefined;
        this.log(`Bridge listening on ws://${BRIDGE_HOST}:${this.boundPort}`);
        this.startHeartbeat();
        this.emit();
        resolve();
      });
      wss.on('connection', (socket) => this.accept(socket));
    });
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      const socket = this.app?.socket;
      if (!socket) return;
      if (this.alive.get(socket) === false) {
        socket.terminate();
        return;
      }
      this.alive.set(socket, false);
      socket.ping();
    }, 20_000);
    this.heartbeat.unref?.();
  }

  private reject(socket: WebSocket, reason: RejectMessage['reason'], message: string, code: number): void {
    const msg: RejectMessage = { type: 'reject', reason, message };
    socket.send(JSON.stringify(msg));
    socket.close(code, reason);
  }

  private accept(socket: WebSocket): void {
    let authed = false;
    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
    const helloTimer = setTimeout(() => {
      if (!authed) socket.close(CLOSE_CODES.helloTimeout, 'hello timeout');
    }, this.options.helloTimeoutMs ?? 5000);

    socket.on('message', (data) => {
      const msg = parseMessage(String(data));
      if (!msg) return;
      if (!authed) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (this.limiter.locked()) {
          this.reject(socket, 'locked', 'Too many wrong pairing codes. Wait a minute and try again.', CLOSE_CODES.locked);
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.reject(socket, 'bad_protocol', `This kandle-mcp speaks protocol ${PROTOCOL_VERSION}, the app sent ${msg.protocol}. Update both.`, CLOSE_CODES.badProtocol);
          return;
        }
        if (!tokensEqual(msg.token, this.options.token)) {
          this.limiter.fail();
          this.log('Rejected app: wrong pairing code');
          this.reject(socket, 'bad_token', 'Wrong pairing code.', CLOSE_CODES.badToken);
          return;
        }
        authed = true;
        this.limiter.reset();
        const previous = this.app;
        this.app = { socket, app: msg.app, version: msg.version, connectedAt: Date.now() };
        if (previous) previous.socket.close(CLOSE_CODES.replaced, 'replaced by a newer connection');
        socket.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, server: 'kandle-mcp' }));
        this.log(`App connected (${msg.app}${msg.version ? ` ${msg.version}` : ''})`);
        this.emit();
        return;
      }
      if (msg.type === 'response') {
        const p = this.pending.get(msg.id);
        if (!p || p.socket !== socket) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.app?.socket === socket) {
        this.app = null;
        this.log('App disconnected');
        this.emit();
      }
      for (const [id, p] of this.pending) {
        if (p.socket !== socket) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('The Kandle app disconnected before answering.'));
      }
    });
    socket.on('error', () => undefined);
  }

  /** Sends one command to the app and waits for its answer. */
  request(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const app = this.app;
    if (!app) return Promise.reject(new NotConnectedError('The Kandle app is not connected.'));
    const id = this.nextId++;
    const msg: RequestMessage = { type: 'request', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Kandle did not answer ${method} within ${Math.round((timeoutMs ?? this.options.requestTimeoutMs ?? 20_000) / 1000)} s.`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer, socket: app.socket });
      app.socket.send(JSON.stringify(msg), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Could not send to Kandle: ${error.message}`));
      });
    });
  }

  async close(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error('Bridge closed'));
    }
    const wss = this.wss;
    this.wss = null;
    this.app = null;
    this.stateValue = 'closed';
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}
