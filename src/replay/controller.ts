import type { Chart, KLineData } from 'klinecharts';
import { candleToKLine } from '../chart/loader';
import { getSource } from '../data/sources';
import type { TimeframeId } from '../data/timeframes';
import { h } from '../ui/dom';
import type { SwitchingLoader } from './loader';
import { REPLAY_SPEEDS, ReplaySession, indexAtTime, stepInterval } from './session';

export interface ReplayContext {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
}

export interface ReplayOptions {
  chart: () => Chart;
  loader: SwitchingLoader;
  /** Element the control bar and the pick hint are placed in (the main chart's wrapper). */
  container: HTMLElement;
  context: () => ReplayContext;
  toast: (message: string, kind?: 'info' | 'error') => void;
}

export interface ReplayStartOptions {
  startTime?: number;
  barsBack?: number;
  speed?: number;
  autoplay?: boolean;
}

export interface ReplayState {
  active: boolean;
  picking: boolean;
  playing: boolean;
  speed: number;
  start_time?: string;
  current_time?: string;
  bars_visible?: number;
  bars_remaining?: number;
}

const iso = (t: number) => new Date(t).toISOString();
const MAX_HISTORY_PAGES = 10;

const ICON = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  step: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5 5v14l10-7zM16 5h3v14h-3z"/></svg>',
  pick: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v18M4 12h4M16 12h4"/></svg>',
  exit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

/**
 * Bar replay for the main chart: pick a start bar, then step or play forward while every
 * later bar stays hidden. Indicators recompute on what is visible because the chart only
 * ever holds visible bars. Exiting reloads live data.
 */
export class ReplayController {
  private session: ReplaySession | null = null;
  private picking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private speed = 1;
  private readonly listeners = new Set<() => void>();
  private pickCleanup: (() => void) | null = null;

  private readonly bar: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly stepBtn: HTMLButtonElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly label: HTMLElement;
  private readonly hint: HTMLElement;

