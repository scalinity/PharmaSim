// End-of-day receipt (SPEC §28, the signature element): a strip of perforated
// register paper that *prints* — lines appear top-down with a dot-matrix
// stagger over ~1.2 s, click the sheet to skip, reduced-motion is instant —
// closing with a rubber-stamp PROFIT / LOSS verdict. Every line is a ledger
// reason posted during the day (§10), so the paper always adds up to the till.
//
// Multi-branch (§19/§28): the close prints one sheet per store, tabbed like
// paper on a spike — the visited store keeps the full itemized receipt, and
// every unvisited branch gets its resolved summary page (demand, capacity,
// takings, incidents) off its §24 daySummary.

import { formatClock, seasonForDay } from "../../core/clock";
import { districtById } from "../../data/districts";
import { legacyMomentDef } from "../../data/flavor";
import { REP_REASONS } from "../../sim/customers";
import { groupTotal, LEDGER_REASONS, ledgerNet, operatingProfit } from "../../sim/economy";
import { stormTomorrow } from "../../sim/events-world";
import type { Sim } from "../../sim/sim";
import { activeStore, storeName, type StoreState } from "../../sim/state";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";
import { money, signed } from "../format";

const PRINT_MS = 1200;

const GROUP_TITLES: Record<string, string> = {
  revenue: "register",
  cost: "paid out",
  financing: "borrowed",
};

interface SheetRefs {
  sheet: HTMLElement;
  items: HTMLElement[];
}

/** Shared line-builder vocabulary for one strip of register paper. */
function sheetBuilder(): {
  items: HTMLElement[];
  item: (el: HTMLElement) => HTMLElement;
  line: (left: string, right: string, cls?: string) => HTMLElement;
  rule: () => HTMLElement;
  section: (label: string) => HTMLElement;
} {
  const items: HTMLElement[] = [];
  const item = (el: HTMLElement): HTMLElement => {
    el.classList.add("rcpt__item");
    items.push(el);
    return el;
  };
  const line = (left: string, right: string, cls = ""): HTMLElement =>
    item(
      h("div", { cls: `rcpt__line${cls ? ` ${cls}` : ""}` }, [
        h("span", { cls: "rcpt__l", text: left }),
        h("span", { cls: "rcpt__r", text: right }),
      ]),
    );
  const rule = (): HTMLElement => item(h("div", { cls: "rcpt__rule" }));
  const section = (label: string): HTMLElement =>
    item(h("div", { cls: "rcpt__section", text: label }));
  return { items, item, line, rule, section };
}

