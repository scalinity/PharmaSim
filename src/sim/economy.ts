// Economy (SPEC §10, §11, §17, §26): the day's ledger — every cash movement is
// a typed line with a reason, grouped for the receipt — plus wholesale pricing
// with reputation supplier tiers, the fixed costs charged at close, the bank
// credit line, and Aunt Rosa's soft floor. Pure sim — no DOM, no three.js.

import { districtById } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { furnitureDef } from "../data/furniture";
import { OTC_DEFS, otcDef } from "../data/otc";
import { hasFridge } from "./coldchain";
import type { SimEvent } from "./events";
import type { DayStats, GameState, OrderLine } from "./state";

type Emit = (event: SimEvent) => void;

/** Money stays exact to the cent (supplier discounts land on fractions). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- The ledger (§10) ---

export type LedgerGroup = "revenue" | "cost" | "financing";

export interface LedgerReasonDef {
  id: string;
  group: LedgerGroup;
  /** Receipt copy — the same words as the button and the toast (§28). */
  label: string;
}

/** Every reason a dollar can move, in receipt order (§10). */
export const LEDGER_REASONS = [
  { id: "rx.reimbursement", group: "revenue", label: "Rx reimbursements" },
  { id: "rx.copay", group: "revenue", label: "Copays" },
  { id: "otc.sale", group: "revenue", label: "OTC sales" },
  { id: "vaccine", group: "revenue", label: "Vaccinations" },
  { id: "refund", group: "revenue", label: "Refunds" },
  { id: "order", group: "cost", label: "Wholesale orders" },
  { id: "wages", group: "cost", label: "Wages" },
  { id: "rent", group: "cost", label: "Rent" },
  { id: "utilities", group: "cost", label: "Utilities" },
  { id: "loan.interest", group: "cost", label: "Loan interest" },
  { id: "fixtures", group: "cost", label: "Fixtures" },
  { id: "license", group: "cost", label: "Licenses" },
  { id: "expansion", group: "cost", label: "Expansion" },
  { id: "bank.draw", group: "financing", label: "Credit line draw" },
  { id: "bank.payment", group: "financing", label: "Credit line payment" },
  { id: "family.loan", group: "financing", label: "Family loan" },
  { id: "family.payment", group: "financing", label: "Family repayment" },
] as const satisfies readonly LedgerReasonDef[];

export type LedgerReason = (typeof LEDGER_REASONS)[number]["id"];

/** Move cash and write the line. The only door cash moves through. */
export function post(
  state: GameState,
  reason: LedgerReason,
  amount: number,
  emit: Emit,
): void {
  const delta = round2(amount);
  if (delta === 0) return;
  state.cash = round2(state.cash + delta);
  const tally = (state.dayStats.ledger[reason] ??= { count: 0, amount: 0 });
  tally.count++;
  tally.amount = round2(tally.amount + delta);
  emit({ type: "cash.changed", cash: state.cash });
}

export function groupTotal(stats: DayStats, group: LedgerGroup): number {
  let total = 0;
  for (const reason of LEDGER_REASONS) {
    if (reason.group !== group) continue;
    total += stats.ledger[reason.id]?.amount ?? 0;
  }
  return round2(total);
}

/** Revenue minus costs — what the family loan repays 15% of (§10). */
export function operatingProfit(stats: DayStats): number {
  return round2(groupTotal(stats, "revenue") + groupTotal(stats, "cost"));
}

/** The day's whole cash movement; must equal cash − cashOpen (§10 integrity). */
export function ledgerNet(stats: DayStats): number {
  return round2(
    groupTotal(stats, "revenue") + groupTotal(stats, "cost") + groupTotal(stats, "financing"),
  );
}

// --- Wholesale pricing (§10, §11, §26) ---

/** §26 flat copay: what the patient pays on top of the insurer's part. */
export const COPAY = 10;

/** §26 supplier tiers, best first: better contracts as reputation grows. */
export const SUPPLIER_TIERS: readonly { stars: number; discount: number }[] = [
  { stars: 4, discount: 0.08 },
  { stars: 2, discount: 0.04 },
];

export function supplierDiscount(repStars: number): number {
  for (const tier of SUPPLIER_TIERS) {
    if (repStars >= tier.stars) return tier.discount;
  }
  return 0;
}

