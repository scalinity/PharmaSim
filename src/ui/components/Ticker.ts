// News ticker (SPEC §16, §28 component kit): a strip of wire-service tape
// under the top bar, cycling headlines one at a time in Plex Mono, each
// stamped with its in-game day. A dumb component like the rest of the kit —
// the world's actual headlines are derived beside the HUD that owns them.
// The strip is a fixed height and swaps content in place, so cycling never
// shifts the layout.

import { h } from "../dom";

const CYCLE_MS = 6500;

export interface TickerItem {
  day: number;
  text: string;
}

export interface TickerHandle {
  root: HTMLElement;
  /** Replace the rotation. An unchanged list keeps its place mid-cycle. */
  set(items: TickerItem[]): void;
  setVisible(on: boolean): void;
}

export function createTicker(): TickerHandle {
  const dayEl = h("span", { cls: "ticker__day" });
  const textEl = h("span", { cls: "ticker__text" });
  const lineEl = h("span", { cls: "ticker__line" }, [dayEl, textEl]);
  const root = h("div", { cls: "ticker", attrs: { "aria-label": "News ticker" } }, [lineEl]);

  let items: TickerItem[] = [];
  let index = 0;
  let timer = 0;
  let visible = true;

  function show(animate: boolean): void {
    const item = items[index];
    root.hidden = !visible || item === undefined;
    if (!item) return;
    lineEl.classList.remove("ticker__line--cycle");
    if (animate) {
      // Restart the slide-in even when the class was already on.
      void lineEl.offsetWidth;
      lineEl.classList.add("ticker__line--cycle");
    }
    dayEl.textContent = `Day ${item.day}`;
    textEl.textContent = item.text;
  }

  /** (Re)arm the cycle timer — or tear it down while the strip is hidden
   *  or has nothing to rotate, so a hidden ticker does no work at all. */
  function schedule(): void {
    window.clearInterval(timer);
    timer = 0;
    if (!visible || items.length < 2) return;
    timer = window.setInterval(() => {
      index = (index + 1) % items.length;
      show(true);
    }, CYCLE_MS);
  }

  return {
    root,
    set(next) {
      const changed =
        next.length !== items.length ||
        next.some((item, i) => item.text !== items[i]!.text || item.day !== items[i]!.day);
      if (!changed) return;
      items = next;
      index = 0;
      show(true);
      schedule();
    },
    setVisible(on) {
      if (visible === on) return;
      visible = on;
      root.hidden = !on || items[index] === undefined;
      schedule();
    },
  };
}