/** The visited store's full itemized sheet — the account's paper. */
function buildVisitedSheet(sim: Sim): SheetRefs {
  const state = sim.snapshot;
  const store = activeStore(state);
  const stats = state.dayStats;
  const profit = operatingProfit(stats);
  const { items, item, line, rule, section } = sheetBuilder();

  // --- Header ---
  item(h("div", { cls: "rcpt__store", text: storeName(state, store).toUpperCase() }));
  item(h("div", { cls: "rcpt__meta", text: `day ${state.day} · ${seasonForDay(state.day)}` }));
  // A renovation day closes when the last customer leaves, not at 20:00 (§13).
  item(
    h("div", {
      cls: "rcpt__meta",
      text:
        store.pendingEra !== null
          ? `${formatClock(state.clockIgm)} · closed for renovation`
          : "20:00 · register closed",
    }),
  );
  rule();

  // --- The ledger, one section per group, in posting order (§10) ---
  for (const group of ["revenue", "cost", "financing"] as const) {
    const posted = LEDGER_REASONS.filter(
      (reason) => reason.group === group && stats.ledger[reason.id],
    );
    if (posted.length === 0) continue;
    section(GROUP_TITLES[group]!);
    for (const reason of posted) {
      const tally = stats.ledger[reason.id]!;
      line(
        `${reason.label} ×${tally.count}`,
        money(tally.amount),
        tally.amount < 0 ? "rcpt__line--rose" : "",
      );
    }
    line(
      group === "revenue" ? "Taken in" : group === "cost" ? "Paid out" : "Net borrowed",
      money(groupTotal(stats, group)),
      "rcpt__line--total",
    );
    rule();
  }

  line("Operating profit", money(profit), "rcpt__line--total");
  line("Till at open", money(stats.cashOpen));
  line("Till now", money(state.cash), "rcpt__line--total");
  rule();

  // --- The floor ---
  section("the floor");
  line("Visitors", String(stats.visitors));
  line("Scripts filled", String(stats.fills));
  if (stats.vaccinations > 0) line("Flu shots given", String(stats.vaccinations));
  line("Walk-outs", String(stats.walkouts), stats.walkouts > 0 ? "rcpt__line--rose" : "");
  if (stats.errors > 0) line("Dispensing errors", String(stats.errors), "rcpt__line--rose");
  if (stats.refusals > 0) line("Scripts refused", String(stats.refusals), "rcpt__line--rose");

  const stockOuts = Object.values(stats.stockOuts).reduce((sum, n) => sum + n, 0);
  const balks = Object.values(stats.balks).reduce((sum, n) => sum + n, 0);
  if (stockOuts > 0) line("Sales lost to empty shelves", String(stockOuts), "rcpt__line--rose");
  if (balks > 0) line("Put back over price", String(balks), "rcpt__line--rose");
  // Everything asked for that we could hand over — scripts and shelves both.
  const rate = store.fillRate7d[0];
  if (rate !== undefined) line("Asked and served", `${Math.round(rate * 100)}%`);

  // §18 market note: one line, only when the day moved a district's share
  // meaningfully (±2 points against the last played day) — the biggest
  // mover speaks for the market. A renovation day never planned (the log's
  // top entries are two *earlier* days), so its receipt stays quiet rather
  // than reprinting last night's move.
  const shareDays = state.city.districtShareLog;
  if (store.pendingEra === null && shareDays.length >= 2) {
    let moverId: string | null = null;
    let moverDelta = 0;
    for (const districtId of Object.keys(shareDays[0]!)) {
      const prior = shareDays[1]![districtId];
      if (prior === undefined) continue;
      const delta = shareDays[0]![districtId]! - prior;
      if (Math.abs(delta) > Math.abs(moverDelta)) {
        moverDelta = delta;
        moverId = districtId;
      }
    }
    if (moverId !== null && Math.abs(moverDelta) >= 0.02) {
      line(
        `Market — ${districtById(moverId).name} share`,
        `${moverDelta >= 0 ? "+" : ""}${(moverDelta * 100).toFixed(1)} pts`,
        moverDelta < 0 ? "rcpt__line--rose" : "",
      );
    }
  }
  rule();

  // --- Word of mouth (§15 rep delta with reasons) ---
  section("word of mouth");
  for (const reason of Object.values(REP_REASONS)) {
    const tally = stats.repReasons[reason];
    if (!tally) continue;
    line(
      `${reason} ×${tally.count}`,
      signed(tally.delta, 2),
      tally.delta < 0 ? "rcpt__line--rose" : "",
    );
  }
  line("Reputation", `${signed(stats.repDelta, 2)} → ${store.repStars.toFixed(2)} ★`);
  rule();

  // --- Verdict stamp + footer ---
  const stampKind = stats.familyLoan > 0 ? "family" : profit > 0 ? "profit" : "loss";
  const stamp = item(
    h("div", {
      cls: `rcpt__stamp rcpt__stamp--${stampKind}`,
      text: stampKind === "family" ? "FAMILY LOAN" : stampKind === "profit" ? "PROFIT" : "LOSS",
    }),
  );
  stamp.classList.add("rcpt__stamp--anim");
  if (stats.familyLoan > 0) {
    item(
      h("p", {
        cls: "rcpt__note",
        text: `Aunt Rosa covered the till with ${money(stats.familyLoan)}. She'll take 15% of each day's profit until it's square.`,
      }),
    );
  }

  // --- Pinned notes (§22, §28): the same slip of family paper carries
  //     today's legacy moments and the §16 weather, which reads straight
  //     from the world's event state — a storm is news, never a moment.
  const pinNote = (title: string, text: string): void => {
    item(
      h("div", { cls: "rcpt__legacy" }, [
        h("span", { cls: "rcpt__legacypin", attrs: { "aria-hidden": "true" } }),
        h("p", { cls: "rcpt__legacytitle", text: title }),
        h("p", { cls: "rcpt__legacytext", text }),
      ]),
    );
  };
  for (const moment of state.legacy) {
    if (moment.day !== state.day) continue;
    const def = legacyMomentDef(moment.id);
    pinNote(def.title, def.text);
  }
  if (stormTomorrow(state)) {
    pinNote(
      "Storm expected tomorrow",
      "Heavy weather is crossing tomorrow and the grid may drop with it. " +
        "Everything in the fridge rides on backup power — a generator from the Build palette holds the cold.",
    );
  }
  const outage = state.events.outage;
  if (outage !== null && outage.day === state.day && outage.hadGenerator) {
    pinNote(
      "The generator held",
      "The power dropped mid-shift and the backup generator caught it without a flicker. " +
        "The fridge never knew.",
    );
  }

  item(h("div", { cls: "rcpt__meta rcpt__foot", text: "thank you — come again" }));

  const sheet = h(
    "div",
    { cls: "rcpt", attrs: { role: "status", "aria-label": "End of day receipt" } },
    [h("div", { cls: "rcpt__body" }, items)],
  );

  // The paper is the ledger: if these ever diverge, the ledger is missing a post.
  if (import.meta.env.DEV) {
    const drift = Math.abs(stats.cashOpen + ledgerNet(stats) - state.cash);
    if (drift > 0.005) {
      console.error(
        `[receipt] ledger off by ${drift.toFixed(2)}: open ${stats.cashOpen} + net ${ledgerNet(stats)} ≠ ${state.cash}`,
      );
    }
  }

  return { sheet, items };
}

