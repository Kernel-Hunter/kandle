import { registerOverlay, type OverlayFigure } from 'klinecharts';

export interface DrawingTool {
  /** Chart engine overlay name. */
  overlay: string;
  label: string;
  /** KeyboardEvent.code used with Alt. */
  shortcut?: string;
  icon: string;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const DRAWING_TOOLS: readonly DrawingTool[] = [
  { overlay: 'segment', label: 'Trend line', shortcut: 'KeyT', icon: svg('<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.6" fill="currentColor"/><circle cx="20" cy="5" r="1.6" fill="currentColor"/>') },
  { overlay: 'rayLine', label: 'Ray', shortcut: 'KeyR', icon: svg('<path d="M4 18 21 6"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/>') },
  { overlay: 'straightLine', label: 'Extended line', icon: svg('<path d="M2 19 22 5"/>') },
  { overlay: 'horizontalStraightLine', label: 'Horizontal line', shortcut: 'KeyH', icon: svg('<path d="M2 12h20"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>') },
  { overlay: 'horizontalRayLine', label: 'Horizontal ray', icon: svg('<path d="M6 12h16"/><circle cx="6" cy="12" r="1.6" fill="currentColor"/>') },
  { overlay: 'verticalStraightLine', label: 'Vertical line', shortcut: 'KeyV', icon: svg('<path d="M12 2v20"/>') },
  { overlay: 'parallelStraightLine', label: 'Parallel channel', icon: svg('<path d="M3 16 17 4M7 20 21 8"/>') },
  { overlay: 'rectangle', label: 'Rectangle', shortcut: 'KeyB', icon: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  { overlay: 'fibRetracement', label: 'Fibonacci retracement', shortcut: 'KeyF', icon: svg('<path d="M3 5h18M3 10h18M3 14h18M3 19h18" stroke-dasharray="2 2"/><path d="M5 19 19 5"/>') },
  { overlay: 'priceRange', label: 'Price range', shortcut: 'KeyP', icon: svg('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/><path d="M4 4h16M4 20h16" opacity=".5"/>') },
  { overlay: 'textNote', label: 'Text note', shortcut: 'KeyN', icon: svg('<path d="M6 6h12M12 6v13M9 19h6"/>') },
  { overlay: 'priceLine', label: 'Price label', icon: svg('<path d="M3 14h12"/><path d="M15 10h6v8h-6z"/>') },
];

const ACCENT = '#2f80ed';

const FIB_LEVELS: Array<[number, string]> = [
  [0, 'rgb(138, 146, 158)'],
  [0.236, 'rgb(242, 54, 69)'],
  [0.382, 'rgb(255, 152, 0)'],
  [0.5, 'rgb(76, 175, 80)'],
  [0.618, 'rgb(8, 153, 129)'],
  [0.786, 'rgb(47, 128, 237)'],
  [1, 'rgb(138, 146, 158)'],
];

const PERIOD_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Bars between two timestamps for the chart's current period (data indexes are unreliable off-screen). */
function barsBetween(a: number | undefined, b: number | undefined, period: { type: string; span: number } | null): number {
  if (a === undefined || b === undefined || !period) return 0;
  const unit = PERIOD_MS[period.type];
  if (!unit) return 0;
  return Math.round((b - a) / (unit * period.span));
}

let registered = false;

/** Registers drawing overlays that the chart engine does not ship. Safe to call more than once. */
export function registerCustomOverlays(): void {
  if (registered) return;
  registered = true;

  registerOverlay({
    name: 'rectangle',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }): OverlayFigure[] => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      return [
        {
          type: 'rect',
          attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
          styles: { style: 'stroke_fill', color: 'rgba(47, 128, 237, 0.14)', borderColor: ACCENT, borderSize: 1 },
        },
      ];
    },
  });

  registerOverlay({
    name: 'fibRetracement',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay, bounding, chart }): OverlayFigure[] => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const v1 = overlay.points[0]?.value;
      const v2 = overlay.points[1]?.value;
      if (v1 === undefined || v2 === undefined) return [];
      const precision = chart.getSymbol()?.pricePrecision ?? 2;
      const startX = Math.min(a.x, b.x);
      const figures: OverlayFigure[] = [
        { type: 'line', attrs: { coordinates: [a, b] }, styles: { style: 'dashed', color: 'rgba(138, 146, 158, 0.7)' } },
      ];
      FIB_LEVELS.forEach(([level, color], i) => {
        // Level 0 sits at the second point (the move's end), level 1 at the first.
        const y = b.y + (a.y - b.y) * level;
        const value = v2 + (v1 - v2) * level;
        const next = FIB_LEVELS[i + 1];
        if (next) {
          const y2 = b.y + (a.y - b.y) * next[0];
          figures.push({
            type: 'rect',
            ignoreEvent: true,
            attrs: { x: startX, y: Math.min(y, y2), width: Math.max(0, bounding.width - startX), height: Math.abs(y2 - y) },
            styles: { style: 'fill', color: color.replace('rgb(', 'rgba(').replace(')', ', 0.06)') },
          });
        }
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: startX, y }, { x: bounding.width, y }] },
          styles: { color, size: 1 },
        });
        figures.push({
          type: 'text',
          ignoreEvent: true,
          attrs: { x: startX + 4, y: y - 2, text: `${level} (${value.toFixed(precision)})`, align: 'left', baseline: 'bottom' },
          styles: { color, size: 11, backgroundColor: 'transparent', paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, borderSize: 0 },
        });
      });
      return figures;
    },
  });

  registerOverlay<{ text?: string }>({
    name: 'textNote',
    totalStep: 2,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay }): OverlayFigure[] => {
      if (coordinates.length < 1) return [];
      const text = overlay.extendData?.text || 'Note';
      const { x, y } = coordinates[0];
      return [
        {
          type: 'text',
          attrs: { x, y, text, align: 'left', baseline: 'middle' },
          styles: {
            color: '#ffffff',
            size: 13,
            backgroundColor: ACCENT,
            borderRadius: 4,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 5,
            paddingBottom: 5,
          },
        },
      ];
    },
  });

  registerOverlay({
    name: 'priceRange',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay, chart }): OverlayFigure[] => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const [p1, p2] = overlay.points;
      const v1 = p1?.value;
      const v2 = p2?.value;
      if (v1 === undefined || v2 === undefined) return [];
      const diff = v2 - v1;
      const pct = v1 !== 0 ? (diff / v1) * 100 : 0;
      const bars = barsBetween(p1.timestamp, p2.timestamp, chart.getPeriod());
      const up = diff >= 0;
      const color = up ? '34, 171, 148' : '242, 54, 69';
      const precision = chart.getSymbol()?.pricePrecision ?? 2;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const midX = (left + right) / 2;
      const sign = up ? '+' : '';
      const label = `${sign}${diff.toFixed(precision)} (${sign}${pct.toFixed(2)}%)  ${Math.abs(bars)} bars`;
      const arrowY = b.y;
      const dir = b.y < a.y ? 1 : -1;
      return [
        {
          type: 'rect',
          attrs: { x: left, y: Math.min(a.y, b.y), width: Math.max(1, right - left), height: Math.abs(b.y - a.y) },
          styles: { style: 'fill', color: `rgba(${color}, 0.16)` },
        },
        {
          type: 'line',
          attrs: { coordinates: [{ x: midX, y: a.y }, { x: midX, y: b.y }] },
          styles: { color: `rgb(${color})`, size: 1 },
        },
        {
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: midX, y: arrowY },
              { x: midX - 5, y: arrowY + 7 * dir },
              { x: midX + 5, y: arrowY + 7 * dir },
            ],
          },
          styles: { style: 'fill', color: `rgb(${color})` },
        },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x: midX, y: b.y - 8 * dir, text: label, align: 'center', baseline: dir === 1 ? 'bottom' : 'top' },
          styles: {
            color: '#ffffff',
            size: 12,
            backgroundColor: `rgb(${color})`,
            borderRadius: 3,
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 3,
            paddingBottom: 3,
          },
        },
      ];
    },
  });
}
