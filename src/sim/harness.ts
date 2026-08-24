// Dev fast-forward harness (milestone 16 task 3; README dev keys). Runs a
// scratch run N days forward entirely off-screen — every store resolves
// through the §19 formula (resolveBranchDay + routedBranchDay), mornings
// turn through the real day.advance command — under a simple scripted
// policy: keep stocked, hire from the §26 arc days, buy licenses, gear,
// branches and the depot as cash allows. It reports the arc-event days so
// the §26 balance targets can be checked across seeds in seconds instead
// of hand-playing 56 days.
//
// This is a pacing sanity-check, not the game: the player's own hands are
// stood in for by a wage-free virtual crew on the active store, there are
// no walk-outs, no vaccinations and no storms on an off-screen floor, and
// equipment is placed without grid checks (the state is never rendered or
// saved). Dev-only — main.ts loads it behind import.meta.env.DEV.
// Pure sim — no DOM, no three.js.

import { DISTRICTS } from "../data/districts";
import { furnitureDef } from "../data/furniture";
import { FORECAST_DAYS, forecastCovered, forecastStore } from "./aitech";
import { resolveBranchDay } from "./branches";
import { rollCityDay, routedBranchDay, type BranchDemand } from "./city";
import {
  VACCINE_DOSE_ID,
  VACCINE_REIMBURSEMENT,
  VACCINE_WALKINS_MAX,
  VACCINE_WALKINS_MIN,
  vaccinationUnlocked,
} from "./coldchain";
import { handleCommand } from "./commands";
import { ensurePatientPools } from "./competitors";
import { DC_COST } from "./dc";
import {
  bankStatus,
  branchPrice,
  closeDay,
  operatingProfit,
  orderTotal,
  post,
} from "./economy";
import { ensurePlanned, seasonVisitorMultOn, vaccineWalkinMult } from "./events-world";
import { recordMoment } from "./legacy";
import { licenseDef, ownsLicense } from "./licenses";
import { eraDef } from "./renovation";
import { mulberry32 } from "./rng";
import { refreshHiringPool, type StaffMember, type StaffRole } from "./staff";
import {
  activeStore,
  createGameState,
  isFoundingStore,
  networkStars,
  type GameState,
  type OrderLine,
  type StoreState,
} from "./state";

// --- Policy knobs (harness stand-ins, not §26 values) ---

/** §26 arc: the policy starts hiring at the target window's open. */
const HIRE_FROM_DAY = 6;
/** Cash the till always keeps back from purchases. */
const RESERVE = 1_500;
/** A hire needs this many days of the wage banked on top of the reserve. */
const HIRE_RUNWAY_DAYS = 10;
/** Yesterday's demand a store must see before the second and third pair of
 *  hands earn their wage (§26 throughputs: the owner alone covers ~25, and
 *  the pharmacist's wage waits for a genuinely busy floor). */
const SECOND_HIRE_DEMAND = 32;
const THIRD_HIRE_DEMAND = 55;
/** Extra cash a renovation/branch/depot must leave behind. */
const BIG_PURCHASE_MARGIN = 4_000;
/** Licenses buy demand, so they go first — a thinner cushion, the way a
 *  player stretches for the certificate that grows the day. */
const LICENSE_MARGIN = 1_000;
/** Days of expected demand the standing order tops every SKU up to. */
const ORDER_COVER_DAYS = 4;
/** Ignore SKUs expected to move less than this per day. */
const ORDER_MIN_DAILY = 0.05;
/** Share of the credit line the policy never touches — debt service must
 *  not starve the stock orders that keep availability (and share) alive. */
const BANK_HEADROOM = 0.15;
/** §26 repMult, applied to the active store's door like the visited §7
 *  schedule does — the §19 resolver alone models an ownerless branch. */
const REP_MULT_BASE = 0.4;
const REP_MULT_PER_STAR = 0.24;

/** Licenses in the order the arc buys them: L4's vaccine income early,
 *  then straight for L5 — the §26 arc's capstone — with L3's cabinet as
 *  the network's first luxury after it. */
const LICENSE_ORDER = ["L2", "L4", "L5", "L3", "L6"] as const;

/** Branches lead with a manager because nobody ever stands in them (§19);
 *  the founding store's roles stage by demand in wantedRoles below. */
const BRANCH_ROLES: readonly StaffRole[] = ["manager", "pharmacist", "tech", "cashier"];

