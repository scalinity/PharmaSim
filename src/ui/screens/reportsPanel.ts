// Reports (SPEC §17, §28): the market ledger — what each neighborhood asked
// for at the counter and what the store actually filled, over the week or
// the four-week book, in Plex Mono with trend arrows. Every number is
// *observed* (sim/city.ts memory): played days only, no generator
// omniscience — this is the "we keep running out of amoxicillin" page.

import type { EventBus } from "../../core/bus";
import { competitorDef } from "../../data/competitors";
import { DISTRICT_MAPS, DISTRICTS } from "../../data/districts";
import {
  observedWindow,
  OTC_TALLY_KEY,
  shareTrend,
  type ObservedLine,
  type ObservedWindowDays,
} from "../../sim/city";
import { poolPatientName, transfersThisWeek } from "../../sim/competitors";
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

function hex(tint: number): string {
  return `#${tint.toString(16).padStart(6, "0")}`;
}

export function createReportsPanel(sim: Sim, bus: EventBus<SimEvent>): ReportsPanelHandle {
  let visible = false;
  let pending = false;
  let windowDays: ObservedWindowDays = 7;

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

  // §18 "transfers in/out this week": named chronic regulars and the reason
  // their refills moved — the market's wins and losses, legible by name.
  const txCount = h("span", { cls: "reports__txcount" });
  const txHead = h("p", { cls: "reports__txhead" }, [
    h("span", { text: "Transfers this week" }),
    txCount,
  ]);
  const txList = h("div", { cls: "reports__txlist" });
  const txNone = h("p", {
    cls: "reports__txnone",
    text: "No transfers this week — the chronic regulars are staying put.",
  });
  const txSection = h("div", { cls: "reports__tx" }, [txHead, txList, txNone]);

  const sheet = Panel({ cls: "reports" }, [
    h("div", { cls: "reports__top" }, [
      h("div", {}, [
        h("p", { cls: "reports__eyebrow", text: "Market ledger · what the counter saw" }),
        h("h2", { cls: "panel__title", text: "Reports" }),
      ]),
      shareChip,
    ]),
    txSection,
    tabs.root,
    head,
    list,
    foot,
  ]);

  const root = h("div", { cls: "reportswrap" }, [sheet]);
  root.hidden = true;

  // The ledger's rows live for the panel's whole life and update through
  // cached refs (§30) — refresh writes textContent and classes; nodes are
  // made only when a category first shows up, and removed only when it
  // ages out of the window. The rows host is its own wrapper so the
  // green-bar striping counts data rows, not the district heading.
  interface RowRefs {
    root: HTMLElement;
    asked: HTMLElement;
    served: HTMLElement;
    short: HTMLElement;
    trend: HTMLElement;
  }

  interface DistrictBlock {
    rowsHost: HTMLElement;
    none: HTMLElement;
    rows: Map<string, RowRefs>;
  }

  const blocks = new Map<string, DistrictBlock>();
  for (const district of DISTRICTS) {
    const swatch = h("span", { cls: "reports__swatch", attrs: { "aria-hidden": "true" } });
    swatch.style.background = hex(DISTRICT_MAPS[district.id]!.tint);
    const rowsHost = h("div", { cls: "reports__rows" });
    const none = h("p", { cls: "reports__none", text: "Nothing seen from here yet." });
    list.append(
      h("section", { cls: "reports__district" }, [
        h("h3", { cls: "reports__districtname" }, [swatch, district.name]),
        rowsHost,
        none,
      ]),
    );
    blocks.set(district.id, { rowsHost, none, rows: new Map() });
  }

  function makeRow(label: string, front: boolean): RowRefs {
    const asked = h("span", { cls: "reports__num" });
    const served = h("span", { cls: "reports__num" });
    const short = h("span", { cls: "reports__num" });
    const trend = h("span", { cls: "reports__trend" });
    const row = h("div", { cls: front ? "reports__row reports__row--front" : "reports__row" }, [
      h("span", { cls: "reports__name", text: label }),
      asked,
      served,
      short,
      trend,
    ]);
    return { root: row, asked, served, short, trend };
  }

  function updateRow(refs: RowRefs, line: ObservedLine, priorKnown: boolean): void {
    refs.asked.textContent = String(line.asked);
    refs.served.textContent = String(line.served);
    const short = Math.max(0, line.asked - line.served);
    refs.short.textContent = short > 0 ? `short ${short}` : "·";
    refs.short.className =
      short > 0 ? "reports__num reports__num--short" : "reports__num reports__num--zero";
    // Trends only exist once a full prior window is on the books, and only
    // the weekly view can have one (the log holds the §17 28-day window).
    if (windowDays !== 7 || !priorKnown) {
      refs.trend.textContent = "—";
      refs.trend.className = "reports__trend reports__trend--none";
    } else if (line.priorAsked === 0) {
      refs.trend.textContent = "new";
      refs.trend.className = "reports__trend reports__trend--new";
    } else {
      const ratio = line.asked / line.priorAsked;
      if (ratio > 1.25) {
        refs.trend.textContent = "↑";
        refs.trend.className = "reports__trend reports__trend--up";
      } else if (ratio < 0.75) {
        refs.trend.textContent = "↓";
        refs.trend.className = "reports__trend reports__trend--down";
      } else {
        refs.trend.textContent = "→";
        refs.trend.className = "reports__trend";
      }
    }
  }

  // Transfer rows are immutable once written, so the cached refs only ever
  // appear, hold their order, and age out with the week (§30 — the same
  // no-rebuild rule as the ledger rows below).
  const txRows = new Map<string, HTMLElement>();

  function refreshTransfers(): void {
    const state = sim.snapshot;
    const records = transfersThisWeek(state);
    let inCount = 0;
    const live = new Set<string>();
    for (const record of records) {
      if (record.direction === "in") inCount++;
      const key = `${record.day}:${record.poolId}:${record.direction}`;
      live.add(key);
      let row = txRows.get(key);
      if (!row) {
        const out = record.direction === "out";
        row = h("p", { cls: out ? "reports__txrow reports__txrow--out" : "reports__txrow" }, [
          h("span", { cls: "reports__txday", text: `Day ${record.day}` }),
          h("span", {
            cls: "reports__txwho",
            text: `${poolPatientName(record.poolId)} — ${record.reason} ${out ? "→" : "←"} ${competitorDef(record.rivalId).name}`,
          }),
        ]);
        txRows.set(key, row);
      }
      txList.append(row);
    }
    for (const [key, row] of txRows) {
      if (!live.has(key)) {
        row.remove();
        txRows.delete(key);
      }
    }
    txCount.textContent = records.length > 0 ? `in ${inCount} · out ${records.length - inCount}` : "";
    txNone.hidden = records.length > 0;
  }

  function refresh(): void {
    const state = sim.snapshot;

    const trend = shareTrend(state);
    shareChip.textContent =
      trend.current === null
        ? "No routed days yet"
        : `City share ≈${(trend.current * 100).toFixed(1)}%`;

    refreshTransfers();

    for (const district of DISTRICTS) {
      const block = blocks.get(district.id)!;
      const seen = observedWindow(state, district.id, windowDays);
      const live = new Set<string>();

      const upsert = (key: string, label: string, line: ObservedLine, front: boolean): void => {
        live.add(key);
        let refs = block.rows.get(key);
        if (!refs) {
          refs = makeRow(label, front);
          block.rows.set(key, refs);
        }
        updateRow(refs, line, seen.priorKnown);
        // Ordered append: an already-parented node just moves, so the rows
        // track the asked-desc sort with no allocation.
        block.rowsHost.append(refs.root);
      };

      for (const line of seen.lines) {
        if (line.key === OTC_TALLY_KEY || (line.asked === 0 && line.served === 0)) continue;
        upsert(line.key, categoryLabel(line.key), line, false);
      }
      const otc = seen.lines.find((l) => l.key === OTC_TALLY_KEY);
      if (otc && otc.asked > 0) upsert(OTC_TALLY_KEY, "front store", otc, true);

      // Categories that aged out of this window come off the sheet — a
      // hidden row would still count against the nth-child striping.
      for (const [key, refs] of block.rows) {
        if (!live.has(key)) {
          refs.root.remove();
          block.rows.delete(key);
        }
      }
      block.none.hidden = block.rows.size > 0;
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
  bus.on("market.transfer", invalidate);

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
