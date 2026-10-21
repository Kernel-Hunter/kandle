/**
 * Keyed data sources in a shared view. A link picks the source, but the API key is the
 * viewer's own, so while a shared chart is open, charts from a source with a saved key wait
 * for a click before anything is requested with it. Keep it releases them all. Embeds never
 * load keyed sources at all (src/embed).
 */
import { SOURCES, hasKey } from '../data/sources';
import type { DataSource } from '../data/types';
import { h } from '../ui/dom';
import type { SharedChart } from './codec';

/** Sources the chart and its layout use that need a key and have one saved here. */
export function keyedSources(chart: SharedChart, saved: (source: DataSource) => boolean = hasKey): string[] {
  const ids = new Set([chart.source, ...(chart.layout?.panes.map((p) => p.source) ?? [])]);
  return SOURCES.filter((s) => ids.has(s.id) && s.auth && saved(s)).map((s) => s.id);
}

export class KeyGate {
  private readonly held = new Set<string>();
  private readonly listeners = new Set<(sourceId: string) => void>();

  hold(sourceIds: Iterable<string>): void {
    for (const id of sourceIds) this.held.add(id);
  }

  /** True while charts from this source must not load. */
  holds(sourceId: string): boolean {
    return this.held.has(sourceId);
  }

  /** Lets the source load and tells the charts showing it. */
  release(sourceId: string): void {
    if (!this.held.delete(sourceId)) return;
    for (const l of this.listeners) l(sourceId);
  }

  releaseAll(): void {
    for (const id of [...this.held]) this.release(id);
  }

  onRelease(listener: (sourceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

let shared: KeyGate | null = null;

/** The app-wide gate. It holds nothing unless a shared chart was opened. */
export function keyGate(): KeyGate {
  shared ??= new KeyGate();
  return shared;
}

export interface KeyCover {
  el: HTMLElement;
  /** Shows the prompt for a held source, or hides it for null. */
  show(source: DataSource | null): void;
  dispose(): void;
}

/** The note over a chart that waits for its key, with the button that loads it. */
export function createKeyCover(gate: KeyGate = keyGate()): KeyCover {
  const el = h('div', { class: 'key-gate', hidden: true });
  let current: DataSource | null = null;
  const show = (source: DataSource | null) => {
    current = source;
    el.hidden = !source;
    if (!source) {
      el.replaceChildren();
      return;
    }
    el.replaceChildren(
      h('p', {}, `This shared chart uses your ${source.name} key. Nothing is sent to ${source.name} until you load it.`),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => gate.release(source.id) }, 'Load it'),
    );
  };
  const off = gate.onRelease((id) => {
    if (current?.id === id) show(null);
  });
  return { el, show, dispose: off };
}
