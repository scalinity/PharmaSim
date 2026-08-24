// Renovate panel (SPEC §13, §28): the shopfitters' proposal folder. The four
// generations run down one lineage rail, oldest first — each a proposal card
// led by its paint chips (the exact colors data/eras.ts will dress the
// store in, so the card is an honest preview). Built tiers carry a rubber
// stamp; the next tier carries the buy pill and the closes-today warning in
// the receipt's plain voice; later tiers wait their turn.

import type { EventBus } from "../../core/bus";
import type { SimEvent } from "../../sim/events";
import { ERA_DEFS, renovationLock, type EraDef } from "../../sim/renovation";
import type { Sim } from "../../sim/sim";
import { activeStore } from "../../sim/state";
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

export function createRenovatePanel(sim: Sim, bus: EventBus<SimEvent>): RenovatePanelHandle {
  let visible = false;
  let pending: "none" | "live" | "full" = "none";
  /** Live bits of the "next" card, updated in place on cash ticks so the
   *  buy button stays the same node under a pointer mid-click. */
  let buyButton: HTMLButtonElement | null = null;
  let buyNote: HTMLElement | null = null;

  const list = h("div", { cls: "reno__list" });

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

  /** Full rebuild — statuses moved (a purchase, a new morning, a new era). */
  function refresh(): void {
    buyButton = null;
    buyNote = null;
    list.replaceChildren(...ERA_DEFS.map(buildCard));
  }

  /** Cash tick: only the lock line and the pill's disabled state can have
   *  changed — written through cached refs (licenses style, §30) so the
   *  button is never detached between a pointerdown and its click. */
  function refreshLive(): void {
    if (buyButton === null || buyNote === null) return;
    const lock = renovationLock(sim.snapshot);
    buyButton.disabled = lock !== null;
    const text = lock ?? BUY_NOTE;
    if (buyNote.textContent !== text) buyNote.textContent = text;
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

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
