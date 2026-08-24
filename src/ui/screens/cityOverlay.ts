// City overlay (SPEC §17, §28): the DOM layer over the city map — six paper
// street tags pinned to the glass, a quiet hint line, and the neighborhood
// card that settles into the right rail when a district is under the
// pointer. The card reads only what the store has *seen* (sim/city.ts
// observed memory): knowledge builds by playing, never from the generator.

import type { EventBus } from "../../core/bus";
import { DISTRICTS, districtById, type FacilityKind } from "../../data/districts";
import { observedWindow, OTC_TALLY_KEY, shareTrend } from "../../sim/city";
import { categoryLabel, STORE_DISTRICT_ID } from "../../sim/economy";
import type { SimEvent } from "../../sim/events";
import type { Sim } from "../../sim/sim";
import { h } from "../dom";

/** §17 skew column, said the way the pharmacist behind the counter would. */
const CHARACTER: Record<string, string> = {
  oldTown: "Older and settled — blood-pressure refills keep the counter busy.",
  riverside: "Young families — pediatric scripts, and allergy season hits hard.",
  universityHeights: "Students — acute bugs, urgent-care scripts, exam-week nerves.",
  sunsetGlen: "Retirees — chronic hearts, diabetes and blood thinners on repeat.",
  medicalDistrict: "Hospital discharges — specialty and post-op scripts walk out daily.",
  downtown: "Working adults — heavy front-store trade, stress and stomach trouble.",
};

const FACILITY_LABELS: Record<FacilityKind, string> = {
  clinic: "Small clinic",
  hospital: "Hospital + specialists",
  nursingHome: "Nursing home — refills batch up on Mondays",
  urgentCare: "Campus urgent care",
  pediatricOffice: "Pediatric office",
  walkInClinic: "Walk-in clinic",
};

/** Top observed categories shown on the card before the list gets noisy. */
const MIX_LINES = 5;

export interface CityOverlayHandle {
  root: HTMLElement;
  setActive(on: boolean): void;
  /** District under the pointer (render-side pick), or null. */
  hoverDistrict(id: string | null): void;
  /** Screen-space anchor for one district's street tag (per frame). */
  updateLabel(id: string, screenX: number, screenY: number): void;
}

