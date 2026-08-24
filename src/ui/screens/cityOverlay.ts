// City overlay (SPEC §17, §19, §28): the DOM layer over the city map — six
// paper street tags pinned to the glass, pine tags over the player's own
// stores, a quiet hint line, and the neighborhood card that settles into
// the right rail when a district is under the pointer. The card reads only
// what the store has *seen* (sim/city.ts observed memory): knowledge builds
// by playing, never from the generator.
//
// Multi-branch (M14): the card is where lots are bought and mornings choose
// their store. A district with an empty lot carries the deed — a dashed
// for-sale slip with the §26 price math itemized and the same checklist
// voice as a license application; a district with a player store carries
// its branch block, with the morning's "run today here" hand-off.

import type { EventBus } from "../../core/bus";
import { COMPETITOR_DEFS, competitorDef } from "../../data/competitors";
import { DISTRICTS, districtById, type FacilityKind } from "../../data/districts";
import {
  districtShares,
  observedWindow,
  OTC_TALLY_KEY,
  shareTrend,
} from "../../sim/city";
import { branchPrice, categoryLabel } from "../../sim/economy";
import type { SimEvent } from "../../sim/events";
import { ownsLicense } from "../../sim/licenses";
import type { Sim } from "../../sim/sim";
import { isFoundingStore, storeName, type StoreState } from "../../sim/state";
import { h } from "../dom";
import { money } from "../format";

function accentCss(accent: number): string {
  return `#${accent.toString(16).padStart(6, "0")}`;
}

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
  /** Screen-space anchor for a district's street tag, a rival's shop tag,
   *  or a player branch's pine tag (`branch:<storeId>`), per frame. */
  updateLabel(id: string, screenX: number, screenY: number): void;
}

