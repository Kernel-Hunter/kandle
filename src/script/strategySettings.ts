/**
 * Backtest settings that replace the ones in a script's strategy() call, as set in the
 * Indicators dialog or through automation. Kept free of chart imports so the layout
 * store can use it.
 */
import type { CommissionType, QtyType, StrategyConfig } from './strategy';

export type StrategyOverrides = Partial<StrategyConfig>;
/** A change to the overrides: a value sets one, null goes back to the strategy() call's value. */
export type StrategyPatch = { [K in keyof StrategyConfig]?: StrategyConfig[K] | null };

export const QTY_TYPES: readonly QtyType[] = ['fixed', 'cash', 'percent_of_equity'];
export const COMMISSION_TYPES: readonly CommissionType[] = ['percent', 'cash_per_contract', 'cash_per_order'];

/** Setting keys in the order the dialog shows them. */
export const STRATEGY_KEYS: ReadonlyArray<keyof StrategyConfig> = [
  'initialCapital',
  'defaultQtyType',
  'defaultQtyValue',
  'commissionType',
  'commissionValue',
  'slippage',
  'pyramiding',
  'processOrdersOnClose',
];

/** The strategy() argument names, accepted as well as the keys of the backtest's `settings`. */
const ARG_NAMES: Record<string, keyof StrategyConfig> = {
  initial_capital: 'initialCapital',
  default_qty_type: 'defaultQtyType',
  default_qty_value: 'defaultQtyValue',
  commission_type: 'commissionType',
  commission_value: 'commissionValue',
  slippage: 'slippage',
  pyramiding: 'pyramiding',
  process_orders_on_close: 'processOrdersOnClose',
};

/**
 * Checks one value against what the strategy() call accepts. Returns the value, or an error
 * message that calls the setting `name`.
 */
export function checkStrategySetting(key: keyof StrategyConfig, name: string, v: unknown): { value: StrategyConfig[typeof key] } | { error: string } {
  const isNumber = typeof v === 'number' && Number.isFinite(v);
  switch (key) {
    case 'initialCapital':
    case 'defaultQtyValue':
      return isNumber && v > 0 ? { value: v } : { error: `${name} must be a number more than 0` };
    case 'commissionValue':
      return isNumber && v >= 0 ? { value: v } : { error: `${name} must be a number of at least 0` };
    case 'slippage':
    case 'pyramiding':
      return isNumber && v >= 0 && Number.isInteger(v) ? { value: v } : { error: `${name} must be a whole number of at least 0` };
    case 'processOrdersOnClose':
      return typeof v === 'boolean' ? { value: v } : { error: `${name} must be true or false` };
    case 'defaultQtyType': {
      // "strategy.percent_of_equity", as written in a script, works too.
      const text = (typeof v === 'string' ? v.replace(/^strategy\./, '') : '') as QtyType;
      return QTY_TYPES.includes(text) ? { value: text } : { error: `${name} must be one of ${QTY_TYPES.join(', ')}` };
    }
    case 'commissionType': {
      const text = (typeof v === 'string' ? v.replace(/^strategy\.commission\./, '') : '') as CommissionType;
      return COMMISSION_TYPES.includes(text) ? { value: text } : { error: `${name} must be one of ${COMMISSION_TYPES.join(', ')}` };
    }
  }
}

function settingKey(name: string): keyof StrategyConfig | undefined {
  if ((STRATEGY_KEYS as readonly string[]).includes(name)) return name as keyof StrategyConfig;
  return ARG_NAMES[name];
}

/**
 * Reads a change to strategy settings from automation. Keys are the names in a backtest's
 * `settings` (initialCapital) or the strategy() arguments (initial_capital); null puts a
 * setting back to the script's own value. Errors name the first bad key.
 */
export function parseStrategyPatch(raw: unknown): { ok: true; patch: StrategyPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Strategy settings must be an object such as {"initial_capital": 10000}' };
  const patch: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = settingKey(name);
    if (!key) return { ok: false, error: `Unknown strategy setting ${name}. Use ${Object.keys(ARG_NAMES).join(', ')}` };
    if (v === null || v === undefined) {
      patch[key] = null;
      continue;
    }
    const res = checkStrategySetting(key, name, v);
    if ('error' in res) return { ok: false, error: res.error };
    patch[key] = res.value;
  }
  return { ok: true, patch: patch as StrategyPatch };
}

/** Accepts anything from storage and keeps the valid overrides. */
export function sanitizeStrategyOverrides(raw: unknown): StrategyOverrides {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of STRATEGY_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    const res = checkStrategySetting(key, key, v);
    if ('value' in res) out[key] = res.value;
  }
  return out as StrategyOverrides;
}

/** Applies a patch to the current overrides, dropping the ones equal to the script's own values. */
export function applyStrategyPatch(defaults: StrategyConfig, current: StrategyOverrides, patch: StrategyPatch): StrategyOverrides {
  const next: Record<string, unknown> = { ...current };
  for (const key of STRATEGY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (v === null || v === undefined || v === defaults[key]) delete next[key];
    else next[key] = v;
  }
  return next as StrategyOverrides;
}
