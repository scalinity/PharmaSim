// Renovate panel (SPEC §13, §28): the shopfitters' proposal folder. The four
// generations run down one lineage rail, oldest first — each a proposal card
// led by its paint chips (the exact colors data/eras.ts will dress the
// store in, so the card is an honest preview). Built tiers carry a rubber
// stamp; the next tier carries the buy pill and the closes-today warning in
// the receipt's plain voice; later tiers wait their turn.

import type { EventBus } from "../../core/bus";
import {
  FORECAST_COST,
  forecastLock,
  hasVerifyAssist,
  VERIFY_ASSIST_COST,
  verifyAssistLock,
  verifyAssistOfflineReason,
} from "../../sim/aitech";
import type { SimEvent } from "../../sim/events";
import { ERA_DEFS, renovationLock, type EraDef } from "../../sim/renovation";
import type { Sim } from "../../sim/sim";
import { activeStore, storeName } from "../../sim/state";
import { ChipStrip } from "../components/ChipStrip";
import { Panel } from "../components/Panel";
import { h } from "../dom";
import { money } from "../format";

export interface RenovatePanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

/** The closes-today warning under the buy pill (§13, §28 copy voice). */
const BUY_NOTE =
  "Closes the store for the rest of today. Reopens tomorrow, a generation newer.";

/** The §21 module cards' ready-to-buy notes — no closure, unlike the tiers. */
const ASSIST_READY_NOTE = "Installs today — the store stays open.";
const FORECAST_READY_NOTE = "Live in Orders the moment it's licensed.";

