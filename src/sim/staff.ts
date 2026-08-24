// Staff data (SPEC §9, §15, §24, §26): the StaffMember shape, the wage /
// duration / error / catch tables, and the weekly hiring pool — 3 candidates
// per role, drawn by a seeded RNG every Monday morning, stat quality scaling
// with reputation (§15 hiring-pool gate). The walking, working NPC layer
// lives in staffSystem.ts. Pure sim — no DOM, no three.js.

import { FIRST_NAMES, LAST_NAMES } from "../data/names";
import { networkStars, type GameState } from "./state";

export type StaffRole = "cashier" | "tech" | "pharmacist" | "manager";
export type StaffTrait = "meticulous" | "swift" | "charming" | "stockhawk" | "pennywise";
export type StatValue = 1 | 2 | 3 | 4 | 5;

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  speed: StatValue;
  accuracy: StatValue;
  /** Rolled, saved and shown, but with no live modifier: §9 names warmth a
   *  "satisfaction bonus" and §26 gives it no magnitude, so it stays inert
   *  until a milestone defines one (it also feeds §26's managerFactor
   *  statTotal for future branches). */
  warmth: StatValue;
  trait: StaffTrait;
  dailyWage: number;
  hiredOnDay: number;
  assignment?: { stationId: string };
}

/** A face in the applications pile — a StaffMember without a start date. */
export interface StaffCandidate {
  id: string;
  name: string;
  role: StaffRole;
  speed: StatValue;
  accuracy: StatValue;
  warmth: StatValue;
  trait: StaffTrait;
  wageAsked: number;
}

/** The week's applications. `refreshedOnDay` 0 = never drawn (migrated save). */
export interface HiringPool {
  /** Per-save salt so two runs never meet the same applicants. */
  seed: number;
  refreshedOnDay: number;
  candidates: StaffCandidate[];
}

// --- §26 tables (authoritative) ---

// M16 balancing: −20% from the launch 90/140/280/220 — at observed visit
// volumes a staffed store ran at a loss, and wages were the dominant cost
// (docs/balance-notes.md).
export const WAGES: Record<StaffRole, number> = {
  cashier: 72,
  tech: 112,
  pharmacist: 224,
  manager: 176,
};

/** Task duration multiplier by speed stat 1–5. */
const SPEED_CURVE = [1.4, 1.2, 1.0, 0.85, 0.7] as const;

/** Tech fill mis-pick % by accuracy stat 1–5 (player picks bins manually). */
const FILL_ERROR_PCT = [7.5, 6.0, 4.5, 3.0, 1.5] as const;

/** Pharmacist verify catch % by accuracy stat 1–5. */
const VERIFY_CATCH_PCT = [75, 80, 85, 90, 95] as const;

/** §8/§26: the owner's catch rate — working the desk, or implicit at handoff. */
export const OWNER_CATCH_RATE = 0.9;

export const PENNYWISE_WAGE_MULT = 0.85;
const SWIFT_ERROR_BONUS_PCT = 2;

/** Stations each role can be assigned to (§9 roles). Managers hold no
 *  station — they run the whole branch while it's unvisited (§19/§26). */
export const ROLE_STATIONS: Record<StaffRole, readonly string[]> = {
  cashier: ["counter_register", "counter_service"],
  tech: ["fill_bench"],
  pharmacist: ["verify_desk", "vaccine_station"],
  manager: [],
};

/** Every §9 role applies, managers included (M14: the role is live). */
export const HIREABLE_ROLES: readonly StaffRole[] = [
  "cashier",
  "tech",
  "pharmacist",
  "manager",
];

export const POOL_PER_ROLE = 3;

/** §9 traits + §26 speed curve folded into one task-duration multiplier. */
export function taskDuration(member: StaffMember, baseIgm: number): number {
  let mult = SPEED_CURVE[member.speed - 1]!;
  if (member.trait === "meticulous") mult *= 1.2;
  else if (member.trait === "swift") mult *= 0.8;
  return baseIgm * mult;
}

/** Probability [0,1] this tech pulls the wrong bin (§26; Meticulous never). */
export function fillErrorRate(member: StaffMember): number {
  if (member.trait === "meticulous") return 0;
  let pct = FILL_ERROR_PCT[member.accuracy - 1]!;
  if (member.trait === "swift") pct += SWIFT_ERROR_BONUS_PCT;
  return pct / 100;
}

