import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_PATTERN, generateToken, normalizeToken } from './protocol.js';

export interface TokenInfo {
  token: string;
  /** Where the code came from, for the status tool and --help output. */
  origin: 'env' | 'file' | 'new';
  path?: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KANDLE_HOME || join(homedir(), '.kandle');
}

/**
 * The pairing code is stable across restarts so the app only has to be paired once.
 * It lives in ~/.kandle/bridge-token with owner-only permissions. KANDLE_TOKEN overrides it.
 */
export function loadOrCreateToken(env: NodeJS.ProcessEnv = process.env): TokenInfo {
  if (env.KANDLE_TOKEN) {
    const token = normalizeToken(env.KANDLE_TOKEN);
    if (token.length < 8) throw new Error('KANDLE_TOKEN must be at least 8 characters');
    return { token, origin: 'env' };
  }
  const dir = configDir(env);
  const path = join(dir, 'bridge-token');
  try {
    const existing = normalizeToken(readFileSync(path, 'utf8'));
    if (TOKEN_PATTERN.test(existing)) return { token: existing, origin: 'file', path };
  } catch {
    // Missing or unreadable: make a new one below.
  }
  const token = generateToken((n) => new Uint8Array(randomBytes(n)));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  return { token, origin: 'new', path };
}
