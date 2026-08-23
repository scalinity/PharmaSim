// News ticker (SPEC §16, §28 component kit): a strip of wire-service tape
// under the top bar, cycling the world's active headlines one at a time in
// Plex Mono — season turns, shortages, storms, legacy moments, and (later)
// competitor moves — each stamped with its in-game day. The strip is a fixed
// height and swaps content in place, so cycling never shifts the layout.

import { DAYS_PER_SEASON, seasonForDay, type Season } from "../../core/clock";
import { legacyMomentDef } from "../../data/flavor";
import { categoryLabel } from "../../sim/economy";
import { outageActive } from "../../sim/events-world";
import type { GameState } from "../../sim/state";
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

/** §16 season headlines — the standing story while nothing else is on. */
const SEASON_HEADLINES: Record<Season, string> = {
  Spring: "Allergy season settles in — antihistamines move fast",
  Summer: "Summer lull — the floor runs a little quieter",
  Fall: "Back to school — pediatric antibiotics in demand",
  Winter: "Flu season — the whole town wants shots and cold relief",
};

/** How long a legacy moment stays on the wire (§22: news, not a memorial). */
const LEGACY_NEWS_DAYS = 1;

/**
 * The wire's content, derived from state alone so a reloaded session reads
 * the same news: the season's standing line, active and just-eased
 * shortages, tonight's storm forecast, today's storm and its outage, and
 * fresh legacy moments.
 */
export function worldHeadlines(state: GameState): TickerItem[] {
  const items: TickerItem[] = [];
  const events = state.events;

  const season = seasonForDay(state.day);
  const seasonStart = Math.floor((state.day - 1) / DAYS_PER_SEASON) * DAYS_PER_SEASON + 1;
  items.push({ day: seasonStart, text: SEASON_HEADLINES[season] });

  for (const s of events.shortages) {
    if (state.day > s.endDay) {
      items.push({
        day: s.endDay + 1,
        text: `${categoryLabel(s.category)} shortage eases — wholesale back to list`,
      });
    } else if (state.day >= s.startDay) {
      items.push({
        day: s.startDay,
        text: `Regional ${categoryLabel(s.category)} shortage — wholesale ×1.5, orders fill 60%`,
      });
    }
  }

  for (const storm of events.storms) {
    if (storm.day === state.day + 1 && state.phase === "close") {
      items.push({ day: state.day, text: "Storm expected tomorrow — generators hold the cold" });
    } else if (storm.day === state.day) {
      items.push(
        outageActive(state)
          ? { day: state.day, text: "Power is out across Old Town — registers on the cash box" }
          : { day: state.day, text: "Storm over Old Town — a thin crowd and a fragile grid" },
      );
    }
  }

  for (const moment of state.legacy) {
    if (state.day - moment.day <= LEGACY_NEWS_DAYS) {
      items.push({ day: moment.day, text: legacyMomentDef(moment.id).title });
    }
  }

  return items;
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

  function schedule(): void {
    window.clearInterval(timer);
    timer = 0;
    if (items.length < 2) return;
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
      visible = on;
      root.hidden = !on || items[index] === undefined;
    },
  };
}