/** The owner's stand-in hands on the active store (§19 has no owner): a
 *  careful tech, a register hand, a 90%-catch pharmacist, and a "manager"
 *  whose stat total puts the §26 factor at exactly 1.0 — the owner runs
 *  their own floor at par. Wage-free, pushed for the resolution only. */
const OWNER_HANDS: readonly StaffMember[] = [
  { id: "owner-tech", name: "Owner", role: "tech", speed: 3, accuracy: 4, warmth: 3, trait: "meticulous", dailyWage: 0, hiredOnDay: 0 },
  { id: "owner-cash", name: "Owner", role: "cashier", speed: 3, accuracy: 3, warmth: 3, trait: "stockhawk", dailyWage: 0, hiredOnDay: 0 },
  { id: "owner-rph", name: "Owner", role: "pharmacist", speed: 3, accuracy: 4, warmth: 3, trait: "stockhawk", dailyWage: 0, hiredOnDay: 0 },
  { id: "owner-mgr", name: "Owner", role: "manager", speed: 3, accuracy: 1, warmth: 1, trait: "stockhawk", dailyWage: 0, hiredOnDay: 0 },
];

export interface HarnessDayLog {
  day: number;
  cash: number;
  /** Founding store's stars. */
  stars: number;
  demand: number;
  served: number;
  stores: number;
  /** §10 credit line at close: what's drawn against what it would bear. */
  bank: number;
  bankLimit: number;
}

export interface HarnessReport {
  seed: number;
  days: number;
  /** §26 arc-event days (null = never happened in the run). */
  arc: {
    firstHire: number | null;
    l2: number | null;
    gen2: number | null;
    l3: number | null;
    l4: number | null;
    gen4: number | null;
    l5: number | null;
    firstBranch: number | null;
    l6: number | null;
    dc: number | null;
    firstProfit: number | null;
  };
  familyLoanDays: number;
  endCash: number;
  endStars: number;
  storeCount: number;
  log: HarnessDayLog[];
  /** Console-printable digest. */
  summary: string;
}

const noop = (): void => {};

/** Place gear without grid checks — the state is never rendered or saved. */
function buyFixture(state: GameState, store: StoreState, defId: string): void {
  const def = furnitureDef(defId);
  if (state.cash < def.cost + RESERVE) return;
  store.furniture.push({ id: `f${store.nextFurnitureId++}`, defId, cellX: 0, cellY: 0, rot: 0 });
  post(state, "fixtures", -def.cost, noop);
}

function hasFixture(store: StoreState, defId: string): boolean {
  return store.furniture.some((f) => f.defId === defId);
}

/** The §26-arc gear a store wants as licenses arrive: a fridge for the
 *  cold chain (L2 SKUs), a cabinet for Tier 3 (L3), a vaccine station for
 *  the shot service (L4) — the harness gives the active store its shots. */
function buyGear(state: GameState, store: StoreState): void {
  if (ownsLicense(state, "L2") && !hasFixture(store, "fridge_medical")) {
    buyFixture(state, store, "fridge_medical");
  }
  if (ownsLicense(state, "L3") && !hasFixture(store, "cabinet_controlled")) {
    buyFixture(state, store, "cabinet_controlled");
  }
  if (
    ownsLicense(state, "L4") &&
    hasFixture(store, "fridge_medical") &&
    !hasFixture(store, "vaccine_station")
  ) {
    buyFixture(state, store, "vaccine_station");
  }
}

/** Roles this store should hold right now — staged by yesterday's demand
 *  on the founding store (a full crew at 20 visits/day runs at a loss;
 *  the extra hands wait for the door to justify them). */
function wantedRoles(state: GameState, store: StoreState): readonly StaffRole[] {
  if (!isFoundingStore(state, store)) return BRANCH_ROLES;
  const demand = store.daySummary?.demand ?? 0;
  const roles: StaffRole[] = ["tech"];
  if (demand >= SECOND_HIRE_DEMAND) roles.push("cashier");
  if (demand >= THIRD_HIRE_DEMAND) roles.push("pharmacist");
  // The founding store adds a manager once a second door needs the owner
  // elsewhere some mornings.
  if (state.stores.length > 1) roles.push("manager");
  return roles;
}

function hireForStore(state: GameState, store: StoreState): void {
  for (const role of wantedRoles(state, store)) {
    if (store.staff.some((m) => m.role === role)) continue;
    const candidate = state.hiring.candidates.find((c) => c.role === role);
    if (!candidate) continue;
    if (state.cash < RESERVE + candidate.wageAsked * HIRE_RUNWAY_DAYS) continue;
    handleCommand(state, { type: "staff.hire", candidateId: candidate.id, storeId: store.id }, noop);
  }
}

