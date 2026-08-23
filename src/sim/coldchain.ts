// Cold chain + vaccinations (SPEC §14, §25, §26): what the medical fridge
// holds and gates, how much cold space an order may still claim, and the
// vaccination service's numbers. The fridge is a bin fixture like the
// controlled cabinet — inventory.ts routes refrigerated stock into it — and
// this module owns the capacity math both the Orders panel and the order
// command enforce. Pure sim — no DOM, no three.js.

import { DRUG_DEFS } from "../data/drugs";
import type { GameState, StoreState } from "./state";

/** §26: refrigerated units one fridge holds; a second fridge doubles it. */
export const FRIDGE_CAPACITY = 40;

/** §26 vaccination service: 15 igm a shot, $30 reimbursed (net +$22 over the
 *  $8 dose), 3–6 walk-ins a day once the service exists. */
export const VACCINE_IGM = 15;
export const VACCINE_REIMBURSEMENT = 30;
export const VACCINE_WALKINS_MIN = 3;
export const VACCINE_WALKINS_MAX = 6;
export const VACCINE_DOSE_ID = "fluVaxDose";

const REFRIGERATED_IDS: ReadonlySet<string> = new Set(
  DRUG_DEFS.filter((def) => def.refrigerated).map((def) => def.id),
);

export function isRefrigerated(skuId: string): boolean {
  return REFRIGERATED_IDS.has(skuId);
}

/** The one fridge gate every §14 consumer shares — ordering locks, demand
 *  generation, the vaccination service, and the sell-clearing rule. */
export function hasFridge(state: GameState): boolean {
  return state.store.furniture.some((f) => f.defId === "fridge_medical");
}

export function fridgeCount(state: GameState): number {
  let fridges = 0;
  for (const item of state.store.furniture) {
    if (item.defId === "fridge_medical") fridges++;
  }
  return fridges;
}

export function fridgeCapacity(state: GameState): number {
  return fridgeCount(state) * FRIDGE_CAPACITY;
}

/** Refrigerated units the store holds — in the fridge bins or still boxed in
 *  the backroom; either way they claim cold space. */
export function refrigeratedHeld(store: StoreState): number {
  let units = 0;
  for (const skuId of REFRIGERATED_IDS) {
    const line = store.stock[skuId];
    if (line) units += line.backroom + line.shelved;
  }
  return units;
}

/** Refrigerated units already on tomorrow's van — space is promised to them. */
export function refrigeratedInbound(store: StoreState): number {
  let units = 0;
  for (const line of store.inbound) {
    if (REFRIGERATED_IDS.has(line.skuId)) units += line.units;
  }
  return units;
}

/** Cold units an order could still claim (§14: capacity enforced at order
 *  time — held stock plus what's inbound, against 40 per fridge). */
export function fridgeFree(state: GameState): number {
  return Math.max(
    0,
    fridgeCapacity(state) - refrigeratedHeld(state.store) - refrigeratedInbound(state.store),
  );
}

/** §14: walk-ins come once L4, a fridge and a station are all in place; a
 *  pharmacist (or the player) still has to work the shots. The license check
 *  is inlined (not licenses.ts's ownsLicense) so this module stays a leaf
 *  that licenses.ts itself can import without a cycle. */
export function vaccinationUnlocked(state: GameState): boolean {
  return (
    state.licenses.includes("L4") &&
    hasFridge(state) &&
    state.store.furniture.some((f) => f.defId === "vaccine_station")
  );
}