export function createRenovatePanel(sim: Sim, bus: EventBus<SimEvent>): RenovatePanelHandle {
  let visible = false;
  let pending: "none" | "live" | "full" = "none";
  /** Live bits of the "next" card, updated in place on cash ticks so the
   *  buy button stays the same node under a pointer mid-click. */
  let buyButton: HTMLButtonElement | null = null;
  let buyNote: HTMLElement | null = null;
  /** The §21 module cards' live bits — same cached-ref rule as above. */
  let assistButton: HTMLButtonElement | null = null;
  let assistNote: HTMLElement | null = null;
  let forecastButton: HTMLButtonElement | null = null;
  let forecastNote: HTMLElement | null = null;

  const list = h("div", { cls: "reno__list" });
  const modules = h("div", { cls: "reno__modules" });

  const sheet = Panel({ cls: "renop" }, [
    h("div", { cls: "reno__head" }, [
      h("p", { cls: "reno__eyebrow", text: "Shopfitters' proposals · four generations" }),
      h("h2", { cls: "panel__title", text: "Renovate" }),
    ]),
    list,
  ]);

  const root = h("section", { cls: "reno", attrs: { "aria-label": "Renovate" } }, [sheet]);
  root.hidden = true;

  function buildCard(def: EraDef): HTMLElement {
    const state = sim.snapshot;
    // The proposals describe the store you're standing in (§13/§19).
    const store = activeStore(state);
    const status: "built" | "current" | "pending" | "next" | "later" =
      def.era === store.pendingEra
        ? "pending"
        : def.era <= store.era
          ? def.era === store.era
            ? "current"
            : "built"
          : def.era === store.era + 1 && store.pendingEra === null
            ? "next"
            : "later";

    const body: HTMLElement[] = [
      h("div", { cls: "reno__cardtop" }, [
        h("span", { cls: "reno__gen", text: `Gen ${def.era}` }),
        h("h3", { cls: "reno__name", text: def.name }),
      ]),
      ChipStrip(def.era, status !== "later"),
      h("p", { cls: "reno__look", text: def.look }),
    ];
    if (def.gates) body.push(h("p", { cls: "reno__gates", text: def.gates }));

    if (status === "built" || status === "current") {
      const day = state.stats[`era.${def.era}`] ?? 1;
      const foot = h("div", { cls: "reno__foot" }, [
        h("span", {
          cls: "reno__stamp",
          text: def.era === 1 ? "Founded · day 1" : `Raised · day ${day}`,
        }),
      ]);
      if (status === "current") {
        foot.append(h("span", { cls: "reno__today", text: "the store today" }));
      }
      body.push(foot);
    } else if (status === "pending") {
      body.push(
        h("p", {
          cls: "reno__note",
          text: "Under scaffolding — the crew has the floor. Opens tomorrow morning.",
        }),
      );
    } else if (status === "next") {
      const lock = renovationLock(state);
      const buy = h("button", {
        cls: "pill pill--primary pill--small reno__buy",
        text: `Renovate for ${money(def.cost)}`,
        attrs: { type: "button" },
      });
      buy.disabled = lock !== null;
      buy.addEventListener("pointerdown", (e) => e.preventDefault());
      buy.addEventListener("click", () => sim.dispatch({ type: "era.renovate" }));
      const note = h("p", { cls: "reno__note", text: lock ?? BUY_NOTE });
      buyButton = buy;
      buyNote = note;
      body.push(h("div", { cls: "reno__foot reno__foot--buy" }, [buy, note]));
    } else {
      body.push(h("p", { cls: "reno__note reno__note--far", text: `After Gen ${def.era - 1}.` }));
    }

    return h("article", { cls: `reno__card reno__card--${status}` }, [
      h("span", { cls: `reno__dot reno__dot--${status}`, attrs: { "aria-hidden": "true" } }),
      h("div", { cls: "reno__paper" }, body),
    ]);
  }

  /** One §21 module card: title, what it does, and a stamp, a status
   *  line, or the buy pill — the same folder the generations live in. */
  function buildModuleCard(options: {
    title: string;
    scopeLine: string;
    capability: string;
    ownedDay: number | null;
    offlineReason: string | null;
    ownedNote: string;
    readyNote: string;
    lock: string | null;
    buyLabel: string;
    onBuy: () => void;
    bind: (buy: HTMLButtonElement, note: HTMLElement) => void;
  }): HTMLElement {
    const body: HTMLElement[] = [
      h("div", { cls: "reno__cardtop" }, [
        h("span", { cls: "reno__gen", text: "AI" }),
        h("h3", { cls: "reno__name", text: options.title }),
      ]),
      h("p", { cls: "aimod__scope", text: options.scopeLine }),
      h("p", { cls: "reno__look", text: options.capability }),
    ];
    if (options.ownedDay !== null) {
      const foot = h("div", { cls: "reno__foot" }, [
        h("span", { cls: "reno__stamp", text: `Installed · day ${options.ownedDay}` }),
      ]);
      body.push(foot);
      body.push(
        options.offlineReason !== null
          ? h("p", { cls: "reno__note aimod__offline", text: `Offline — ${options.offlineReason.toLowerCase()}.` })
          : h("p", { cls: "reno__note", text: options.ownedNote }),
      );
    } else {
      const buy = h("button", {
        cls: "pill pill--primary pill--small reno__buy",
        text: options.buyLabel,
        attrs: { type: "button" },
      });
      buy.disabled = options.lock !== null;
      buy.addEventListener("pointerdown", (e) => e.preventDefault());
      buy.addEventListener("click", options.onBuy);
      const note = h("p", { cls: "reno__note", text: options.lock ?? options.readyNote });
      options.bind(buy, note);
      body.push(h("div", { cls: "reno__foot reno__foot--buy" }, [buy, note]));
    }
    const owned = options.ownedDay !== null;
    return h("article", { cls: `reno__card aimod reno__card--${owned ? "current" : "next"}` }, [
      h("span", {
        cls: `reno__dot reno__dot--${owned ? "current" : "next"}`,
        attrs: { "aria-hidden": "true" },
      }),
      h("div", { cls: "reno__paper" }, body),
    ]);
  }

  /** The §21 Gen 4 modules under the lineage — the tier's own gates row
   *  already promises them; these are the two purchases it meant. */
  function buildModules(): void {
    const state = sim.snapshot;
    const store = activeStore(state);
    const owned = hasVerifyAssist(state, store.id);
    modules.replaceChildren(
      h("p", { cls: "reno__eyebrow aimod__eyebrow", text: "Gen 4 modules · AI" }),
      buildModuleCard({
        title: "AI verification assistant",
        scopeLine:
          state.stores.length > 1
            ? `Per store — this one is ${storeName(state, store)}.`
            : "Per store.",
        capability:
          "Auto-verifies Tier-1/2 scripts on the spot and catches every fill error. " +
          "Tier 3 and the cold chain still see the pharmacist — whose day turns to counsel and shots.",
        ownedDay: owned ? (state.stats[`aitech.verify.${store.id}`] ?? null) : null,
        offlineReason: verifyAssistOfflineReason(state, store),
        ownedNote: "Watching the verify desk — Tier-1/2 scripts skip the pharmacist.",
        readyNote: ASSIST_READY_NOTE,
        lock: owned ? null : verifyAssistLock(state, store),
        buyLabel: `Install for ${money(VERIFY_ASSIST_COST)}`,
        onBuy: () => sim.dispatch({ type: "aitech.buyVerifyAssist", storeId: store.id }),
        bind: (buy, note) => {
          assistButton = buy;
          assistNote = note;
        },
      }),
      buildModuleCard({
        title: "AI demand forecasting",
        scopeLine: "Account-wide — every store and the depot order from it.",
        capability:
          "Orders gains a 7-day per-SKU forecast read from the city's own demand — " +
          "trend arrows, a ±10% confidence band, and one-click drafting to it.",
        ownedDay: state.aitech.forecast ? (state.stats["aitech.forecast"] ?? null) : null,
        offlineReason: null,
        ownedNote: "Feeding the Orders panel's forecast view.",
        readyNote: FORECAST_READY_NOTE,
        lock: state.aitech.forecast ? null : forecastLock(state),
        buyLabel: `License for ${money(FORECAST_COST)}`,
        onBuy: () => sim.dispatch({ type: "aitech.buyForecast" }),
        bind: (buy, note) => {
          forecastButton = buy;
          forecastNote = note;
        },
      }),
    );
  }

  /** Full rebuild — statuses moved (a purchase, a new morning, a new era). */
  function refresh(): void {
    buyButton = null;
    buyNote = null;
    assistButton = null;
    assistNote = null;
    forecastButton = null;
    forecastNote = null;
    // The modules ride inside the same scroll as the lineage (§21: they
    // are what the Gen 4 card's gates row promises).
    list.replaceChildren(...ERA_DEFS.map(buildCard), modules);
    buildModules();
  }

  /** Cash tick: only the lock lines and the pills' disabled states can have
   *  changed — written through cached refs (licenses style, §30) so no
   *  button is ever detached between a pointerdown and its click. */
  function refreshLive(): void {
    if (buyButton !== null && buyNote !== null) {
      const lock = renovationLock(sim.snapshot);
      buyButton.disabled = lock !== null;
      const text = lock ?? BUY_NOTE;
      if (buyNote.textContent !== text) buyNote.textContent = text;
    }
    if (assistButton !== null && assistNote !== null) {
      const lock = verifyAssistLock(sim.snapshot, activeStore(sim.snapshot));
      assistButton.disabled = lock !== null;
      const text = lock ?? ASSIST_READY_NOTE;
      if (assistNote.textContent !== text) assistNote.textContent = text;
    }
    if (forecastButton !== null && forecastNote !== null) {
      const lock = forecastLock(sim.snapshot);
      forecastButton.disabled = lock !== null;
      const text = lock ?? FORECAST_READY_NOTE;
      if (forecastNote.textContent !== text) forecastNote.textContent = text;
    }
  }

  /** Coalesce event churn into one repaint per frame; a full rebuild
   *  request outranks a live one within the same frame. */
  function invalidate(kind: "live" | "full"): void {
    if (!visible) return;
    if (pending === "none") {
      requestAnimationFrame(() => {
        const run = pending;
        pending = "none";
        if (!visible) return;
        if (run === "full") refresh();
        else if (run === "live") refreshLive();
      });
    }
    if (pending !== "full") pending = kind;
  }

  bus.on("cash.changed", () => invalidate("live"));
  bus.on("day.phaseChanged", () => invalidate("full"));
  bus.on("era.renovationStarted", () => invalidate("full"));
  bus.on("era.changed", () => invalidate("full"));
  // §19: the proposals follow the store you're standing in.
  bus.on("branch.activeChanged", () => invalidate("full"));
  // §21: the module cards move on their own purchases, and their desk gate
  // moves with the floor (a placed or sold verify desk).
  bus.on("aitech.verifyAssistBought", () => invalidate("full"));
  bus.on("aitech.forecastBought", () => invalidate("full"));
  bus.on("furniture.placed", () => invalidate("full"));
  bus.on("furniture.sold", () => invalidate("full"));

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