/** An unvisited branch's resolved-summary sheet (§19/§24 daySummary). */
function buildBranchSheet(sim: Sim, store: StoreState): SheetRefs {
  const state = sim.snapshot;
  const summary = store.daySummary;
  const { items, item, line, rule, section } = sheetBuilder();

  item(h("div", { cls: "rcpt__store", text: storeName(state, store).toUpperCase() }));
  item(h("div", { cls: "rcpt__meta", text: `day ${state.day} · ${seasonForDay(state.day)}` }));
  item(h("div", { cls: "rcpt__meta", text: "resolved while you were away" }));
  rule();

  const note = (text: string, rose = false): HTMLElement =>
    item(h("p", { cls: rose ? "rcpt__note rcpt__note--rose" : "rcpt__note", text }));

  if (summary === null || summary.day !== state.day) {
    // Should not happen — the close writes every branch's summary — but a
    // hand-edited save must read as a quiet page, not a crash.
    note("No report came in from this branch today.");
  } else if (summary.underRenovation) {
    note("Scaffolding day — the crew had the floor. Reopens tomorrow, a generation newer.");
  } else {
    const manager = store.staff.find((m) => m.role === "manager");
    section("the day");
    line("Asked for", String(summary.demand));
    line(
      "Served",
      String(summary.served),
      summary.served < summary.demand ? "rcpt__line--rose" : "",
    );
    // The stored capacity bounds the Rx stream only — OTC serves against
    // the larger checkout budget, so "Crew capacity ≈0 · Served 37" would
    // contradict itself on an ordinary cashier-only roster.
    line("Rx capacity", `≈${Math.round(summary.capacity)}`);
    line("Scripts filled", String(summary.rxFills));
    line("Front-store units", String(summary.otcUnits));
    if (summary.stockOuts > 0) {
      line("Lost to empty shelves", String(summary.stockOuts), "rcpt__line--rose");
    }
    rule();
    section("register");
    line("Branch takings", money(summary.revenue), "rcpt__line--total");
    if (summary.incidents > 0) {
      line("Dispensing errors — refunded", `×${summary.incidents}`, "rcpt__line--rose");
    }
    rule();
    section("the crew");
    if (manager) note(`${manager.name} ran the day.`);
    else note("No manager — the day ran at 60%.", true);
    if (summary.otcOnly) {
      note(
        summary.hadPharmacist
          ? "No tech on the fill bench — OTC only."
          : "No pharmacist on staff — OTC only.",
        true,
      );
    }
    if (store.staff.length === 0) note("Nobody on the roster. The lights were on, that's all.", true);
    rule();
    line(
      "Local reputation",
      `${signed(summary.repDelta, 2)} → ${store.repStars.toFixed(2)} ★`,
      summary.repDelta < 0 ? "rcpt__line--rose" : "",
    );
  }

  item(h("div", { cls: "rcpt__meta rcpt__foot", text: "manager's report — filed at close" }));

  const sheet = h(
    "div",
    { cls: "rcpt", attrs: { role: "status", "aria-label": `${storeName(state, store)} branch report` } },
    [h("div", { cls: "rcpt__body" }, items)],
  );
  return { sheet, items };
}

