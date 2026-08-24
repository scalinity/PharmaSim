// Licenses (SPEC §12): the six account-wide capability gates, what each one
// needs before it can be bought, and what the store's current licenses let
// the §17 demand generator draw — generation only emits SKUs the store could
// actually fill; unlicensed demand implicitly goes elsewhere. Pure sim.

import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { hasFridge } from "./coldchain";
import { networkStars, type GameState, type StoreState } from "./state";

export interface LicenseDef {
  id: string;
  name: string;
  /** 0 = never bought (L1 comes with the store). */
  cost: number;
  /** Reputation gate, 0 when none (§12 requires column). */
  stars: number;
  /** Prerequisite license (L6 needs L5). */
  needsLicense?: string;
  /** Branch-count gate (L6 needs 2; the count is wired up in M14). */
  needsBranches?: number;
  /** Certificate body copy: what the license lets the store do. */
  unlocks: string;
  /** Extra row note (L4: the station arrives with its equipment, §14/M09). */
  note?: string;
}

/** §12 table, in wall order. */
export const LICENSE_DEFS: readonly LicenseDef[] = [
  {
    id: "L1",
    name: "Community Pharmacy",
    cost: 0,
    stars: 0,
    unlocks: "OTC retail and the Tier-1 formulary",
  },
  {
    id: "L2",
    name: "Expanded Formulary",
    cost: 8_000,
    stars: 2,
    unlocks: "Tier-2 Rx SKUs",
  },
  // M16 balancing: L3–L6 are −20% from the launch 20k/12k/50k/40k — the
  // late arc could not be funded on the year's earnings otherwise
  // (docs/balance-notes.md). L1/L2 stand at launch.
  {
    id: "L3",
    name: "Controlled Substances",
    cost: 16_000,
    stars: 3,
    unlocks: "Tier-3 SKUs, kept in a locked cabinet",
  },
  {
    id: "L4",
    name: "Immunization Certification",
    cost: 9_600,
    stars: 2.5,
    unlocks: "The vaccination service",
    note: "The station and service arrive with the equipment.",
  },
  {
    id: "L5",
    name: "Multi-Branch Operation",
    cost: 40_000,
    stars: 4,
    unlocks: "Buying additional branches",
  },
  {
    id: "L6",
    name: "Distribution Operations",
    cost: 32_000,
    stars: 0,
    needsLicense: "L5",
    needsBranches: 2,
    unlocks: "A distribution center and trucks",
  },
];

const DEF_BY_ID = new Map(LICENSE_DEFS.map((def) => [def.id, def]));

export function licenseDef(id: string): LicenseDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown license: ${id}`);
  return def;
}

export function ownsLicense(state: GameState, id: string): boolean {
  return state.licenses.includes(id);
}

/** One requirement line on the application form: live copy + whether it holds. */
export interface LicenseGate {
  met: boolean;
  text: string;
}

/** The exact requirements between here and this certificate (§12 gates). */
export function licenseGates(state: GameState, def: LicenseDef): LicenseGate[] {
  const gates: LicenseGate[] = [];
  if (def.stars > 0) {
    // The board judges the name by its best-known store (§19 local rep,
    // networkStars). repStars accumulates float deltas, so compare at the
    // precision shown — a form must never read "you're at 2.0★" beside an
    // unmet 2.0★ box.
    const stars = networkStars(state);
    const shown = Math.round(stars * 10) / 10;
    gates.push({
      met: shown >= def.stars,
      text: `${def.stars.toFixed(1)}★ standing — you're at ${stars.toFixed(1)}★`,
    });
  }
  if (def.needsLicense) {
    const met = ownsLicense(state, def.needsLicense);
    const name = licenseDef(def.needsLicense).name;
    gates.push({ met, text: met ? `${name} — on the wall` : `${name} — not yet licensed` });
  }
  if (def.needsBranches !== undefined) {
    const count = state.stores.length;
    gates.push({
      met: count >= def.needsBranches,
      text: `${def.needsBranches} branches — you run ${count}`,
    });
  }
  const covered = state.cash >= def.cost;
  // Cash is exact to the cent; the shortfall reads in whole dollars.
  const short = Math.ceil(def.cost - state.cash);
  gates.push({
    met: covered,
    text: covered
      ? `$${def.cost.toLocaleString("en-US")} fee — the till covers it`
      : `$${def.cost.toLocaleString("en-US")} fee — short $${short.toLocaleString("en-US")}`,
  });
  return gates;
}

export function canBuyLicense(state: GameState, def: LicenseDef): boolean {
  if (def.cost === 0 || ownsLicense(state, def.id)) return false;
  return licenseGates(state, def).every((gate) => gate.met);
}

// --- What the demand generator may draw (§12 × §17) ---

/**
 * Could this store fill a script for this drug today? Tier 2 needs L2; Tier 3
 * needs L3 and a controlled cabinet on the floor; refrigerated SKUs also need
 * a medical fridge to live in (§14). Licenses are account-wide, equipment is
 * per store (§12/§19) — so the store is named. Vaccine doses are the §14
 * service's stock, never script demand — no doctor writes a script for a
 * flu shot.
 */
export function canFillDrug(state: GameState, store: StoreState, def: DrugDef): boolean {
  if (def.category === "vaccines") return false;
  if (def.refrigerated && !hasFridge(store)) return false;
  if (def.tier === 2) return ownsLicense(state, "L2");
  if (def.tier === 3) {
    return (
      ownsLicense(state, "L3") && store.furniture.some((f) => f.defId === "cabinet_controlled")
    );
  }
  return true;
}

export function fillableDrugs(state: GameState, store: StoreState): DrugDef[] {
  return DRUG_DEFS.filter((def) => canFillDrug(state, store, def));
}