export function createCityOverlay(sim: Sim, bus: EventBus<SimEvent>): CityOverlayHandle {
  const tags = new Map<string, HTMLElement>();
  const tagHost = h("div", { cls: "cityui__tags", attrs: { "aria-hidden": "true" } });
  for (const district of DISTRICTS) {
    const tag = h("div", { cls: "cityui__tag" }, [
      ...(district.id === STORE_DISTRICT_ID
        ? [h("span", { cls: "cityui__tagcross", text: "✚" })]
        : []),
      district.name,
    ]);
    tags.set(district.id, tag);
    tagHost.append(tag);
  }

  const hint = h("p", {
    cls: "cityui__hint",
    text: "Hover a district to read it · C returns to the store",
  });

  const card = h("aside", { cls: "cityui__card", attrs: { "aria-label": "District card" } });
  card.hidden = true;
  let cardId: string | null = null;

  const root = h("div", { cls: "cityui" }, [tagHost, hint, card]);
  root.hidden = true;

  /** The share trend line for the store's own district (§17 trend arrow). */
  function shareLine(): HTMLElement[] {
    const trend = shareTrend(sim.snapshot);
    if (trend.current === null) {
      return [
        h("p", {
          cls: "cityui__sharenote",
          text: "No routed days on record yet — play a day and the share appears.",
        }),
      ];
    }
    const pct = (trend.current * 100).toFixed(1);
    let arrow = "";
    let cls = "cityui__arrow";
    if (trend.prior !== null && trend.prior > 0) {
      const ratio = trend.current / trend.prior;
      if (ratio > 1.03) {
        arrow = "↑";
        cls += " cityui__arrow--up";
      } else if (ratio < 0.97) {
        arrow = "↓";
        cls += " cityui__arrow--down";
      } else {
        arrow = "→";
      }
    }
    return [
      h("p", { cls: "cityui__share" }, [
        h("span", { cls: "cityui__sharenum", text: `≈${pct}%` }),
        ...(arrow ? [h("span", { cls, text: arrow })] : []),
        h("span", { cls: "cityui__sharecap", text: "of the city's demand routes here" }),
      ]),
      ...(trend.prior !== null
        ? [
            h("p", {
              cls: "cityui__sharenote",
              text: `Last week ≈${(trend.prior * 100).toFixed(1)}%`,
            }),
          ]
        : [h("p", { cls: "cityui__sharenote", text: "First week — no trend yet" })]),
    ];
  }

  function buildCard(id: string): void {
    const district = districtById(id);
    const state = sim.snapshot;
    const seen = observedWindow(state, id, 28);
    const rxLines = seen.lines.filter((l) => l.key !== OTC_TALLY_KEY && l.asked > 0);
    const otcLine = seen.lines.find((l) => l.key === OTC_TALLY_KEY);
    const maxAsked = rxLines.reduce((max, l) => Math.max(max, l.asked), 0);

    const mix: HTMLElement[] = [];
    for (const line of rxLines.slice(0, MIX_LINES)) {
      const bar = h("span", { cls: "cityui__bar" });
      bar.style.width = `${Math.max(8, (line.asked / maxAsked) * 100).toFixed(0)}%`;
      mix.push(
        h("div", { cls: "cityui__mixrow" }, [
          h("span", { cls: "cityui__mixname", text: categoryLabel(line.key) }),
          h("span", { cls: "cityui__barwrap" }, [bar]),
          h("span", { cls: "cityui__mixnum", text: String(line.asked) }),
        ]),
      );
    }
    if (otcLine && otcLine.asked > 0) {
      mix.push(
        h("p", {
          cls: "cityui__otcline",
          text: `Front-store visits · ${otcLine.asked} in 28 days`,
        }),
      );
    }
    if (mix.length === 0) {
      mix.push(
        h("p", {
          cls: "cityui__empty",
          text: "Nothing seen from here yet. Demand shows up as it walks through your door.",
        }),
      );
    }

    card.replaceChildren(
      h("div", { cls: "cityui__tab" }, [
        h("span", { cls: "cityui__tabname", text: district.name }),
      ]),
      h("div", { cls: "cityui__body" }, [
        h("p", { cls: "cityui__eyebrow", text: "neighborhood file" }),
        h("p", { cls: "cityui__facts" }, [
          h("span", { text: `pop ${district.population.toLocaleString("en-US")}` }),
          h("span", { cls: "cityui__dot", text: "·" }),
          h("span", { text: `rent $${district.dailyRent}/day` }),
        ]),
        h("p", { cls: "cityui__character", text: CHARACTER[id] ?? "" }),
        h("ul", { cls: "cityui__facilities" }, [
          ...district.facilities.map((f) =>
            h("li", { cls: "cityui__facility", text: FACILITY_LABELS[f.kind] }),
          ),
        ]),
        h("p", { cls: "cityui__mixhead", text: "Scripts seen · 28 days" }),
        ...mix,
        ...(id === STORE_DISTRICT_ID
          ? [h("p", { cls: "cityui__storehead" }, [
              h("span", { cls: "cityui__tagcross", text: "✚" }),
              "Your pharmacy",
            ]), ...shareLine()]
          : []),
      ]),
    );
  }

  // A card held under the pointer keeps pace with the shift behind it —
  // the same coalesced repaint the dock sheets use, live only while a
  // district is actually up.
  let pending = false;
  function invalidate(): void {
    if (root.hidden || card.hidden || cardId === null || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!root.hidden && !card.hidden && cardId !== null) buildCard(cardId);
    });
  }
  bus.on("customer.spawned", invalidate);
  bus.on("rx.pickedUp", invalidate);
  bus.on("sale.completed", invalidate);
  bus.on("day.phaseChanged", invalidate);

  return {
    root,
    setActive(on) {
      root.hidden = !on;
      if (!on) {
        card.hidden = true;
        cardId = null;
      }
    },
    hoverDistrict(id) {
      if (id === cardId) return;
      cardId = id;
      for (const [tagId, tag] of tags) {
        tag.classList.toggle("cityui__tag--hot", tagId === id);
      }
      if (id === null) {
        card.hidden = true;
        return;
      }
      buildCard(id);
      card.hidden = false;
    },
    updateLabel(id, screenX, screenY) {
      const tag = tags.get(id);
      if (tag) {
        tag.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) translate(-50%, -50%)`;
      }
    },
  };
}
