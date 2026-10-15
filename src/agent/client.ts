import { CLOSE_CODES, PROTOCOL_VERSION, parseMessage, type BridgeMethod, type HelloMessage, type ResponseMessage } from '../../packages/mcp/src/protocol';
import type { WebSocketFactory, WebSocketLike } from '../data/types';

export type BridgeStatus =
  | 'off'
  | 'connecting'
  | 'connected'
  /** The MCP server is not running or not reachable; retrying. */
  | 'waiting'
  | 'bad_token'
  | 'locked'
  | 'protocol'
  /** Another tab or window took over the bridge. */
  | 'replaced';

export type RequestHandler = (method: BridgeMethod, params: Record<string, unknown>) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

export interface BridgeClientOptions {
  url: string;
  token: string;
  app: string;
  version?: string;
  handle: RequestHandler;
  createSocket?: WebSocketFactory;
  onStatus?: (status: BridgeStatus, detail?: string) => void;
  onActivity?: (method: BridgeMethod, ok: boolean, error?: string) => void;
  /** First retry delay; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

/**
 * The app's side of the agent bridge. Connects to the kandle-mcp server on 127.0.0.1,
 * pairs with the code the user entered, then runs each request through `handle`.
 * Keeps retrying while the server is down; stops on a wrong code or when another tab takes over.
 */
export class BridgeClient {
  private socket: WebSocketLike | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private statusValue: BridgeStatus = 'off';
  private terminal = false;

  constructor(private readonly options: BridgeClientOptions) {
    this.delay = options.retryMs ?? 1500;
  }

  get status(): BridgeStatus {
    return this.statusValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.terminal = false;
    this.delay = this.options.retryMs ?? 1500;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    this.setStatus('off');
  }

  private setStatus(status: BridgeStatus, detail?: string): void {
    this.statusValue = status;
    this.options.onStatus?.(status, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.statusValue === 'waiting' ? 'waiting' : 'connecting');
    let socket: WebSocketLike;
    try {
      socket = (this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike))(this.options.url);
    } catch (error) {
      this.setStatus('waiting', error instanceof Error ? error.message : String(error));
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const hello: HelloMessage = { type: 'hello', token: this.options.token, protocol: PROTOCOL_VERSION, app: this.options.app, version: this.options.version };
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event) => void this.onMessage(socket, event.data);
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (event?.code === CLOSE_CODES.replaced) {
        this.terminal = true;
        this.setStatus('replaced', 'Another Kandle tab is connected to the agent.');
        return;
      }
      if (this.terminal) return;
      this.setStatus('waiting');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(delay = this.delay): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.delay = Math.min(this.delay * 2, this.options.maxRetryMs ?? 10_000);
  }

  private async onMessage(socket: WebSocketLike, data: unknown): Promise<void> {
    const msg = parseMessage(typeof data === 'string' ? data : String(data));
    if (!msg) return;
    switch (msg.type) {
      case 'welcome':
        this.delay = this.options.retryMs ?? 1500;
        this.setStatus('connected');
        return;
      case 'reject':
        if (msg.reason === 'locked') {
          // Too many wrong codes: wait out the lockout, then try again.
          this.setStatus('locked', msg.message);
          this.terminal = true;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.terminal = false;
            this.connect();
          }, 61_000);
          return;
        }
        this.terminal = true;
        this.setStatus(msg.reason === 'bad_token' ? 'bad_token' : 'protocol', msg.message);
        return;
      case 'request': {
        const outcome = await this.options.handle(msg.method, msg.params);
        this.options.onActivity?.(msg.method, outcome.ok, outcome.ok ? undefined : outcome.error);
        const response: ResponseMessage = outcome.ok
          ? { type: 'response', id: msg.id, ok: true, result: outcome.result }
          : { type: 'response', id: msg.id, ok: false, error: outcome.error };
        if (this.socket === socket && socket.readyState === 1) socket.send(JSON.stringify(response));
        return;
      }
      default:
        return;
    }
  }
}