/** Keep stocked: top every SKU up to ORDER_COVER_DAYS of the §21 forecast
 *  expectation (the same generator the game routes from), scaled down to
 *  whatever the till can cover past the reserve. */
function orderForStore(state: GameState, store: StoreState): void {
  const forecast = forecastStore(state, store);
  let lines: OrderLine[] = [];
  for (const entry of forecast.values()) {
    const daily = entry.total / FORECAST_DAYS;
    if (daily < ORDER_MIN_DAILY) continue;
    const want = Math.ceil(daily * ORDER_COVER_DAYS) - forecastCovered(state, store, entry.skuId);
    if (want > 0) lines.push({ skuId: entry.skuId, units: want });
  }
  if (lines.length === 0) return;
  const budget = state.cash - RESERVE;
  if (budget <= 0) return;
  const total = orderTotal(state, store, lines);
  if (total > budget) {
    const factor = budget / total;
    if (factor < 0.05) return;
    lines = lines
      .map((l) => ({ skuId: l.skuId, units: Math.floor(l.units * factor) }))
      .filter((l) => l.units > 0);
    if (lines.length === 0) return;
  }
  handleCommand(state, { type: "order.submit", lines, storeId: store.id }, noop);
}

/** Stretch for a growth purchase the §10 way: draw the shortfall from the
 *  bank when the credit line covers it — the arc's late buys (L5, the
 *  lots, the depot) are financed, not saved for. True when `amount` is in
 *  the till afterward. */
function ensureCash(state: GameState, amount: number): boolean {
  if (state.cash >= amount) return true;
  const bank = bankStatus(state);
  if (bank.lock !== null) return false;
  const need = Math.ceil(amount - state.cash);
  if (need > bank.available - bank.limit * BANK_HEADROOM) return false;
  handleCommand(state, { type: "loan.draw", amount: need }, noop);
  return state.cash >= amount;
}

/** One morning of the scripted policy, in a working owner's order: the
 *  shelves get stocked first, the crew second, and growth — licenses,
 *  gear, renovation, branches, the depot — spends only what is left. */