/** Probability [0,1] this pharmacist catches a wrong fill at the desk (§26). */
export function verifyCatchRate(member: StaffMember): number {
  return VERIFY_CATCH_PCT[member.accuracy - 1]! / 100;
}

// --- Calendar (§5): day 1 is a Monday; pools refresh with the week ---

export function mondayOf(day: number): number {
  return day - ((day - 1) % 7);
}

// --- Seeded candidate draw ---

/** mulberry32 — small, seedable, plenty for drawing applicants. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRAITS: readonly StaffTrait[] = ["meticulous", "swift", "charming", "stockhawk", "pennywise"];

/** One stat roll: mean rises with reputation (§15 quality gate), jitter ±1.2. */
function rollStat(rng: () => number, repStars: number): StatValue {
  const mean = 1.5 + repStars * 0.55;
  const value = Math.round(mean + (rng() * 2.4 - 1.2));
  return Math.min(5, Math.max(1, value)) as StatValue;
}

function rollCandidate(
  rng: () => number,
  role: StaffRole,
  repStars: number,
  id: string,
): StaffCandidate {
  const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!;
  const trait = TRAITS[Math.floor(rng() * TRAITS.length)]!;
  const wage = WAGES[role] * (trait === "pennywise" ? PENNYWISE_WAGE_MULT : 1);
  return {
    id,
    name: `${first} ${last}`,
    role,
    speed: rollStat(rng, repStars),
    accuracy: rollStat(rng, repStars),
    warmth: rollStat(rng, repStars),
    trait,
    wageAsked: Math.round(wage),
  };
}

/**
 * Redraw the pool if a Monday has passed since the last draw (or it has never
 * been drawn — new games and migrated saves alike). Returns true on a redraw.
 * Deterministic per save + week + reputation: reloading a morning cannot
 * reroll the counter.
 */
export function refreshHiringPool(state: GameState): boolean {
  const monday = mondayOf(state.day);
  // A pool drawn before a role became hireable (a pre-M14 save loaded
  // mid-week) would wait out the week with an empty Managers section right
  // after the first branch made one matter. Redraw early when a hireable
  // role has neither a candidate nor a hire anywhere — and only then: a
  // role emptied by hiring is on the roster, and the same week draws the
  // same seed, so forcing a redraw can never farm fresh cards.
  const missingRole = HIREABLE_ROLES.some(
    (role) =>
      !state.hiring.candidates.some((c) => c.role === role) &&
      !state.stores.some((s) => s.staff.some((m) => m.role === role)),
  );
  if (state.hiring.refreshedOnDay >= monday && !missingRole) return false;

  // Candidates apply to the name, so quality follows the network's
  // best-known store (§9/§19 networkStars).
  const stars = networkStars(state);
  const seed =
    (state.hiring.seed ^ Math.imul(monday, 2654435761) ^ Math.round(stars * 10) * 40503) >>> 0;
  const rng = mulberry32(seed);
  const candidates: StaffCandidate[] = [];
  for (const role of HIREABLE_ROLES) {
    for (let i = 0; i < POOL_PER_ROLE; i++) {
      candidates.push(rollCandidate(rng, role, stars, `a${monday}-${role}-${i + 1}`));
    }
  }
  state.hiring.refreshedOnDay = monday;
  // A mid-week redraw regenerates this week's ids — cards already hired
  // stay off the pile, or a second hire would seat a duplicate id.
  const hired = new Set<string>();
  for (const store of state.stores) {
    for (const member of store.staff) hired.add(member.id);
  }
  state.hiring.candidates = candidates.filter((c) => !hired.has(c.id));
  return true;
}

/** Copy names for panel/toast copy — §28 plain language. */
export const ROLE_LABELS: Record<StaffRole, string> = {
  cashier: "cashier",
  tech: "pharmacy tech",
  pharmacist: "pharmacist",
  manager: "manager",
};

export const TRAIT_LABELS: Record<StaffTrait, string> = {
  meticulous: "Meticulous",
  swift: "Swift",
  charming: "Charming",
  stockhawk: "Stock Hawk",
  pennywise: "Penny-wise",
};

/** What each trait does, said the way the panel says it (§28 copy voice). */
export const TRAIT_NOTES: Record<StaffTrait, string> = {
  meticulous: "never mis-fills · works 20% slower",
  swift: "works 20% faster · mis-fills a little more",
  charming: "small reputation bump on every chat and checkout",
  stockhawk: "restocks shelves and bins between tasks",
  pennywise: "asks 15% less wage",
};
