// Reports (SPEC §17, §28): the market ledger — what each neighborhood asked
// for at the counter and what the store actually filled, over the week or
// the four-week book, in Plex Mono with trend arrows. Every number is
// *observed* (sim/city.ts memory): played days only, no generator
// omniscience — this is the "we keep running out of amoxicillin" page.

import type { EventBus } from "../../core/bus";
import { DISTRICT_MAPS, DISTRICTS } from "../../data/districts";
import { observedWindow, OTC_TALLY_KEY, shareTrend, type ObservedLine } from "../../sim/city";
import { categoryLabel } from "../../sim/economy";
import type { SimEvent } from "../../sim/events";
import type { Sim } from "../../sim/sim";
import { Panel } from "../components/Panel";
import { Tabs } from "../components/Tabs";
import { h } from "../dom";

export interface ReportsPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

type WindowDays = 7 | 28;

function hex(tint: number): string {
  return `#${tint.toString(16).padStart(6, "0")}`;
}

export function createReportsPanel(sim: Sim, bus: EventBus<SimEvent>): ReportsPanelHandle {
  let visible = false;
  let pending = false;
  let windowDays: WindowDays = 7;

  const shareChip = h("span", { cls: "reports__share" });
  const tabs = Tabs(
    [
      { id: "7", label: "This week" },
      { id: "28", label: "Four weeks" },
    ],
    (id) => {
      windowDays = id === "28" ? 28 : 7;
      refresh();
    },
  );
  tabs.setActive("7");

  const head = h("div", { cls: "reports__head", attrs: { "aria-hidden": "true" } }, [
    h("span", { cls: "reports__col reports__col--name", text: "asked for" }),
    h("span", { cls: "reports__col", text: "asked" }),
    h("span", { cls: "reports__col", text: "filled" }),
    h("span", { cls: "reports__col", text: "short" }),
    h("span", { cls: "reports__col", text: "trend" }),
  ]);

  const list = h("div", { cls: "reports__list" });
  const foot = h("p", {
    cls: "reports__foot",
    text: "Played days only — the counter can't count demand it never saw. “Short” is demand that walked in and left unfilled.",
  });

  const sheet = Panel({ cls: "reports" }, [
    h("div", { cls: "reports__top" }, [
      h("div", {}, [
        h("p", { cls: "reports__eyebrow", text: "Market ledger · what the counter saw" }),
        h("h2", { cls: "panel__title", text: "Reports" }),
      ]),
      shareChip,
    ]),
    tabs.root,
    head,
    list,
    foot,
  ]);

  const root = h("div", { cls: "reportswrap" }, [sheet]);
  root.hidden = true;

  function trendCell(line: ObservedLine, priorKnown: boolean): HTMLElement {
    // Trends only exist once a full prior window is on the books, and only
    // the weekly view has one (the log holds the §17 28-day window).
    if (windowDays !== 7 || !priorKnown) {
      return h("span", { cls: "reports__trend reports__trend--none", text: "—" });
    }
    if (line.priorAsked === 0) {
      return h("span", { cls: "reports__trend reports__trend--new", text: "new" });
    }
    const ratio = line.asked / line.priorAsked;
    if (ratio > 1.25) return h("span", { cls: "reports__trend reports__trend--up", text: "↑" });
    if (ratio < 0.75) return h("span", { cls: "reports__trend reports__trend--down", text: "↓" });
    return h("span", { cls: "reports__trend", text: "→" });
  }

  function row(label: string, line: ObservedLine, priorKnown: boolean, front: boolean): HTMLElement {
    const short = Math.max(0, line.asked - line.served);
    return h("div", { cls: front ? "reports__row reports__row--front" : "reports__row" }, [
      h("span", { cls: "reports__name", text: label }),
      h("span", { cls: "reports__num", text: String(line.asked) }),
      h("span", { cls: "reports__num", text: String(line.served) }),
      h("span", {
        cls: short > 0 ? "reports__num reports__num--short" : "reports__num reports__num--zero",
        text: short > 0 ? `short ${short}` : "·",
      }),
      trendCell(line, priorKnown),
    ]);
  }

  function refresh(): void {
    const state = sim.snapshot;

    const trend = shareTrend(state);
    shareChip.textContent =
      trend.current === null
        ? "No routed days yet"
        : `City share ≈${(trend.current * 100).toFixed(1)}%`;

    list.replaceChildren();
    for (const district of DISTRICTS) {
      const seen = observedWindow(state, district.id, windowDays);
      const rx = seen.lines.filter((l) => l.key !== OTC_TALLY_KEY && (l.asked > 0 || l.served > 0));
      const otc = seen.lines.find((l) => l.key === OTC_TALLY_KEY);

      const swatch = h("span", { cls: "reports__swatch", attrs: { "aria-hidden": "true" } });
      swatch.style.background = hex(DISTRICT_MAPS[district.id]!.tint);
      const block = h("section", { cls: "reports__district" }, [
        h("h3", { cls: "reports__districtname" }, [swatch, district.name]),
      ]);

      if (rx.length === 0 && (!otc || otc.asked === 0)) {
        block.append(
          h("p", { cls: "reports__none", text: "Nothing seen from here yet." }),
        );
      } else {
        for (const line of rx) {
          block.append(row(categoryLabel(line.key), line, seen.priorKnown, false));
        }
        if (otc && otc.asked > 0) {
          block.append(row("front store", otc, seen.priorKnown, true));
        }
      }
      list.append(block);
    }
  }

  /** Coalesce spawn-by-spawn churn into one repaint per frame. */
  function invalidate(): void {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (visible) refresh();
    });
  }

  bus.on("customer.spawned", invalidate);
  bus.on("rx.pickedUp", invalidate);
  bus.on("rx.refused", invalidate);
  bus.on("sale.completed", invalidate);
  bus.on("customer.walkout", invalidate);
  bus.on("day.phaseChanged", invalidate);

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
