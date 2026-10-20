import { csvStore } from '../data/csv';
import { keyStore } from '../data/keys';
import type { KrakenSource } from '../data/kraken';
import { SOURCES, cachedSymbols, hasKey } from '../data/sources';
import { binanceTickerFeed, bybitTickerFeed, coinbaseTickerFeed, krakenTickerFeed, okxTickerFeed, type TickerFeed } from '../data/tickers';
import type { SymbolMeta } from '../data/types';
import type { PaneHandle } from '../layout/pane';
import type { KeyValueStorage } from '../store/layout';
import { createSymbolSearch } from '../ui/symbolSearch';
import { WatchlistController } from './controller';
import { createWatchlistPanel } from './panel';

export interface WatchlistDeps {
  storage: KeyValueStorage;
  /** The chart pane the user last clicked. */
  focusedPane: () => PaneHandle;
  metaFor: (source: string, symbol: string) => Promise<SymbolMeta>;
  toast: (message: string, kind?: 'info' | 'error') => void;
}

/** One ticker stream per keyless exchange. Sources missing here (keyed and CSV) are polled. */
export function tickerFeeds(): Record<string, TickerFeed> {
  const kraken = SOURCES.find((s) => s.id === 'kraken') as KrakenSource | undefined;
  return {
    binance: binanceTickerFeed(),
    coinbase: coinbaseTickerFeed(),
    bybit: bybitTickerFeed(),
    okx: okxTickerFeed(),
    ...(kraken ? { kraken: krakenTickerFeed((symbol) => kraken.wsSymbolFor(symbol)) } : {}),
  };
}

/** Builds the watchlist controller and panel and connects them to the page. */
export function createWatchlist(deps: WatchlistDeps) {
  const source = (id: string) => SOURCES.find((s) => s.id === id);
  const controller = new WatchlistController({
    storage: deps.storage,
    source,
    hasKey,
    feeds: tickerFeeds(),
    openByDefault: typeof window !== 'undefined' && window.innerWidth >= 1200,
  });
  const search = createSymbolSearch({
    storage: deps.storage,
    currentSource: () => deps.focusedPane().info().source,
    onPick: (sourceId, meta) => panel.addPicked(sourceId, meta),
  });
  const panel = createWatchlistPanel({
    controller,
    current: () => {
      const info = deps.focusedPane().info();
      return { source: info.source, symbol: info.symbol };
    },
    load: (item) => {
      const pane = deps.focusedPane();
      void deps.metaFor(item.source, item.symbol).then((meta) => pane.setSymbol(item.source, meta));
    },
    search: () => search.open(),
    sourceName: (id) => source(id)?.name ?? id,
    precision: (item) => {
      const s = source(item.source);
      return s ? cachedSymbols(s, deps.storage)?.find((m) => m.symbol === item.symbol)?.pricePrecision : undefined;
    },
    toast: deps.toast,
  });

  document.addEventListener('visibilitychange', () => controller.setPageVisible(!document.hidden));
  if (document.hidden) controller.setPageVisible(false);
  controller.start();
  keyStore().onChange((sourceId) => controller.keysChanged(sourceId));
  csvStore().onChange(() => controller.keysChanged('csv'));

  return { controller, panel };
}
