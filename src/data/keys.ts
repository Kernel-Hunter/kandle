import { APP } from '../config';
import { browserStorage, type KeyValueStorage } from '../store/layout';

/**
 * API keys the user pastes for keyed providers. They live only in this browser's storage,
 * under `<app id>:apikey:<source id>`, and each adapter sends its key only to its own provider.
 */

export type KeyValues = Record<string, string>;

export const keyStorageKey = (sourceId: string) => `${APP.id}:apikey:${sourceId}`;

export class KeyStore {
  private readonly listeners = new Set<(sourceId: string) => void>();

  constructor(private readonly storage: KeyValueStorage) {}

  get(sourceId: string): KeyValues | null {
    try {
      const raw = this.storage.getItem(keyStorageKey(sourceId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const out: KeyValues = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v) out[k] = v;
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  }

  /** True when every listed field has a value. */
  has(sourceId: string, fields: readonly string[]): boolean {
    const values = this.get(sourceId);
    return !!values && fields.every((f) => !!values[f]);
  }

  set(sourceId: string, values: KeyValues): void {
    const clean: KeyValues = {};
    for (const [k, v] of Object.entries(values)) {
      const trimmed = v.trim();
      if (trimmed) clean[k] = trimmed;
    }
    if (Object.keys(clean).length === 0) {
      this.clear(sourceId);
      return;
    }
    const json = JSON.stringify(clean);
    // Saving the same key again (Save, then Test connection) should not reload charts.
    if (JSON.stringify(this.get(sourceId) ?? {}) === json) return;
    try {
      this.storage.setItem(keyStorageKey(sourceId), json);
    } catch {
      // Storage blocked: nothing is kept, the user will be asked again.
    }
    this.emit(sourceId);
  }

  clear(sourceId: string): void {
    if (this.get(sourceId) === null) return;
    try {
      this.storage.removeItem(keyStorageKey(sourceId));
    } catch {
      // Ignore.
    }
    this.emit(sourceId);
  }

  onChange(listener: (sourceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(sourceId: string): void {
    for (const l of this.listeners) l(sourceId);
  }
}

let shared: KeyStore | null = null;

/** The app-wide key store, backed by localStorage when the browser allows it. */
export function keyStore(): KeyStore {
  shared ??= new KeyStore(browserStorage());
  return shared;
}

/** Replaces the shared store, for tests. */
export function setKeyStore(store: KeyStore | null): void {
  shared = store;
}
