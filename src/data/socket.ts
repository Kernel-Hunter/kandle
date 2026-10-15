import type { StreamStatus, WebSocketFactory, WebSocketLike } from './types';

export const defaultWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export interface ManagedSocketOptions {
  url: string;
  factory: WebSocketFactory;
  onOpen?: (socket: WebSocketLike) => void;
  onMessage: (data: string) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Reconnect delays in ms; the last value repeats. */
  backoff?: number[];
  /** Some exchanges drop quiet connections unless the client pings. */
  heartbeat?: { intervalMs: number; message: string };
}

/**
 * Opens a websocket and keeps it open: if the connection drops it reconnects with backoff
 * until `close()` is called.
 */
export function openManagedSocket(options: ManagedSocketOptions): () => void {
  const backoff = options.backoff ?? [500, 1000, 2000, 5000, 10000];
  let attempt = 0;
  let closed = false;
  let socket: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;
  const stopPing = () => {
    if (pinger) clearInterval(pinger);
    pinger = null;
  };

  const connect = () => {
    if (closed) return;
    options.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = options.factory(options.url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      options.onStatus?.('live');
      options.onOpen?.(ws);
      const hb = options.heartbeat;
      if (hb) {
        stopPing();
        pinger = setInterval(() => {
          if (socket === ws && ws.readyState === 1) ws.send(hb.message);
        }, hb.intervalMs);
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') options.onMessage(event.data);
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      stopPing();
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      options.onStatus?.('reconnecting');
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    stopPing();
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // Closing a socket that never opened can throw in some browsers.
      }
    }
    options.onStatus?.('closed');
  };
}