export function createCityOverlay(sim: Sim, bus: EventBus<SimEvent>): CityOverlayHandle {
  const tags = new Map<string, HTMLElement>();
  const tagHost = h("div", { cls: "cityui__tags", attrs: { "aria-hidden": "true" } });
  for (const district of DISTRICTS) {
    const tag = h("div", { cls: "cityui__tag", text: district.name });
    tags.set(district.id, tag);
    tagHost.append(tag);
  }

  // §18: the rivals' shop tags — name and live star rating, in their §27
  // accent, pinned to their markers the way street tags pin to plates.
  const rivalStars = new Map<string, HTMLElement>();
  for (const def of COMPETITOR_DEFS) {
    const dot = h("span", { cls: "cityui__rivaldot" });
    dot.style.background = accentCss(def.accent);
    const stars = h("span", { cls: "cityui__rivalstars" });
    const tag = h("div", { cls: "cityui__tag cityui__tag--rival" }, [dot, def.name, stars]);
    tags.set(def.id, tag);
    rivalStars.set(def.id, stars);
    tagHost.append(tag);
  }
  function refreshRivalStars(): void {
    for (const rival of sim.snapshot.competitors) {
      const stars = rivalStars.get(rival.id);
      if (stars) stars.textContent = `${rival.repStars.toFixed(1)}★`;
    }
  }
  refreshRivalStars();
  bus.on("competitor.drift", refreshRivalStars);

  // §19: a pine shop tag per player store, keyed `branch:<storeId>` so the
  // frame loop can pin it over the marker cross. Rebuilt when the network
  // grows or a store's local rep moves.
  const branchStars = new Map<string, HTMLElement>();
  const branchNames = new Map<string, HTMLElement>();
  function refreshBranchTags(): void {
    const state = sim.snapshot;
    for (const store of state.stores) {
      const key = `branch:${store.id}`;
      let tag = tags.get(key);
      if (!tag) {
        const name = h("span", {});
        const stars = h("span", { cls: "cityui__rivalstars" });
        tag = h("div", { cls: "cityui__tag cityui__tag--mine" }, [
          h("span", { cls: "cityui__tagcross", text: "✚" }),
          name,
          stars,
        ]);
        tags.set(key, tag);
        branchNames.set(key, name);
        branchStars.set(key, stars);
        tagHost.append(tag);
      }
      // Re-written per refresh: a second store in the district ordinal-izes
      // every sibling's label, the founding tag included.
      const name = branchNames.get(key);
      if (name) name.textContent = storeName(state, store);
      const stars = branchStars.get(key);
      if (stars) stars.textContent = `${store.repStars.toFixed(1)}★`;
    }
  }
  refreshBranchTags();
  bus.on("branch.bought", refreshBranchTags);
  bus.on("rep.changed", refreshBranchTags);

  const hint = h("p", {
    cls: "cityui__hint",
    text: "Hover a district to read it · C returns to the store",
  });

  const card = h("aside", { cls: "cityui__card", attrs: { "aria-label": "District card" } });
  card.hidden = true;
  let cardId: string | null = null;

  const root = h("div", { cls: "cityui" }, [tagHost, hint, card]);
  root.hidden = true;

  /** The network's routed-share trend (§17 trend arrow). */
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
        h("span", { cls: "cityui__sharecap", text: "of the city's demand routes to you" }),
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

  /** §18: every pharmacy's share of this district, largest first — the
   *  same live A²/ΣA² the routing runs on, so a rep move or a shortage's
   *  reliability hit reads here the day it lands. Every player store is
   *  its own row (§19). */
  function pharmacyRows(id: string): HTMLElement[] {
    const state = sim.snapshot;
    const all = districtShares(state, id);
    const entries = [
      ...all.stores.map((entry) => ({ entry, store: state.stores.find((s) => s.id === entry.pharmacyId) ?? null })),
      ...all.rivals.map((entry) => ({ entry, store: null as StoreState | null })),
    ].sort((a, b) => b.entry.share - a.entry.share);
    const rows: HTMLElement[] = [
      h("p", { cls: "cityui__mixhead", text: "Pharmacies · share of demand" }),
    ];
    for (const { entry, store } of entries) {
      const def = store ? null : competitorDef(entry.pharmacyId);
      const rival = store ? null : state.competitors.find((c) => c.id === entry.pharmacyId);
      const bar = h("span", { cls: "cityui__bar" });
      bar.style.width = `${Math.max(2, entry.share * 100).toFixed(0)}%`;
      bar.style.background = def ? accentCss(def.accent) : "";
      const stars = store ? store.repStars : (rival?.repStars ?? 0);
      rows.push(
        h("div", { cls: store ? "cityui__pharmrow cityui__pharmrow--mine" : "cityui__pharmrow" }, [
          h("span", { cls: "cityui__pharmname", text: store ? storeName(state, store) : def!.name }),
          h("span", { cls: "cityui__pharmstars", text: `${stars.toFixed(1)}★` }),
          h("span", { cls: "cityui__barwrap" }, [bar]),
          h("span", { cls: "cityui__pharmpct", text: `${(entry.share * 100).toFixed(0)}%` }),
        ]),
      );
    }
    return rows;
  }

  /** §19 branch block: the player's store in this district, and — in the
   *  morning — the hand-off that makes it today's floor. */
  function branchBlock(store: StoreState): HTMLElement[] {
    const state = sim.snapshot;
    const here = store.id === state.activeStoreId;
    const manager = store.staff.find((m) => m.role === "manager");
    const out: HTMLElement[] = [
      h("p", { cls: "cityui__storehead" }, [
        h("span", { cls: "cityui__tagcross", text: "✚" }),
        storeName(state, store),
      ]),
      h("p", { cls: "cityui__facts" }, [
        h("span", { text: `${store.repStars.toFixed(1)}★ local` }),
        h("span", { cls: "cityui__dot", text: "·" }),
        h("span", { text: `Gen ${store.era}` }),
        h("span", { cls: "cityui__dot", text: "·" }),
        h("span", {
          text: `${store.staff.length} ${store.staff.length === 1 ? "hire" : "hires"}`,
        }),
      ]),
      h("p", {
        cls: "cityui__sharenote",
        text: here
          ? "You're running this store today."
          : manager
            ? `${manager.name} runs it while you're away.`
            : "No manager — unvisited days run at 60%.",
      }),
    ];
    if (!here) {
      if (state.phase === "morning") {
        const go = h("button", {
          cls: "pill pill--primary pill--small cityui__act",
          text: "Run today's shift here",
          attrs: { type: "button" },
        });
        go.addEventListener("pointerdown", (e) => e.preventDefault());
        go.addEventListener("click", () => {
          sim.dispatch({ type: "branch.setActive", storeId: store.id });
        });
        out.push(go);
      } else {
        out.push(
          h("p", { cls: "cityui__sharenote", text: "Branches switch in the morning." }),
        );
      }
    }
    return out;
  }

  /** §19 deed: the district's empty lot, priced by the §26 math, gated the
   *  way a license application is gated — and its demand character spoken
   *  from observed data only (§12: the mix above is what you *know*). */
  function deedBlock(districtId: string): HTMLElement[] {
    const state = sim.snapshot;
    const district = districtById(districtId);
    const price = branchPrice(districtId);
    const hasL5 = ownsLicense(state, "L5");
    const covered = state.cash >= price.total;

    const gate = (met: boolean, text: string): HTMLElement =>
      h("p", { cls: met ? "cityui__gate cityui__gate--met" : "cityui__gate" }, [
        h("span", { cls: "cityui__gateglyph", attrs: { "aria-hidden": "true" }, text: met ? "✓" : "◻" }),
        h("span", { text }),
      ]);

    const buy = h("button", {
      cls: "pill pill--primary pill--small cityui__act",
      text: `Buy this lot — ${money(price.total)}`,
      attrs: { type: "button" },
    });
    buy.disabled = !hasL5 || !covered || state.phase === "close";
    buy.addEventListener("pointerdown", (e) => e.preventDefault());
    buy.addEventListener("click", () => sim.dispatch({ type: "branch.buy", districtId }));

    const priceRow = (label: string, value: string, total = false): HTMLElement =>
      h("div", { cls: total ? "cityui__deedrow cityui__deedrow--total" : "cityui__deedrow" }, [
        h("span", { text: label }),
        h("span", { cls: "cityui__deeddots" }),
        h("span", { cls: "cityui__deednum", text: value }),
      ]);

    return [
      h("div", { cls: "cityui__deed" }, [
        h("p", { cls: "cityui__deedeyebrow", text: "For sale · the corner lot" }),
        priceRow(`site · 300 × ${money(district.dailyRent)} rent`, money(price.site)),
        priceRow("fit-out · starting layout, Gen 1", money(price.fitOut)),
        priceRow("deed total", money(price.total), true),
        gate(hasL5, hasL5 ? "Multi-Branch Operation — on the wall" : "Needs the Multi-Branch Operation license"),
        gate(
          covered,
          covered
            ? "The till covers it"
            : `Short ${money(price.total - state.cash)}`,
        ),
        buy,
        h("p", {
          cls: "cityui__deednote",
          text: "Opens empty at 2.5★ — the scripts-seen list above is everything you know about this counter.",
        }),
      ]),
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

    // §19: the founding store keeps its own site; every *other* store in a
    // district stands on the district's one lot.
    const branches = state.stores.filter((s) => s.districtId === id);
    const lotFree = !state.stores.some((s) => !isFoundingStore(state, s) && s.districtId === id);

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
        ...pharmacyRows(id),
        h("p", { cls: "cityui__mixhead", text: "Scripts seen · 28 days" }),
        ...mix,
        ...branches.flatMap((store) => branchBlock(store)),
        ...(branches.length > 0 ? shareLine() : []),
        ...(lotFree ? deedBlock(id) : []),
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
  // §18: a shortage edge moves every rival's availability, so an open
  // card's share bars must follow the same morning's headline.
  bus.on("shortage.started", invalidate);
  bus.on("shortage.ended", invalidate);
  // §19: a purchase turns the deed into a branch block on the spot, and a
  // morning switch flips the "you're here" line.
  bus.on("branch.bought", invalidate);
  bus.on("branch.activeChanged", invalidate);
  // Cash only moves the deed's "Short $X" gate line and its buy pill —
  // rebuild for it just while a deed is actually on the card, not three
  // times per completed sale for as long as the map is open.
  bus.on("cash.changed", () => {
    if (cardId === null) return;
    const state = sim.snapshot;
    if (!state.stores.some((s) => !isFoundingStore(state, s) && s.districtId === cardId)) {
      invalidate();
    }
  });

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
      // Leaving every plate keeps the last card up (M14: it carries the
      // deed's buy pill and the morning hand-off — the pointer has to be
      // able to travel to them); only hovering a *different* district, or
      // putting the map away, swaps or clears it.
      if (id === cardId || id === null) {
        if (id === null) {
          for (const tag of tags.values()) tag.classList.remove("cityui__tag--hot");
        }
        return;
      }
      cardId = id;
      for (const [tagId, tag] of tags) {
        tag.classList.toggle("cityui__tag--hot", tagId === id);
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