function runMorningPolicy(state: GameState): void {
  // Day 1: the fixtures a real founding week buys — a verify desk, more
  // shelving, chairs. Off-screen they are a cash sink only (the §19
  // resolver reads staff, not stations), but the arc's early windows
  // assume this spend, and the harness must carry it too.
  if (state.day === 1) {
    const home = state.stores[0]!;
    for (const defId of ["verify_desk", "otc_shelf", "otc_shelf", "rx_shelf", "chair_waiting", "chair_waiting"]) {
      buyFixture(state, home, defId);
    }
  }

  // Dig out before anything else (§10 soft-fail): with Aunt Rosa already
  // in and the till still under water, the newest luxury hire goes — a
  // player trims wages rather than spiral.
  if (state.cash < 0 && state.loans.family > 0) {
    const home = state.stores[0]!;
    const cut = [...home.staff]
      .reverse()
      .find((m) => m.role === "pharmacist" || m.role === "cashier");
    if (cut) handleCommand(state, { type: "staff.fire", staffId: cut.id, storeId: home.id }, noop);
  }

  for (const store of state.stores) orderForStore(state, store);

  if (state.day >= HIRE_FROM_DAY) {
    for (const store of state.stores) hireForStore(state, store);
  }

  // The first floor expansion (§6, $4k) early — the shelf space a real
  // week-one founder buys; off-screen it is the arc's cash sink only.
  const founding = state.stores[0]!;
  if (state.day >= 3 && founding.grid.expansions === 0 && state.phase === "morning") {
    if (state.cash >= 4_000 + RESERVE + LICENSE_MARGIN) {
      handleCommand(state, { type: "expansion.buy" }, noop);
    }
  }

  for (const id of LICENSE_ORDER) {
    if (ownsLicense(state, id)) continue;
    // Gen 2 comes before the L3/L4 spends (§26 arc: Gen 2 ~15) — the
    // family business gets its teal before the cabinet and the needles.
    if ((id === "L3" || id === "L4") && state.stores[0]!.era < 2) break;
    const def = licenseDef(id);
    // The non-cash gates first (stars, prerequisites, branch count) — a
    // loan must never be drawn for a certificate the board would refuse.
    const shown = Math.round(networkStars(state) * 10) / 10;
    if (def.stars > 0 && shown < def.stars) break;
    if (def.needsLicense !== undefined && !ownsLicense(state, def.needsLicense)) break;
    if (def.needsBranches !== undefined && state.stores.length < def.needsBranches) break;
    if (!ensureCash(state, def.cost + RESERVE + LICENSE_MARGIN)) break;
    handleCommand(state, { type: "license.buy", id }, noop);
    if (!ownsLicense(state, id)) break; // refused — stop climbing
  }

  for (const store of state.stores) buyGear(state, store);

  // Renovate the founding store up the tiers (Gen 2 ~15 on the §26 arc).
  // Capability buys the look, never the other way round: each tier waits
  // for the license rung a player would put first, and for a crew to hold
  // the floor while the money goes to walls.
  // Gen 4's $40k waits for L5: branches out-earn a reskin, so the arc
  // buys the network first and the Modern Clinic after.
  const home = state.stores[0]!;
  if (
    home === activeStore(state) &&
    home.pendingEra === null &&
    home.era < 4 &&
    home.staff.length >= 1
  ) {
    // Gen 3 and Gen 4 wait for L5: the network out-earns a reskin, so the
    // capstone licenses spend first (§26 arc: L5 35–45).
    const gate = (["L2", "L5", "L5"] as const)[home.era - 1]!;
    const cost = eraDef(home.era + 1).cost;
    if (ownsLicense(state, gate) && ensureCash(state, cost + RESERVE + BIG_PURCHASE_MARGIN)) {
      handleCommand(state, { type: "era.renovate" }, noop);
    }
  }

  // After L5: up to two branches, cheapest lots first (L6 needs two doors).
  if (ownsLicense(state, "L5") && state.stores.length < 3) {
    const taken = new Set(
      state.stores.filter((s) => !isFoundingStore(state, s)).map((s) => s.districtId),
    );
    const lots = DISTRICTS.map((d) => d.id)
      .filter((id) => !taken.has(id))
      .sort((a, b) => branchPrice(a).total - branchPrice(b).total);
    const lot = lots[0];
    if (
      lot !== undefined &&
      ensureCash(state, branchPrice(lot).total + RESERVE + BIG_PURCHASE_MARGIN)
    ) {
      handleCommand(state, { type: "branch.buy", districtId: lot }, noop);
    }
  }

  if (
    ownsLicense(state, "L6") &&
    state.dc === null &&
    ensureCash(state, DC_COST + RESERVE + BIG_PURCHASE_MARGIN)
  ) {
    handleCommand(state, { type: "dc.buy" }, noop);
  }
}

/** Scale a routed day's slices in place — the §7 door conversion the
 *  visited schedule applies on top of §17 routing (beginDay's math). */
function scaleDemand(demand: BranchDemand, mult: number): void {
  for (const slice of demand.otc) slice.count *= mult;
  for (const slice of demand.rx) slice.count *= mult;
  demand.otcTotal *= mult;
  demand.rxTotal *= mult;
}

/** The §14 shot service on the active floor — the §19 resolver skips
 *  vaccinations, but the owner's day genuinely earns them. */
function vaccinateAtActive(state: GameState, store: StoreState): void {
  if (store.pendingEra !== null || !vaccinationUnlocked(state, store)) return;
  const walkins = Math.round(
    (VACCINE_WALKINS_MIN + Math.floor(Math.random() * (VACCINE_WALKINS_MAX - VACCINE_WALKINS_MIN + 1))) *
      vaccineWalkinMult(state),
  );
  let given = 0;
  for (let i = 0; i < walkins; i++) {
    const line = store.stock[VACCINE_DOSE_ID];
    if (!line || line.backroom + line.shelved <= 0) break;
    if (line.shelved > 0) line.shelved--;
    else line.backroom--;
    given++;
  }
  if (given > 0) post(state, "vaccine", given * VACCINE_REIMBURSEMENT, noop);
}

/** Resolve every store's day off-screen — the §19 formula for the whole
 *  network, the owner's stand-in hands and §7 door scaling on the active
 *  floor (repMult × the season's visitor pull, as beginDay applies). */
