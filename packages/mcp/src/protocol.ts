/**
 * Wire protocol between the kandle-mcp server (Node) and the Kandle app (browser).
 *
 * The MCP server listens on a WebSocket at 127.0.0.1. The app connects to it when the
 * user turns on "Agent bridge", proves it knows the pairing code with a `hello`, and
 * then answers `request` messages with `response` messages. All messages are JSON.
 *
 * This file has no Node or browser dependencies so both sides can import it.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7457;
export const BRIDGE_HOST = '127.0.0.1';
/** Screenshots are the largest messages; 16 MB leaves room for a 4K PNG. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Methods the app implements. Each MCP tool maps to exactly one of these. */
export const BRIDGE_METHODS = [
  'get_chart_state',
  'set_symbol',
  'set_timeframe',
  'get_candles',
  'add_indicator',
  'remove_indicator',
  'list_indicators',
  'draw',
  'remove_drawing',
  'clear_drawings',
  'run_script',
  'get_backtest',
  'screenshot',
  'set_alert',
  'list_alerts',
  'remove_alert',
  'start_replay',
  'step_replay',
  'stop_replay',
  'set_layout',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === 'string' && (BRIDGE_METHODS as readonly string[]).includes(value);
}

/** WebSocket close codes the server uses (4000-4999 is the application range). */
export const CLOSE_CODES = {
  badToken: 4001,
  badProtocol: 4002,
  replaced: 4003,
  helloTimeout: 4004,
  locked: 4005,
} as const;

export interface HelloMessage {
  type: 'hello';
  token: string;
  protocol: number;
  app: string;
  version?: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  protocol: number;
  server: string;
}

export interface RejectMessage {
  type: 'reject';
  reason: 'bad_token' | 'bad_protocol' | 'locked';
  message: string;
}

export interface RequestMessage {
  type: 'request';
  id: number;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface ResponseOk {
  type: 'response';
  id: number;
  ok: true;
  result: unknown;
}

export interface ResponseError {
  type: 'response';
  id: number;
  ok: false;
  error: string;
}

export type ResponseMessage = ResponseOk | ResponseError;
export type BridgeMessage = HelloMessage | WelcomeMessage | RejectMessage | RequestMessage | ResponseMessage;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parses and shape-checks one message. Returns null for anything malformed. */
export function parseMessage(raw: unknown): BridgeMessage | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(data)) return null;
  switch (data.type) {
    case 'hello':
      if (typeof data.token !== 'string' || typeof data.protocol !== 'number' || typeof data.app !== 'string') return null;
      return {
        type: 'hello',
        token: data.token,
        protocol: data.protocol,
        app: data.app,
        version: typeof data.version === 'string' ? data.version : undefined,
      };
    case 'welcome':
      if (typeof data.protocol !== 'number') return null;
      return { type: 'welcome', protocol: data.protocol, server: typeof data.server === 'string' ? data.server : '' };
    case 'reject':
      if (data.reason !== 'bad_token' && data.reason !== 'bad_protocol' && data.reason !== 'locked') return null;
      return { type: 'reject', reason: data.reason, message: typeof data.message === 'string' ? data.message : '' };
    case 'request':
      if (!Number.isInteger(data.id) || !isBridgeMethod(data.method)) return null;
      return { type: 'request', id: data.id as number, method: data.method, params: isObject(data.params) ? data.params : {} };
    case 'response':
      if (!Number.isInteger(data.id) || typeof data.ok !== 'boolean') return null;
      if (data.ok) return { type: 'response', id: data.id as number, ok: true, result: data.result ?? null };
      return { type: 'response', id: data.id as number, ok: false, error: typeof data.error === 'string' ? data.error : 'Unknown error' };
    default:
      return null;
  }
}

/** Pairing codes look like `K7QD-9MXR-2HPA`: 12 characters from a 31-letter alphabet, about 59 bits. */
export const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ2345679';
export const TOKEN_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export function generateToken(randomBytes: (n: number) => Uint8Array): string {
  const chars: string[] = [];
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % TOKEN_ALPHABET.length);
  while (chars.length < 12) {
    for (const b of randomBytes(24)) {
      if (b < limit) chars.push(TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]);
      if (chars.length === 12) break;
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Accepts codes typed with spaces, lower case, or without dashes. */
export function normalizeToken(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 12) return input.trim().toUpperCase();
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}
