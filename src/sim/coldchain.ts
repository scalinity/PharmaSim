// Cold chain + vaccinations (SPEC §14, §25, §26): what the medical fridge
// holds and gates, how much cold space an order may still claim, and the
// vaccination service's numbers. The fridge is a bin fixture like the
// controlled cabinet — inventory.ts routes refrigerated stock into it — and
// this module owns the capacity math both the Orders panel and the order
// command enforce. Pure sim — no DOM, no three.js.

import { DRUG_DEFS, drugDef } from "../data/drugs";
import type { GameState, StoreState } from "./state";

/** §26: refrigerated units one fridge holds; a second fridge doubles it. */
export const FRIDGE_CAPACITY = 40;

/** §26 vaccination service: 15 igm a shot, the dose's §25 reimbursement
 *  credited per shot, 4–7 walk-ins a day once the service exists.
 *  M16 balancing: walk-ins +1 from the launch 3–6, and the dose's +18%
 *  reimbursement moves the net to +$27 (docs/balance-notes.md). */
export const VACCINE_IGM = 15;
export const VACCINE_WALKINS_MIN = 4;
export const VACCINE_WALKINS_MAX = 7;
export const VACCINE_DOSE_ID = "fluVaxDose";
/** Derived from the catalog so the Orders panel's "insurer, fixed" column
 *  and the ledger can never quote two different numbers. */
export const VACCINE_REIMBURSEMENT = drugDef(VACCINE_DOSE_ID).reimbursement;

const REFRIGERATED_IDS: ReadonlySet<string> = new Set(
  DRUG_DEFS.filter((def) => def.refrigerated).map((def) => def.id),
);

export function isRefrigerated(skuId: string): boolean {
  return REFRIGERATED_IDS.has(skuId);
}

/** The one fridge gate every §14 consumer shares — ordering locks, demand
 *  generation, the vaccination service, and the sell-clearing rule. Takes
 *  the store, not the state: fridges are per-branch equipment (§12/§19). */
export function hasFridge(store: StoreState): boolean {
  return store.furniture.some((f) => f.defId === "fridge_medical");
}

export function fridgeCount(store: StoreState): number {
  let fridges = 0;
  for (const item of store.furniture) {
    if (item.defId === "fridge_medical") fridges++;
  }
  return fridges;
}

export function fridgeCapacity(store: StoreState): number {
  return fridgeCount(store) * FRIDGE_CAPACITY;
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
export function fridgeFree(store: StoreState): number {
  return Math.max(
    0,
    fridgeCapacity(store) - refrigeratedHeld(store) - refrigeratedInbound(store),
  );
}

/** The §14 order-time clamp itself, shared by the Orders panel's cart and
 *  the order command so the number the player sees is the number the
 *  command accepts: units this line may claim, after the cold space the
 *  rest of the cart has already spoken for. */
export function coldClampUnits(
  store: StoreState,
  wanted: number,
  claimedElsewhere: number,
): number {
  return Math.max(0, Math.min(wanted, fridgeFree(store) - claimedElsewhere));
}

/** §14: walk-ins come once L4, a fridge and a station are all in place at
 *  this store; a pharmacist (or the player) still has to work the shots.
 *  The license check is inlined (not licenses.ts's ownsLicense) so this
 *  module stays a leaf that licenses.ts itself can import without a cycle. */
export function vaccinationUnlocked(state: GameState, store: StoreState): boolean {
  return (
    state.licenses.includes("L4") &&
    hasFridge(store) &&
    store.furniture.some((f) => f.defId === "vaccine_station")
  );
}
