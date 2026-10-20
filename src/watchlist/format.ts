/** Number formatting for watchlist rows. Kept free of DOM code so it can be tested. */

/** Decimals to show when the symbol's tick size is not known: fewer for large prices. */
export function autoPrecision(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  return 8;
}

export function formatPrice(price: number | null, precision?: number): string {
  if (price === null || !Number.isFinite(price)) return '';
  const digits = Math.max(0, Math.min(10, precision ?? autoPrecision(price)));
  return price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '';
  // -0.00 % reads oddly; small moves round to 0.00 %.
  const fixed = Math.abs(percent) < 0.005 ? 0 : percent;
  return `${fixed > 0 ? '+' : ''}${fixed.toFixed(2)}%`;
}

export function formatChange(change: number | null, precision?: number): string {
  if (change === null || !Number.isFinite(change)) return '';
  const text = formatPrice(Math.abs(change), precision);
  return change > 0 ? `+${text}` : change < 0 ? `-${text}` : text;
}

/** up, down or flat, for colouring a change. */
export function direction(change: number | null): 'up' | 'down' | 'flat' {
  if (change === null || !Number.isFinite(change) || change === 0) return 'flat';
  return change > 0 ? 'up' : 'down';
}