  constructor(private readonly options: ReplayOptions) {
    this.playBtn = h('button', { class: 'rp-btn', title: 'Play or pause (Space)', 'aria-label': 'Play', html: ICON.play, onclick: () => this.toggle() });
    this.stepBtn = h('button', { class: 'rp-btn', title: 'Step forward one bar (Right arrow)', 'aria-label': 'Step forward', html: ICON.step, onclick: () => this.step(1) });
    this.speedSel = h(
      'select',
      { class: 'rp-speed', title: 'Speed in bars per second', 'aria-label': 'Replay speed', onchange: () => this.setSpeed(Number(this.speedSel.value)) },
      ...REPLAY_SPEEDS.map((s) => h('option', { value: String(s) }, `${s}x`)),
    ) as HTMLSelectElement;
    this.label = h('span', { class: 'rp-label' });
    this.bar = h(
      'div',
      { class: 'replay-bar', hidden: true, role: 'toolbar', 'aria-label': 'Bar replay' },
      h('span', { class: 'rp-title' }, 'Replay'),
      h('button', { class: 'rp-btn', title: 'Pick a new start bar', 'aria-label': 'Pick start bar', html: ICON.pick, onclick: () => this.pick() }),
      this.playBtn,
      this.stepBtn,
      this.speedSel,
      this.label,
      h('button', { class: 'rp-btn rp-exit', title: 'Exit replay and return to live (Esc)', 'aria-label': 'Exit replay', html: ICON.exit, onclick: () => this.stop() }),
    );
    this.hint = h('div', { class: 'replay-hint', hidden: true }, 'Click a bar to start replay from it. Esc cancels.');
    options.container.append(this.bar, this.hint);

    options.loader.onReplayInterrupted(() => {
      this.pause();
      this.session = null;
      this.render();
      options.toast('Replay ended because the symbol or timeframe changed');
    });

    document.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get active(): boolean {
    return this.session !== null;
  }

  state(): ReplayState {
    const s = this.session;
    const state: ReplayState = { active: s !== null, picking: this.picking, playing: this.timer !== null, speed: this.speed };
    if (s) {
      state.current_time = iso(s.current().timestamp);
      state.bars_visible = s.index + 1;
      state.bars_remaining = s.remaining;
    }
    if (this.startTime !== null && s) state.start_time = iso(this.startTime);
    return state;
  }

  private startTime: number | null = null;

  /** Enters pick mode: the next click on the chart chooses the start bar. */
  pick(): void {
    if (this.picking) return;
    this.pause();
    this.picking = true;
    this.hint.hidden = false;
    this.options.container.classList.add('replay-picking');
    const chartEl = this.options.container.querySelector<HTMLElement>('.chart') ?? this.options.container;
    const onClick = (e: MouseEvent) => {
      const chart = this.options.chart();
      const rect = chartEl.getBoundingClientRect();
      const result = chart.convertFromPixel([{ x: e.clientX - rect.left, y: e.clientY - rect.top }], { paneId: 'candle_pane' });
      const point = Array.isArray(result) ? result[0] : result;
      const bars = this.session ? this.session.visible() : chart.getDataList();
      let time = point?.timestamp;
      if (time === undefined && point?.dataIndex !== undefined) time = bars[Math.max(0, Math.min(bars.length - 1, point.dataIndex))]?.timestamp;
      e.stopPropagation();
      e.preventDefault();
      this.endPick();
      if (time === undefined) {
        this.options.toast('Could not find a bar there', 'error');
        return;
      }
      void this.start({ startTime: time }).catch((error: unknown) => this.options.toast(error instanceof Error ? error.message : String(error), 'error'));
    };
    chartEl.addEventListener('click', onClick, { capture: true, once: true });
    this.pickCleanup = () => chartEl.removeEventListener('click', onClick, { capture: true });
    this.emit();
  }

  private endPick(): void {
    this.picking = false;
    this.hint.hidden = true;
    this.options.container.classList.remove('replay-picking');
    this.pickCleanup?.();
    this.pickCleanup = null;
    this.emit();
  }

  /** Starts (or restarts) replay. Without a start, it begins 100 bars back. */
  async start(opts: ReplayStartOptions = {}): Promise<ReplayState> {
    if (this.picking) this.endPick();
    this.pause();
    const chart = this.options.chart();
    const ctx = this.options.context();
    // Restarting from inside a replay must use every bar, not only the visible ones.
    let bars: KLineData[] = this.session ? this.session.all() : chart.getDataList().map((b) => ({ ...b }));
    if (bars.length < 2) throw new Error('No data on the chart yet');

    const barsBack = opts.startTime === undefined ? (opts.barsBack ?? 100) : undefined;
    const needTime = opts.startTime;
    bars = await this.ensureHistory(bars, ctx, needTime, barsBack !== undefined ? barsBack + 1 : undefined);

    let index: number;
    if (needTime !== undefined) {
      index = indexAtTime(bars, needTime);
      if (index < 0) throw new Error(`No history as far back as ${iso(needTime)}; the earliest bar is ${iso(bars[0].timestamp)}`);
    } else {
      index = bars.length - 1 - (barsBack ?? 100);
      if (index < 0) index = 0;
    }
    if (index >= bars.length - 1) throw new Error('Pick a start bar before the latest one');

    const session = new ReplaySession(bars, index);
    const symbol = chart.getSymbol();
    const period = chart.getPeriod();
    if (!symbol || !period) throw new Error('Chart is not ready');
    this.session = session;
    this.startTime = bars[index].timestamp;
    if (opts.speed) this.setSpeed(opts.speed);
    this.options.loader.enterReplay({ initial: () => session.visible(), context: { ticker: symbol.ticker, period } });
    chart.resetData();
    this.render();
    if (opts.autoplay) this.play();
    this.emit();
    return this.state();
  }

  /** Loads older pages from the exchange until the history covers what was asked for. */
  private async ensureHistory(bars: KLineData[], ctx: ReplayContext, fromTime?: number, count?: number): Promise<KLineData[]> {
    const covered = () => (fromTime === undefined || bars[0].timestamp <= fromTime) && (count === undefined || bars.length >= count);
    const source = getSource(ctx.source);
    for (let page = 0; page < MAX_HISTORY_PAGES && !covered(); page++) {
      const older = await source.fetchCandles(ctx.symbol, ctx.timeframe, { before: bars[0].timestamp, limit: 1000 });
      if (older.length === 0) break;
      bars = older.map(candleToKLine).concat(bars);
    }
    return bars;
  }

  step(count = 1): KLineData[] {
    const s = this.session;
    if (!s) throw new Error('Replay is not running. Start it first.');
    const revealed = s.step(count);
    for (const bar of revealed) this.options.loader.push(bar);
    if (s.done) {
      this.pause();
      this.options.toast('Replay reached the latest loaded bar');
    }
    this.render();
    this.emit();
    return revealed;
  }

  play(): void {
    if (!this.session || this.timer) return;
    if (this.session.done) return;
    this.timer = setInterval(() => this.step(1), stepInterval(this.speed));
    this.render();
    this.emit();
  }

  pause(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.render();
    this.emit();
  }

  toggle(): void {
    if (this.timer) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.speed = Math.min(10, Math.max(1, Math.round(speed)));
    this.speedSel.value = String(REPLAY_SPEEDS.find((s) => s >= this.speed) ?? 10);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.step(1), stepInterval(this.speed));
    }
    this.emit();
  }

  /** Leaves replay and reloads live data. */
  stop(): void {
    if (this.picking) this.endPick();
    if (!this.session) return;
    this.pause();
    this.session = null;
    this.startTime = null;
    this.options.loader.exitReplay();
    this.options.chart().resetData();
    this.render();
    this.emit();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    if (this.picking && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.endPick();
      return;
    }
    if (!this.session || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      this.step(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.stop();
    }
  }

  private render(): void {
    const s = this.session;
    this.bar.hidden = s === null;
    if (!s) return;
    const playing = this.timer !== null;
    this.playBtn.innerHTML = playing ? ICON.pause : ICON.play;
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playBtn.disabled = s.done;
    this.stepBtn.disabled = s.done;
    const t = new Date(s.current().timestamp);
    this.label.textContent = `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC  ${s.remaining} bars left`;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