export function buildReceipt(
  sim: Sim,
  onNextDay: () => void,
  onStamp?: () => void,
): HTMLElement {
  const state = sim.snapshot;
  const active = activeStore(state);

  const pages: { store: StoreState; refs: SheetRefs }[] = state.stores.map((store) => ({
    store,
    refs: store.id === active.id ? buildVisitedSheet(sim) : buildBranchSheet(sim, store),
  }));

  const nextButton = PillButton("Next day", onNextDay);
  const nextWrap = h("div", { cls: "rcpt__next rcpt__item" }, [nextButton]);

  // §28 branch tabs — only once there is more than one sheet to pick up.
  let tabsRow: HTMLElement | null = null;
  const tabButtons = new Map<string, HTMLButtonElement>();
  if (pages.length > 1) {
    tabsRow = h("div", { cls: "rcpt-tabs", attrs: { role: "tablist" } });
    for (const page of pages) {
      const flag =
        page.store.id !== active.id &&
        page.store.daySummary !== null &&
        !page.store.daySummary.underRenovation &&
        (page.store.daySummary.stockOuts > 0 ||
          page.store.daySummary.incidents > 0 ||
          page.store.daySummary.served < page.store.daySummary.demand);
      const tab = h(
        "button",
        {
          cls: "rcpt-tabs__tab",
          attrs: { type: "button", role: "tab", "aria-selected": "false" },
        },
        [
          districtById(page.store.districtId).name,
          ...(flag ? [h("span", { cls: "rcpt-tabs__flag", text: "●" })] : []),
        ],
      );
      tab.addEventListener("pointerdown", (e) => e.preventDefault());
      tab.addEventListener("click", () => showPage(page.store.id));
      tabButtons.set(page.store.id, tab);
      tabsRow.append(tab);
    }
  }

  function showPage(storeId: string): void {
    for (const page of pages) {
      page.refs.sheet.hidden = page.store.id !== storeId;
    }
    for (const [id, tab] of tabButtons) {
      const on = id === storeId;
      tab.classList.toggle("rcpt-tabs__tab--active", on);
      tab.setAttribute("aria-selected", String(on));
    }
  }
  showPage(active.id);

  const root = h("div", { cls: "rcpt-stage" }, [
    ...(tabsRow ? [tabsRow] : []),
    ...pages.map((page) => page.refs.sheet),
    nextWrap,
  ]);

  // --- Print sequence: the visited sheet prints; branch pages arrive
  //     already filed (their drama happened off-screen). ---
  const activeItems = pages.find((page) => page.store.id === active.id)!.refs.items;
  for (const page of pages) {
    if (page.store.id === active.id) continue;
    for (const el of page.refs.items) el.classList.add("rcpt__item--on");
  }
  const all = [...activeItems, nextWrap];
  const timers: number[] = [];
  // The stamp's thunk (§29) fires the moment the verdict lands — at its slot
  // in the stagger, or right away when the print collapses (skip, reduced
  // motion). Once per printing, however the paper got to done.
  const stampIndex = all.findIndex((el) => el.classList.contains("rcpt__stamp"));
  let stamped = false;
  const stampNow = (): void => {
    if (stamped || stampIndex === -1) return;
    stamped = true;
    onStamp?.();
  };
  const finish = (): void => {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    for (const el of all) el.classList.add("rcpt__item--on");
    stampNow();
  };
  // Reduced motion comes from the OS or the settings toggle (§23); either way
  // the print collapses to instant. Flipping the toggle mid-print is handled
  // in CSS, so a receipt already on screen snaps to done.
  const instant =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    state.settings.reducedMotion;
  if (instant) {
    finish();
  } else {
    const step = PRINT_MS / all.length;
    all.forEach((el, i) => {
      timers.push(
        window.setTimeout(() => {
          el.classList.add("rcpt__item--on");
          if (i === stampIndex) stampNow();
        }, step * (i + 1)),
      );
    });
    for (const page of pages) page.refs.sheet.addEventListener("click", finish);
  }

  return root;
}
