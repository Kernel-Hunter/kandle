import type { Chart, DataLoader, DeepPartial, Styles } from 'klinecharts';
import './features.css';
import { BridgeClient } from '../agent/client';
import { createHandlers, dispatch, type HostEnv, type PaneLike } from '../agent/handlers';
import { createAgentPanel } from '../agent/panel';
import { AlertEngine, type Alert, type AlertKind, type TickContext } from '../alerts/engine';
import { ensureNotificationPermission, playAlertSound, showSystemNotification, unlockAudioOnGesture } from '../alerts/notify';
import { createAlertsPanel } from '../alerts/panel';
import { APP } from '../config';
import { SOURCES, getSource, loadSymbols } from '../data/sources';
import type { TimeframeId } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import { LayoutManager } from '../layout/manager';
import type { PaneHandle } from '../layout/pane';
import { ReplayController } from '../replay/controller';
import { SwitchingLoader } from '../replay/loader';
import type { DrawingRecord, KeyValueStorage, Theme } from '../store/layout';
import { h } from '../ui/dom';
import type { ActiveIndicator } from '../ui/indicatorPanel';

/** The public parts of App these features use. */
export interface FeatureApp {
  toast(message: string, kind?: 'info' | 'error'): void;
  setSymbol(sourceId: string, meta: SymbolMeta): void;
  setTimeframe(id: TimeframeId): void;
  addIndicator(name: string, params?: number[]): string | null;
  removeIndicator(id: string): void;
}

/** Shape of window.kandle as set up by App.exposeForAutomation (plus runScript when a script engine is present). */
interface KandleApi {
  getState(): { source: string; symbol: string; timeframe: TimeframeId; theme: Theme; drawings: DrawingRecord[] };
  listIndicators(): ActiveIndicator[];
  draw(name: string, points: Array<{ timestamp: number; value: number }>, text?: string): string | null | Array<string | null>;
  runScript?: (code: string, name?: string) => unknown;
  [key: string]: unknown;
}

export interface FeatureDeps {
  app: FeatureApp;
  chart: Chart;
  storage: KeyValueStorage;
  root: HTMLElement;
  styles: (theme: Theme) => DeepPartial<Styles>;
}

export interface Features {
  /** Wraps the main chart's live loader so replay and sync can sit in between. */
  wrapLoader(live: DataLoader): SwitchingLoader;
  /** Call for every live update of the main chart. */
  onLiveCandle(candle: Candle): void;
  /** Call after window.kandle exists. Builds the UI and connects everything. */
  start(): void;
}

const DRAWINGS_GROUP = 'drawings';
const REPLAY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><path d="M10.5 9v6l4.5-3z" fill="currentColor"/></svg>';

const api = (): KandleApi => {
  const value = (window as unknown as Record<string, unknown>)[APP.id] as KandleApi | undefined;
  if (!value) throw new Error('window.kandle is not ready');
  return value;
};

/**
 * Agent bridge, alerts, bar replay and multi-chart layouts. Kept out of app.ts so the
 * core chart stays small; App calls wrapLoader, onLiveCandle and start, nothing else.
 */
