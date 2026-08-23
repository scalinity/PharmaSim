// Licenses (SPEC §12): the six account-wide capability gates, what each one
// needs before it can be bought, and what the store's current licenses let
// the §17 demand generator draw — generation only emits SKUs the store could
// actually fill; unlicensed demand implicitly goes elsewhere. Pure sim.

import type { District } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import type { GameState } from "./state";

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
  {
    id: "L3",
    name: "Controlled Substances",
    cost: 20_000,
    stars: 3,
    unlocks: "Tier-3 SKUs, kept in a locked cabinet",
  },
  {
    id: "L4",
    name: "Immunization Certification",
    cost: 12_000,
    stars: 2.5,
    unlocks: "The vaccination service",
    note: "The station and service arrive with the equipment.",
  },
  {
    id: "L5",
    name: "Multi-Branch Operation",
    cost: 50_000,
    stars: 4,
    unlocks: "Buying additional branches",
  },
  {
    id: "L6",
    name: "Distribution Operations",
    cost: 40_000,
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
    // repStars accumulates float deltas, so compare at the precision shown —
    // a form must never read "you're at 2.0★" beside an unmet 2.0★ box.
    const shown = Math.round(state.repStars * 10) / 10;
    gates.push({
      met: shown >= def.stars,
      text: `${def.stars.toFixed(1)}★ standing — you're at ${state.repStars.toFixed(1)}★`,
    });
  }
  if (def.needsLicense) {
    const met = ownsLicense(state, def.needsLicense);
    const name = licenseDef(def.needsLicense).name;
    gates.push({ met, text: met ? `${name} — on the wall` : `${name} — not yet licensed` });
  }
  if (def.needsBranches !== undefined) {
    // A second branch is a §19 purchase; until M14 the count is always one.
    gates.push({ met: false, text: `${def.needsBranches} branches — you run 1` });
  }
  const covered = state.cash >= def.cost;
  gates.push({
    met: covered,
    text: covered
      ? `$${def.cost.toLocaleString("en-US")} fee — the till covers it`
      : `$${def.cost.toLocaleString("en-US")} fee — short $${(def.cost - state.cash).toLocaleString("en-US")}`,
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
 * needs L3 and a controlled cabinet on the floor; refrigerated SKUs wait for
 * the cold chain (fridge stock lands in milestone 09).
 */
export function canFillDrug(state: GameState, def: DrugDef): boolean {
  if (def.refrigerated) return false;
  if (def.tier === 2) return ownsLicense(state, "L2");
  if (def.tier === 3) {
    return (
      ownsLicense(state, "L3") &&
      state.store.furniture.some((f) => f.defId === "cabinet_controlled")
    );
  }
  return true;
}

export function fillableDrugs(state: GameState): DrugDef[] {
  return DRUG_DEFS.filter((def) => canFillDrug(state, def));
}

/** Total §25 demand weight per category — the whole pool a category's daily
 *  scripts spread across, licensed or not. */
const CATEGORY_WEIGHT: Record<string, number> = {};
for (const def of DRUG_DEFS) {
  CATEGORY_WEIGHT[def.category] = (CATEGORY_WEIGHT[def.category] ?? 0) + def.demandWeight;
}

/**
 * §17 generation, sliced to one drug: the district's daily scripts for the
 * drug's category (pop × prevalence + facility bonuses), split across the
 * category's SKUs by demand weight. Scripts for SKUs the store can't fill are
 * simply never routed here — no artificial multiplier, more fillable
 * categories = more scripts (§17, milestone 08).
 */
export function drugDailyDemand(district: District, def: DrugDef): number {
  let perDay = (district.population / 1000) * (district.prevalence[def.category] ?? 0);
  for (const facility of district.facilities) {
    perDay += facility.bonus[def.category] ?? 0;
  }
  return (perDay * def.demandWeight) / CATEGORY_WEIGHT[def.category]!;
}
