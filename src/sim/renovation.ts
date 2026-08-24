// Era modernization (SPEC §13): the four generations, bought in order.
// Buying a renovation closes the store for the rest of the current day —
// remaining customers finish, nobody new comes in, scaffolding goes up —
// and the next morning the new era stands (commands.ts applies it at
// day.advance). Purely economic: nothing but the Gen 4 equipment gates
// hangs off the era. Pure sim — no DOM, no three.js.

import type { SimEvent } from "./events";
import { post } from "./economy";
import { recordMoment } from "./legacy";
import { activeStore, type GameState } from "./state";

type Emit = (event: SimEvent) => void;

export interface EraDef {
  era: 1 | 2 | 3 | 4;
  name: string;
  /** 0 = the founding store; it is never bought. */
  cost: number;
  /** The look, said the §28 way — the proposal card and the reveal share it. */
  look: string;
  /** What the tier gates (§13), or null — only Gen 4 gates anything. */
  gates: string | null;
}

/** §13 table, oldest first. */
export const ERA_DEFS: readonly EraDef[] = [
  {
    era: 1,
    name: "The Founding Store",
    cost: 0,
    look: "Walnut shelving, a brass register, checkerboard tile — the store your great-grandfather raised.",
    gates: null,
  },
  {
    era: 2,
    name: "The Family Business",
    cost: 6_000,
    look: "Teal linoleum, chrome-edged shelves, fluorescent hum — the post-war store, proud of it.",
    gates: null,
  },
  {
    era: 3,
    name: "The Retail Chain Era",
    cost: 18_000,
    look: "White gondolas on gray-blue steel, a drop ceiling, barcodes at the till.",
    gates: null,
  },
  {
    era: 4,
    name: "The Modern Clinic",
    cost: 40_000,
    look: "Mint and white, light oak and glass — a clinic with the family name on it.",
    gates: "Unlocks the robotic dispenser (and, in time, the AI modules).",
  },
];

export function eraDef(era: number): EraDef {
  const def = ERA_DEFS.find((d) => d.era === era);
  if (!def) throw new Error(`Unknown era: ${era}`);
  return def;
}

/** The renovation the active store could buy next, or null at Gen 4. The
 *  Renovate sheet works on the store you're standing in (§13/§19). */
function renovationTarget(state: GameState): EraDef | null {
  const era = activeStore(state).era;
  return era >= 4 ? null : eraDef(era + 1);
}

/** Why the next renovation can't be bought right now, or null when it can. */
export function renovationLock(state: GameState): string | null {
  const target = renovationTarget(state);
  if (!target) return "The store is at Gen 4";
  if (activeStore(state).pendingEra !== null) return "The crew already has the floor";
  if (state.phase === "close") return "The register is closed — tomorrow";
  if (state.cash < target.cost) {
    return `Short $${(target.cost - state.cash).toLocaleString("en-US")}`;
  }
  return null;
}

/**
 * §13 purchase: pay the crew, put the scaffolding up, close the active store
 * for the rest of today. Sim reacts to the emitted event by cancelling the
 * day's remaining arrivals; the era itself flips at the next day.advance.
 */
export function beginRenovation(state: GameState, emit: Emit): void {
  if (renovationLock(state) !== null) return;
  const target = renovationTarget(state)!;
  activeStore(state).pendingEra = target.era as 2 | 3 | 4;
  post(state, "renovation", -target.cost, emit);
  // §22: the first renovation is its moment — the note is written in the
  // scaffolding-day voice, so it pins to tonight's receipt.
  recordMoment(state, "first_renovation", emit);
  emit({
    type: "era.renovationStarted",
    era: target.era as 2 | 3 | 4,
    name: target.name,
    cost: target.cost,
    day: state.day,
  });
}

/** Next morning: scaffolding comes down wherever a crew was in — a branch
 *  renovates on schedule whether or not you stand in it tomorrow (§13/§19).
 *  era.changed announces only the active store: it drives the scene reskin
 *  and the HUD paper tint, and both belong to the floor on screen. */
export function completeRenovation(state: GameState, emit: Emit): void {
  for (const store of state.stores) {
    if (store.pendingEra === null) continue;
    store.era = store.pendingEra;
    store.pendingEra = null;
    // Recorded the morning an era first stands anywhere, like every sibling
    // stats key ("the day this became true") — the proposal card stamps
    // "Raised" from it. Later stores reaching the same generation keep the
    // first date; the album records firsts, not repeats.
    state.stats[`era.${store.era}`] ??= state.day;
    // §22: reaching Gen 4 is a moment of its own, and its note speaks of a
    // store that already looks like this — so it belongs to today, not to
    // yesterday's scaffolding.
    if (store.era === 4) recordMoment(state, "first_gen4", emit);
    if (store.id === state.activeStoreId) emit({ type: "era.changed", era: store.era });
  }
}