const DRUG_BY_ID = new Map<string, DrugDef>(DRUG_DEFS.map((def) => [def.id, def]));

/** §10: OTC wholesale is 55% of MSRP; Rx wholesale is the §25 catalog value. */
export function listWholesale(skuId: string): number {
  const drug = DRUG_BY_ID.get(skuId);
  if (drug) return drug.wholesale;
  return round2(otcDef(skuId).msrp * 0.55);
}

/** What the store actually pays per unit today, after the supplier tier. */
export function unitCost(state: GameState, skuId: string): number {
  return round2(listWholesale(skuId) * (1 - supplierDiscount(state.repStars)));
}

export function orderTotal(state: GameState, lines: readonly OrderLine[]): number {
  let total = 0;
  for (const l of lines) total += unitCost(state, l.skuId) * l.units;
  return round2(total);
}

// --- The wholesale catalog (§11, §12, §25) ---

export interface CatalogEntry {
  skuId: string;
  name: string;
  kind: "rx" | "otc";
  /** Rx tier (1–3) or 0 for OTC — drives the catalog's sections. */
  tier: number;
  category: string;
  /** Cold-chain SKU: lives in the fridge, counts against its 40 units (§14). */
  refrigerated: boolean;
  /** Fixed reimbursement (Rx) or MSRP (OTC). */
  listPrice: number;
  /** Null when orderable; otherwise why it is locked (§12 gates). */
  lock: string | null;
}

/** Category chip copy — §24 category ids, said the way a person would. */
const CATEGORY_LABELS: Record<string, string> = {
  cardiovascular: "cardio",
  diabetes: "diabetes",
  thyroid: "thyroid",
  gi: "GI",
  antibiotics: "antibiotic",
  respiratory: "respiratory",
  mentalHealth: "mental health",
  pain: "pain",
  anticoagulant: "anticoagulant",
  pediatric: "pediatric",
  dermatology: "derm",
  vaccines: "vaccine",
  allergy: "allergy",
  coldflu: "cold & flu",
  digestive: "digestive",
  wellness: "wellness",
  firstaid: "first aid",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** §12/§14: Tier 2 needs L2; Tier 3 needs L3 and a cabinet; refrigerated
 *  SKUs need a fridge too, and the vaccine dose rides L4, not L2 (§25). */
function rxLock(state: GameState, def: DrugDef): string | null {
  if (def.category === "vaccines") {
    if (!state.licenses.includes("L4")) return "Needs the Immunization Certification license";
  } else if (def.tier === 2 && !state.licenses.includes("L2")) {
    return "Needs the Expanded Formulary license";
  }
  if (def.tier === 3) {
    if (!state.licenses.includes("L3")) return "Needs the Controlled Substances license";
    if (!state.store.furniture.some((f) => f.defId === "cabinet_controlled")) {
      return "Needs a controlled cabinet";
    }
  }
  if (def.refrigerated && !hasFridge(state)) {
    return "Requires medical refrigeration";
  }
  return null;
}

/** Live lock for one SKU — the Orders panel re-checks its rows as licenses
 *  and cabinets come and go mid-session (§11, §12). Null = orderable. */
export function skuLock(state: GameState, skuId: string): string | null {
  const drug = DRUG_BY_ID.get(skuId);
  return drug ? rxLock(state, drug) : null;
}

/**
 * Orderable catalog for the Orders panel. Every SKU stays listed with its
 * reason when gated — a licence, a cabinet, or medical refrigeration — so
 * the player can see what the purchase would buy them (§11, §12, §14).
 */
export function catalog(state: GameState): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const def of DRUG_DEFS) {
    entries.push({
      skuId: def.id,
      name: def.name,
      kind: "rx",
      tier: def.tier,
      category: def.category,
      refrigerated: def.refrigerated === true,
      listPrice: def.reimbursement,
      lock: rxLock(state, def),
    });
  }
  for (const def of OTC_DEFS) {
    entries.push({
      skuId: def.id,
      name: def.name,
      kind: "otc",
      tier: 0,
      category: def.category,
      refrigerated: false,
      listPrice: def.msrp,
      lock: null,
    });
  }
  return entries;
}

/** Margin per unit (§10): what the SKU earns over what it costs today. */
export function unitMargin(state: GameState, entry: CatalogEntry, sellPrice: number): number {
  return round2(sellPrice - unitCost(state, entry.skuId));
}