export function createFeatures(deps: FeatureDeps): Features {
  let loader: SwitchingLoader | null = null;
  const engine = new AlertEngine(deps.storage);
  let mainPane: PaneHandle | null = null;
  let replay: ReplayController | null = null;

  const theme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  /** Indicator values and drawing positions as the chart has them right now. */
  const tickContext = (pane: PaneHandle): TickContext => ({
    drawing: (alert: Alert) => {
      if (pane.index !== 1 || !alert.drawing?.id) return null;
      const overlay = pane.chart().getOverlays({ id: alert.drawing.id })[0];
      if (!overlay || overlay.name !== alert.drawing.name) return null;
      const points = overlay.points
        .filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number')
        .map((p) => ({ timestamp: p.timestamp as number, value: p.value as number }));
      return points.length ? { name: overlay.name, points, id: overlay.id } : null;
    },
    indicatorValue: (alert: Alert) => {
      const ref = alert.indicator;
      if (!ref) return null;
      const active = pane.indicators();
      const match =
        active.find((i) => i.id === ref.id && i.name === ref.name) ??
        active.find((i) => i.name === ref.name && JSON.stringify(i.params) === JSON.stringify(ref.params ?? i.params));
      if (!match) return null;
      const ind = pane.chart().getIndicators({ id: match.id })[0];
      const result = (ind?.result ?? []) as Array<Record<string, unknown>>;
      const value = result[result.length - 1]?.[ref.line];
      return typeof value === 'number' ? value : null;
    },
  });

  const fire = (fired: ReturnType<AlertEngine['onTick']>) => {
    for (const f of fired) {
      const text = `${f.text} (${Number(f.value.toPrecision(8))})`;
      deps.app.toast(`Alert: ${text}`);
      showSystemNotification(`${APP.name} alert`, text);
      playAlertSound();
    }
  };

  const evaluate = (pane: PaneHandle, candle: Candle, kinds: readonly AlertKind[]) => {
    const info = pane.info();
    const tick = { time: candle.time, price: candle.close, high: candle.high, low: candle.low };
    fire(engine.onTick(info.source, info.symbol, tick, tickContext(pane), kinds));
  };

  /** Price and line alerts run on every update; indicator alerts wait for the engine to recompute. */
  const pendingIndicatorChecks = new Map<number, { candle: Candle; timer: ReturnType<typeof setTimeout> }>();
  const onPaneCandle = (pane: PaneHandle, candle: Candle) => {
    evaluate(pane, candle, ['price', 'drawing']);
    const queued = pendingIndicatorChecks.get(pane.index);
    if (queued) {
      queued.candle = candle;
      return;
    }
    const entry = {
      candle,
      timer: setTimeout(() => {
        pendingIndicatorChecks.delete(pane.index);
        evaluate(pane, entry.candle, ['indicator']);
      }, 150),
    };
    pendingIndicatorChecks.set(pane.index, entry);
  };

  return {
    wrapLoader(live) {
      loader = new SwitchingLoader(live);
      return loader;
    },

    onLiveCandle(candle) {
      if (mainPane) onPaneCandle(mainPane, candle);
    },

    start() {
      if (!loader) throw new Error('wrapLoader must be called before start');
      const switching = loader;
      const chart = deps.chart;
      const app = deps.app;
      unlockAudioOnGesture();

      const main: PaneHandle = {
        index: 1,
        chart: () => chart,
        loader: () => switching,
        info: () => {
          const s = api().getState();
          return { source: s.source, symbol: s.symbol, timeframe: s.timeframe };
        },
        setSymbol: (source, meta) => app.setSymbol(source, meta),
        setTimeframe: (tf) => app.setTimeframe(tf),
        addIndicator: (name, params) => app.addIndicator(name, params),
        removeIndicator: (id) => app.removeIndicator(id),
        indicators: () => api().listIndicators(),
      };
      mainPane = main;

      const wrap = deps.root.querySelector<HTMLElement>('.chart-wrap');
      if (!wrap) throw new Error('Missing chart wrapper');
      replay = new ReplayController({
        chart: () => chart,
        loader: switching,
        container: wrap,
        context: () => main.info(),
        toast: (m, k) => app.toast(m, k),
      });
      const layout = new LayoutManager({
        main,
        mainWrap: wrap,
        storage: deps.storage,
        theme,
        styles: deps.styles,
        toast: (m, k) => app.toast(m, k),
        onLiveCandle: (pane, candle) => onPaneCandle(pane, candle),
      });

      const env: HostEnv = {
        pane: (index) => layout.pane(index) as PaneLike | null,
        sources: () => SOURCES.map((s) => s.id),
        symbols: (source) => loadSymbols(getSource(source), deps.storage),
        fetchCandles: (source, symbol, timeframe, options) => getSource(source).fetchCandles(symbol, timeframe, options),
        draw: (overlay, points, text) => {
          const id = api().draw(overlay, points, text);
          return typeof id === 'string' ? id : null;
        },
        removeDrawing: (id) => {
          const exists = chart.getOverlays({ id, groupId: DRAWINGS_GROUP }).length > 0;
          if (exists) chart.removeOverlay({ id });
          return exists;
        },
        clearDrawings: () => {
          const count = chart.getOverlays({ groupId: DRAWINGS_GROUP }).length;
          if (count) chart.removeOverlay({ groupId: DRAWINGS_GROUP });
          return count;
        },
        scriptRunner: () => {
          const run = api().runScript;
          return typeof run === 'function' ? run : undefined;
        },
        background: () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1115',
        paint: () =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 800);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(timer);
                resolve(true);
              }),
            );
          }),
        alerts: engine,
        requestNotifications: () => void ensureNotificationPermission(),
        replay,
        layout,
      };
      const handlers = createHandlers(env);

      // ---------------------------------------------------------------- top bar
      const alertsPanel = createAlertsPanel({
        engine,
        chart: () => chart,
        symbol: () => main.info(),
        indicators: () => main.indicators(),
        create: (params) =>
          dispatch(handlers, 'set_alert', params).then((r) => {
            if (!r.ok) throw new Error(r.error);
            return r.result;
          }),
        toast: (m, k) => app.toast(m, k),
      });
      const replayBtn = h(
        'button',
        {
          class: 'tb-btn',
          title: 'Bar replay: pick a start bar, then play forward',
          onclick: () => replay!.pick(),
        },
        h('span', { html: REPLAY_ICON }),
        h('span', { class: 'tb-label' }, 'Replay'),
      );
      replay.onChange(() => replayBtn.classList.toggle('active', replay!.active || replay!.state().picking));
      const agentPanel = createAgentPanel({ storage: deps.storage, onChange: (s) => applyBridge(s) });

      const topbar = deps.root.querySelector('.topbar');
      const spacer = topbar?.querySelector('.spacer');
      if (topbar && spacer) {
        spacer.before(h('div', { class: 'feature-group' }, alertsPanel.button, replayBtn, layout.createControl()));
        (topbar.querySelector('.status') ?? spacer).after(agentPanel.button);
      }

      // ---------------------------------------------------------------- agent bridge
      let client: BridgeClient | null = null;
      const applyBridge = (settings: ReturnType<typeof agentPanel.settings>) => {
        client?.stop();
        client = null;
        if (!settings.enabled || !settings.token) {
          agentPanel.setStatus('off');
          return;
        }
        client = new BridgeClient({
          url: `ws://127.0.0.1:${settings.port}`,
          token: settings.token,
          app: APP.id,
          version: '0.1.0',
          handle: (method, params) => dispatch(handlers, method, params),
          onStatus: (status, detail) => agentPanel.setStatus(status, detail),
          onActivity: (method, ok, error) => agentPanel.logActivity(method, ok, error),
        });
        client.start();
      };
      applyBridge(agentPanel.settings());

      // ---------------------------------------------------------------- automation handle
      Object.assign(api(), {
        alerts: {
          list: () => engine.list(),
          add: (params: Record<string, unknown>) => dispatch(handlers, 'set_alert', params),
          remove: (id: string) => engine.remove(id),
          /** Feeds a synthetic update to the main chart's alerts, for testing delivery. */
          simulate: (price: number) => {
            const bars = chart.getDataList();
            const last = bars[bars.length - 1];
            if (!last) return [];
            const candle: Candle = { time: last.timestamp, open: last.open, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: last.volume ?? 0 };
            const info = main.info();
            const fired = engine.onTick(info.source, info.symbol, { time: candle.time, price, high: candle.high, low: candle.low }, tickContext(main));
            fire(fired);
            return fired.map((f) => f.alert.id);
          },
        },
        replay: {
          start: (opts: Record<string, unknown>) => dispatch(handlers, 'start_replay', opts),
          step: (bars = 1) => dispatch(handlers, 'step_replay', { bars }),
          stop: () => dispatch(handlers, 'stop_replay', {}),
          state: () => replay!.state(),
        },
        layout: {
          set: (params: Record<string, unknown>) => dispatch(handlers, 'set_layout', params),
          state: () => layout.state(),
        },
        bridge: {
          status: () => client?.status ?? 'off',
          call: (method: string, params: Record<string, unknown> = {}) => dispatch(handlers, method as never, params),
        },
      });

      void layout.init();
    },
  };
}