function resolveDay(state: GameState): { demand: number; served: number } {
  // Snapshot demand before any store resolves (resolveUnvisitedBranches'
  // own order rule: each resolution moves live routing inputs).
  const active = activeStore(state);
  const days: { store: StoreState; demand: BranchDemand | null }[] = state.stores.map(
    (store) => ({
      store,
      demand: store.pendingEra !== null ? null : routedBranchDay(state, store),
    }),
  );
  for (const entry of days) {
    if (entry.store !== active || entry.demand === null) continue;
    scaleDemand(
      entry.demand,
      (REP_MULT_BASE + REP_MULT_PER_STAR * active.repStars) * seasonVisitorMultOn(state.day),
    );
  }
  active.staff.push(...OWNER_HANDS.map((m) => ({ ...m })));
  let demand = 0;
  let served = 0;
  try {
    for (const entry of days) {
      resolveBranchDay(state, entry.store, entry.demand, noop);
      const summary = entry.store.daySummary;
      if (summary) {
        demand += summary.demand;
        served += summary.served;
      }
    }
    vaccinateAtActive(state, active);
  } finally {
    active.staff = active.staff.filter((m) => !m.id.startsWith("owner-"));
  }
  return { demand, served };
}

/**
 * Run a fresh, seeded game N days forward off-screen. Deterministic per
 * seed: the whole run shares one PRNG (Math.random is swapped for the
 * duration and always restored).
 */
export function runHarness(seed = 1, days = 56): HarnessReport {
  const realRandom = Math.random;
  Math.random = mulberry32(seed ^ 0x5eed5eed);
  try {
    const state = createGameState();
    ensurePlanned(state);
    ensurePatientPools(state);
    refreshHiringPool(state);

    let familyLoanDays = 0;
    const log: HarnessDayLog[] = [];

    for (let i = 0; i < days; i++) {
      runMorningPolicy(state);
      const { demand, served } = resolveDay(state);
      const close = closeDay(state, noop);
      if (close.familyLoan > 0) {
        familyLoanDays++;
        // §15's −0.3 lands on the store the player runs (sim.ts's rule).
        const store = activeStore(state);
        store.repStars = Math.max(0, store.repStars - 0.3);
      }
      if (operatingProfit(state.dayStats) > 0) recordMoment(state, "first_profit", noop);
      rollCityDay(state);
      log.push({
        day: state.day,
        cash: Math.round(state.cash),
        stars: Math.round(state.stores[0]!.repStars * 10) / 10,
        demand,
        served,
        stores: state.stores.length,
        bank: Math.round(state.loans.bank),
        bankLimit: bankStatus(state).limit,
      });
      // Deliberate step around the phase machine: the real close is Sim's
      // tick loop (customers drained, drift, rollHistory) and the harness
      // just resolved that day off-screen above — this write only satisfies
      // day.advance's phase guard so beginMorning runs the true turnover.
      // If day.advance ever gains a precondition beyond the phase check,
      // this line must learn it too.
      state.phase = "close";
      handleCommand(state, { type: "day.advance" }, noop);
    }

    const moment = (id: string): number | null =>
      state.legacy.find((m) => m.id === id)?.day ?? null;
    const stat = (key: string): number | null => state.stats[key] ?? null;
    const arc = {
      firstHire: moment("first_hire"),
      l2: stat("license.L2"),
      gen2: stat("era.2"),
      l3: stat("license.L3"),
      l4: stat("license.L4"),
      gen4: stat("era.4"),
      l5: stat("license.L5"),
      firstBranch: moment("first_branch"),
      l6: stat("license.L6"),
      dc: stat("dc.built"),
      firstProfit: moment("first_profit"),
    };
    const fmt = (v: number | null): string => (v === null ? "—" : `day ${v}`);
    const summary = [
      `seed ${seed} · ${days} days · end cash $${Math.round(state.cash).toLocaleString("en-US")} · ${state.stores.length} stores · family-loan days ${familyLoanDays}`,
      `first profit ${fmt(arc.firstProfit)} · first hire ${fmt(arc.firstHire)} (target 6–9)`,
      `L2 ${fmt(arc.l2)} (target 10–14) · Gen 2 ${fmt(arc.gen2)} (target ~15)`,
      `L3 ${fmt(arc.l3)} · L4 ${fmt(arc.l4)} · Gen 4 ${fmt(arc.gen4)}`,
      `L5 ${fmt(arc.l5)} (target 35–45) · branch ${fmt(arc.firstBranch)} · L6 ${fmt(arc.l6)} · DC ${fmt(arc.dc)} (target 50+)`,
    ].join("\n");

    return {
      seed,
      days,
      arc,
      familyLoanDays,
      endCash: Math.round(state.cash),
      endStars: Math.round(state.stores[0]!.repStars * 10) / 10,
      storeCount: state.stores.length,
      log,
      summary,
    };
  } finally {
    Math.random = realRandom;
  }
}
