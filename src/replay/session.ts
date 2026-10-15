import type { KLineData } from 'klinecharts';

export const REPLAY_SPEEDS = [1, 2, 3, 5, 10] as const;

/** Index of the bar that contains `time`: the last bar opening at or before it. -1 if none. */
export function indexAtTime(bars: readonly KLineData[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The windowing behind bar replay. Holds every bar and a cursor; bars after the cursor
 * are "the future" and never leave this object until they are stepped into view.
 */
export class ReplaySession {
  private readonly bars: readonly KLineData[];
  private cursor: number;
  readonly startIndex: number;

  /** `startIndex` is the last bar visible when replay begins. */
  constructor(bars: readonly KLineData[], startIndex: number) {
    if (bars.length < 2) throw new Error('Replay needs at least two bars');
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= bars.length - 1) {
      throw new Error('Pick a start bar before the latest one');
    }
    this.bars = bars.map((b) => ({ ...b }));
    this.cursor = startIndex;
    this.startIndex = startIndex;
  }

  /** Bars the chart may show: everything up to and including the cursor. */
  visible(): KLineData[] {
    return this.bars.slice(0, this.cursor + 1).map((b) => ({ ...b }));
  }

  /** Every bar, hidden ones included. Used to restart replay from another bar. */
  all(): KLineData[] {
    return this.bars.map((b) => ({ ...b }));
  }

  current(): KLineData {
    return { ...this.bars[this.cursor] };
  }

  get index(): number {
    return this.cursor;
  }

  get total(): number {
    return this.bars.length;
  }

  /** Bars still hidden to the right. */
  get remaining(): number {
    return this.bars.length - 1 - this.cursor;
  }

  get done(): boolean {
    return this.remaining === 0;
  }

  /** Reveals up to `count` bars and returns them in order. Returns [] at the end. */
  step(count = 1): KLineData[] {
    const n = Math.max(0, Math.min(Math.floor(count), this.remaining));
    const revealed = this.bars.slice(this.cursor + 1, this.cursor + 1 + n).map((b) => ({ ...b }));
    this.cursor += n;
    return revealed;
  }
}

/** Interval between automatic steps for a speed (bars per second). */
export function stepInterval(speed: number): number {
  const s = Math.min(10, Math.max(1, Math.round(speed)));
  return Math.round(1000 / s);
}
