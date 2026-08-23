// Renovate panel (SPEC §13, §28): the shopfitters' proposal folder. The four
// generations run down one lineage rail, oldest first — each a proposal card
// led by its paint chips (the exact colors render/eras.ts will dress the
// store in, so the card is an honest preview). Built tiers carry a rubber
// stamp; the next tier carries the buy pill and the closes-today warning in
// the receipt's plain voice; later tiers wait their turn.

import type { EventBus } from "../../core/bus";
import type { SimEvent } from "../../sim/events";
import { ERA_DEFS, renovationLock, type EraDef } from "../../sim/renovation";
import type { Sim } from "../../sim/sim";
import { eraSwatches } from "../../render/eras";
import { Panel } from "../components/Panel";
import { h } from "../dom";
import { money } from "../format";

export interface RenovatePanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

export function createRenovatePanel(sim: Sim, bus: EventBus<SimEvent>): RenovatePanelHandle {
  let visible = false;
  let pending = false;

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

  function chipStrip(era: number): HTMLElement {
    const strip = h("div", { cls: "reno__chips", attrs: { "aria-hidden": "true" } });
    for (const hex of eraSwatches(era)) {
      const chip = h("span", { cls: "reno__chip" });
      chip.style.background = hex;
      strip.append(chip);
    }
    return strip;
  }

  function buildCard(def: EraDef): HTMLElement {
    const state = sim.snapshot;
    const status: "built" | "current" | "pending" | "next" | "later" =
      def.era === state.pendingEra
        ? "pending"
        : def.era <= state.era
          ? def.era === state.era
            ? "current"
            : "built"
          : def.era === state.era + 1 && state.pendingEra === null
            ? "next"
            : "later";

    const body: HTMLElement[] = [
      h("div", { cls: "reno__cardtop" }, [
        h("span", { cls: "reno__gen", text: `Gen ${def.era}` }),
        h("h3", { cls: "reno__name", text: def.name }),
      ]),
      chipStrip(def.era),
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
      body.push(
        h("div", { cls: "reno__foot reno__foot--buy" }, [
          buy,
          h("p", {
            cls: "reno__note",
            text:
              lock ??
              "Closes the store for the rest of today. Reopens tomorrow, a generation newer.",
          }),
        ]),
      );
    } else {
      body.push(h("p", { cls: "reno__note reno__note--far", text: `After Gen ${def.era - 1}.` }));
    }

    return h("article", { cls: `reno__card reno__card--${status}` }, [
      h("span", { cls: `reno__dot reno__dot--${status}`, attrs: { "aria-hidden": "true" } }),
      h("div", { cls: "reno__paper" }, body),
    ]);
  }

  function refresh(): void {
    list.replaceChildren(...ERA_DEFS.map(buildCard));
  }

  /** Coalesce cash-tick churn into one repaint per frame (licenses style). */
  function invalidate(): void {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (visible) refresh();
    });
  }

  bus.on("cash.changed", invalidate);
  bus.on("day.phaseChanged", invalidate);
  bus.on("era.renovationStarted", invalidate);
  bus.on("era.changed", invalidate);

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
