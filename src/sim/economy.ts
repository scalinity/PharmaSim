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
import { networkStars, type DayStats, type GameState, type OrderLine, type StoreState } from "./state";

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
  /** §19: an unvisited branch's resolved day posts as one net line — the
   *  branch page of the receipt itemizes it. */
  { id: "branch.sales", group: "revenue", label: "Branch sales" },
  { id: "refund", group: "revenue", label: "Refunds" },
  { id: "order", group: "cost", label: "Wholesale orders" },
  { id: "wages", group: "cost", label: "Wages" },
  { id: "rent", group: "cost", label: "Rent" },
  { id: "utilities", group: "cost", label: "Utilities" },
  { id: "spoilage", group: "cost", label: "Spoilage — refrigerated stock" },
  { id: "loan.interest", group: "cost", label: "Loan interest" },
  { id: "fixtures", group: "cost", label: "Fixtures" },
  { id: "license", group: "cost", label: "Licenses" },
  { id: "expansion", group: "cost", label: "Expansion" },
  /** §19: site (300× district rent) + the $15k fit-out, one line. */
  { id: "branch.purchase", group: "cost", label: "Branch purchase" },
  { id: "renovation", group: "cost", label: "Renovation" },
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

// --- §16 regional shortage: one Rx category squeezed at a time (§26) ---

const SHORTAGE_WHOLESALE_MULT = 1.5;
const SHORTAGE_FILL_RATE = 0.6;

/** Is this SKU's category squeezed by a shortage today? Shortages are an Rx
 *  affair — OTC SKUs always come back false. */
export function shortageActive(state: GameState, skuId: string): boolean {
  const drug = DRUG_BY_ID.get(skuId);
  if (!drug) return false;
  for (const s of state.events.shortages) {
    if (s.category === drug.category && state.day >= s.startDay && state.day <= s.endDay) {
      return true;
    }
  }
  return false;
}

/** Units the wholesaler will actually send (§16: fills capped at 60% while
 *  the SKU's category is short). The Orders panel's stub and the order
 *  command both read this, so the paper never promises more than the van. */
export function shortageFillCap(state: GameState, skuId: string, units: number): number {
  return shortageActive(state, skuId) ? Math.floor(units * SHORTAGE_FILL_RATE) : units;
}

/** What this store actually pays per unit today: the supplier tier's shave
 *  — earned by the ordering store's own §19 local standing; a new branch
 *  hasn't earned its wholesaler's trust yet — and a shortage's ×1.5 on the
 *  squeezed category (§16, §26). */
export function unitCost(state: GameState, store: StoreState, skuId: string): number {
  const shortage = shortageActive(state, skuId) ? SHORTAGE_WHOLESALE_MULT : 1;
  return round2(listWholesale(skuId) * shortage * (1 - supplierDiscount(store.repStars)));
}

export function orderTotal(
  state: GameState,
  store: StoreState,
  lines: readonly OrderLine[],
): number {
  let total = 0;
  for (const l of lines) total += unitCost(state, store, l.skuId) * l.units;
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

/** §12/§14: Tier 2 needs L2; Tier 3 needs L3 and a cabinet *in this store*;
 *  refrigerated SKUs need a fridge here too, and the vaccine dose rides L4,
 *  not L2 (§25). Orders scope per branch (§19), so the store is named. */
function rxLock(state: GameState, store: StoreState, def: DrugDef): string | null {
  if (def.category === "vaccines") {
    if (!state.licenses.includes("L4")) return "Needs the Immunization Certification license";
  } else if (def.tier === 2 && !state.licenses.includes("L2")) {
    return "Needs the Expanded Formulary license";
  }
  if (def.tier === 3) {
    if (!state.licenses.includes("L3")) return "Needs the Controlled Substances license";
    if (!store.furniture.some((f) => f.defId === "cabinet_controlled")) {
      return "Needs a controlled cabinet";
    }
  }
  if (def.refrigerated && !hasFridge(store)) {
    return "Requires medical refrigeration";
  }
  return null;
}

/** Live lock for one SKU — the Orders panel re-checks its rows as licenses
 *  and cabinets come and go mid-session (§11, §12). Null = orderable. */
export function skuLock(state: GameState, store: StoreState, skuId: string): string | null {
  const drug = DRUG_BY_ID.get(skuId);
  return drug ? rxLock(state, store, drug) : null;
}

/**
 * Orderable catalog for the Orders panel. Every SKU stays listed with its
 * reason when gated — a licence, a cabinet, or medical refrigeration — so
 * the player can see what the purchase would buy them (§11, §12, §14).
 */
export function catalog(state: GameState, store: StoreState): CatalogEntry[] {
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
      lock: rxLock(state, store, def),
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
export function unitMargin(
  state: GameState,
  store: StoreState,
  entry: CatalogEntry,
  sellPrice: number,
): number {
  return round2(sellPrice - unitCost(state, store, entry.skuId));
}

// --- Fixed costs and the day close (§10, §26) ---

/** §10: $20 base, $6 per powered fixture, $2 for an idle generator. */
export function utilitiesCost(store: StoreState): number {
  let total = 20;
  for (const item of store.furniture) {
    const def = furnitureDef(item.defId);
    if (!def.powered) continue;
    total += item.defId === "generator_backup" ? 2 : 6;
  }
  return total;
}

/** §10/§17: rent follows the store's own district. */
export function rentCost(store: StoreState): number {
  return districtById(store.districtId).dailyRent;
}

// --- §19/§26 branch purchase: site 300× daily rent + $15,000 fit-out ---

export const BRANCH_SITE_RENT_MULTIPLE = 300;
export const BRANCH_FITOUT = 15_000;

export interface BranchPrice {
  site: number;
  fitOut: number;
  total: number;
}

/** The §26 lot math, itemized the way the deed prints it. */
export function branchPrice(districtId: string): BranchPrice {
  const site = districtById(districtId).dailyRent * BRANCH_SITE_RENT_MULTIPLE;
  return { site, fitOut: BRANCH_FITOUT, total: site + BRANCH_FITOUT };
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
  // The whole network's books: the bank lends to the account (§10/§19).
  let average = 0;
  for (const store of state.stores) {
    const gross = store.gross7d;
    if (gross.length === 0) continue;
    average += gross.reduce((sum, g) => sum + g, 0) / gross.length;
  }
  const limit = Math.min(BANK_CAP, Math.floor(average * BANK_GROSS_MULTIPLE));
  const balance = state.loans.bank;
  // repStars accumulates float deltas, so compare at the tenth that is
  // displayed \u2014 the card must never read "you're at 3.0\u2605" while still
  // locked (same rule as the license gates).
  // The bank reads the name's best-known store (networkStars, the \u00a712 rule).
  const stars = networkStars(state);
  const shownStars = Math.round(stars * 10) / 10;
  const lock =
    shownStars < BANK_UNLOCK_STARS
      ? `Opens at ${BANK_UNLOCK_STARS.toFixed(1)}\u2605 \u00b7 you're at ${stars.toFixed(1)}\u2605`
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
  // Fixed costs land per store, visited or not (§10/§19: rent, wages and
  // utilities are the price of every door with the name on it). §9/§26
  // wages, one line per person still on a roster — anyone fired mid-shift
  // was paid on the spot, so firing stops wages from tomorrow.
  for (const store of state.stores) {
    for (const member of store.staff) post(state, "wages", -member.dailyWage, emit);
    post(state, "rent", -rentCost(store), emit);
    post(state, "utilities", -utilitiesCost(store), emit);
  }

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
