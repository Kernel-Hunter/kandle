/** Saved form of scripts. Kept free of chart imports so the layout store can use it anywhere. */
import type { InputValue } from './compiler';
import { sanitizeStrategyOverrides, type StrategyOverrides } from './strategySettings';

/** What the saved layout keeps for each script. */
export interface ScriptRecord {
  id: string;
  source: string;
  inputs: Record<string, InputValue>;
  /** Backtest settings changed from the strategy() call; left out when there are none. */
  strategy?: StrategyOverrides;
}

export const MAX_SCRIPT_LENGTH = 100_000;
export const MAX_SCRIPTS = 50;

/** Accepts anything from storage and returns the valid script records. */
export function sanitizeScripts(raw: unknown): ScriptRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptRecord[] = [];
  for (const item of raw.slice(0, MAX_SCRIPTS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 64) continue;
    if (typeof r.source !== 'string' || r.source.length > MAX_SCRIPT_LENGTH) continue;
    const inputs: Record<string, InputValue> = {};
    if (r.inputs && typeof r.inputs === 'object') {
      for (const [k, v] of Object.entries(r.inputs as Record<string, unknown>)) {
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') inputs[k] = v;
      }
    }
    const record: ScriptRecord = { id: r.id, source: r.source, inputs };
    const strategy = sanitizeStrategyOverrides(r.strategy);
    if (Object.keys(strategy).length > 0) record.strategy = strategy;
    out.push(record);
  }
  return out;
}