// --- Fixed costs and the day close (§10, §26) ---

/** The store's district until the city map lands (§17). */
export const STORE_DISTRICT_ID = "oldTown";

/** §10: $20 base, $6 per powered fixture, $2 for an idle generator. */
export function utilitiesCost(state: GameState): number {
  let total = 20;
  for (const item of state.store.furniture) {
    const def = furnitureDef(item.defId);
    if (!def.powered) continue;
    total += item.defId === "generator_backup" ? 2 : 6;
  }
  return total;
}

export function rentCost(): number {
  return districtById(STORE_DISTRICT_ID).dailyRent;
}

export const BANK_UNLOCK_STARS = 3;
export const BANK_INTEREST = 0.004; // 0.4%/day on balance (§26)
export const BANK_MIN_PAYMENT = 0.02; // 2%/day auto minimum (§26)
export const BANK_CAP = 50_000;
const BANK_GROSS_MULTIPLE = 20;
export const FAMILY_LOAN_FLOOR = 2_500;
export const FAMILY_REPAY_SHARE = 0.15;

export interface BankStatus {
  /** Why the credit line is closed, or null when it is open (§10). */
  lock: string | null;
  limit: number;
  balance: number;
  available: number;
}

/** Credit line: 20× the trailing-7-day average gross, capped at $50k (§26). */
export function bankStatus(state: GameState): BankStatus {
  const gross = state.store.gross7d;
  const average = gross.length === 0 ? 0 : gross.reduce((sum, g) => sum + g, 0) / gross.length;
  const limit = Math.min(BANK_CAP, Math.floor(average * BANK_GROSS_MULTIPLE));
  const balance = state.loans.bank;
  // repStars accumulates float deltas, so compare at the tenth that is
  // displayed \u2014 the card must never read "you're at 3.0\u2605" while still
  // locked (same rule as the license gates).
  const shownStars = Math.round(state.repStars * 10) / 10;
  const lock =
    shownStars < BANK_UNLOCK_STARS
      ? `Opens at ${BANK_UNLOCK_STARS.toFixed(1)}\u2605 \u00b7 you're at ${state.repStars.toFixed(1)}\u2605`
      : null;
  return { lock, limit, balance, available: Math.max(0, round2(limit - balance)) };
}

export interface CloseSummary {
  /** Dollars Aunt Rosa put in the register tonight, or 0 (§10). */
  familyLoan: number;
}

/**
 * Close the books (§10): rent, utilities and loan interest post first, then
 * the family loan repays out of the day's profit, and finally Aunt Rosa tops a
 * negative till back to +$2,500 — once, until it is repaid.
 */
export function closeDay(state: GameState, emit: Emit): CloseSummary {
  // §9/§26 wages, one line per person still on the roster. Anyone fired
  // mid-shift was paid on the spot, so firing stops wages from tomorrow.
  for (const member of state.store.staff) post(state, "wages", -member.dailyWage, emit);
  post(state, "rent", -rentCost(), emit);
  post(state, "utilities", -utilitiesCost(state), emit);

  if (state.loans.bank > 0) {
    post(state, "loan.interest", -round2(state.loans.bank * BANK_INTEREST), emit);
    const payment = Math.min(state.loans.bank, round2(state.loans.bank * BANK_MIN_PAYMENT));
    state.loans.bank = round2(state.loans.bank - payment);
    post(state, "bank.payment", -payment, emit);
    emit({ type: "loan.changed", bank: state.loans.bank, family: state.loans.family });
  }

  const profit = operatingProfit(state.dayStats);
  if (state.loans.family > 0 && profit > 0) {
    const payment = Math.min(state.loans.family, round2(profit * FAMILY_REPAY_SHARE));
    state.loans.family = round2(state.loans.family - payment);
    post(state, "family.payment", -payment, emit);
    emit({ type: "loan.changed", bank: state.loans.bank, family: state.loans.family });
  }

  let familyLoan = 0;
  if (state.cash < 0 && state.loans.family <= 0) {
    familyLoan = round2(FAMILY_LOAN_FLOOR - state.cash);
    state.loans.family = familyLoan;
    state.dayStats.familyLoan = familyLoan;
    post(state, "family.loan", familyLoan, emit);
    emit({ type: "loan.changed", bank: state.loans.bank, family: state.loans.family });
  }
  return { familyLoan };
}
