// Customer simulation (SPEC §7, §8, §14, §15, §17, §26): district-driven
// arrival scheduling with rush bumps, archetypes, the browse → queue → pay →
// exit state machine for OTC shoppers, the drop-off → wait (sit/browse) →
// pickup flow for Rx patients, vaccine walk-ins queuing at the station for
// their 15 igm shot, patience with chair relief, walk-outs, shelf stock
// decrement, and station service while the player works registers, the
// service counter, or the fill bench. Pure sim — no DOM, no three.js.
// Customer objects are pooled; the per-tick path is allocation-free.

import { DAY_START_IGM, IGM_PER_TICK } from "../core/clock";
import { cellIndex, doorCells, FACING, footprintRect } from "../core/grid";
import { Pathfinder } from "../core/pathfind";
import { districtById } from "../data/districts";
import { drugDef, TIER1_DRUGS } from "../data/drugs";
import { furnitureDef } from "../data/furniture";
import { randomFullName } from "../data/names";
import { otcDef } from "../data/otc";
import {
  VACCINE_DOSE_ID,
  VACCINE_IGM,
  VACCINE_REIMBURSEMENT,
  VACCINE_WALKINS_MAX,
  VACCINE_WALKINS_MIN,
  vaccinationUnlocked,
} from "./coldchain";
import { COPAY, post, STORE_DISTRICT_ID } from "./economy";
import type { SimEvent } from "./events";
import { otcDemandMult, rxDemandMult, vaccineWalkinMult, visitorMult } from "./events-world";
import { drugDailyDemand, fillableDrugs } from "./licenses";
import {
  balksAt,
  otcPrice,
  priceMultiplier,
  recordBalk,
  recordSale,
  recordStockOut,
  returnShelved,
  shelvedUnits,
  takeShelved,
} from "./inventory";
import { backroomZone } from "./placement";
import type { StaffSystem, StationWorker } from "./staffSystem";
import type { GameState, PlacedFurniture } from "./state";
import type { RxWorkflow } from "./workflow";

export type Archetype = "hurried" | "steady" | "bargain" | "chatty";

export type CustomerKind = "otc" | "rx" | "vaccine";

export type CustomerMode =
  | "enter" // outside → door cell
  | "toShelf"
  | "browse"
  | "toQueue" // walking to an assigned queue slot (patience drains)
  | "queue" // standing at the slot (patience drains)
  | "toChair" // walking to a reserved waiting chair (patience drains)
  | "sit" // seated (half drain, §26)
  | "rxWait" // standing around waiting on a script (full drain, §7)
  | "pay" // being served at a station (patience frozen)
  | "leave"; // walking out (calm or angry)

/** Modes during which the overhead patience ring is shown. */
const WAITING_MODES: ReadonlySet<CustomerMode> = new Set([
  "toQueue",
  "queue",
  "toChair",
  "sit",
  "rxWait",
  "pay",
]);

/** Ring rule for the render layer: waiting modes, plus Rx patients killing
 *  time on the shelves while their script is in the pipeline (§7). */
export function showsPatienceRing(c: Customer): boolean {
  if (WAITING_MODES.has(c.mode)) return true;
  return c.scriptId !== 0 && (c.mode === "toShelf" || c.mode === "browse");
}

export interface BasketLine {
  skuId: string;
  shelfId: string;
  price: number;
}

export interface Customer {
  /** Stable pool slot (drives cell-claim ownership). */
  poolIndex: number;
  /** Unique per spawn (event payloads). */
  id: number;
  active: boolean;
  name: string;
  archetype: Archetype;
  kind: CustomerKind;
  mode: CustomerMode;
  /** Active RxScript id, or 0 (Rx patients only). */
  scriptId: number;
  /** Igm since drop-off; ≥60 starts the waiting-room browse (§7). */
  waitIgm: number;
  /** The one waiting-room browse round has been taken. */
  hasBrowsed: boolean;
  /** Pickup is done; the 10 igm counsel chat is running (§8, chatty). */
  counseling: boolean;
  /** Continuous cell coordinates (integers = cell centers). */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  yaw: number;
  prevYaw: number;
  /** Accumulated walk distance, for the render-side bob phase. */
  stride: number;
  prevStride: number;
  /** Render color seeds (art palette lives render-side, §27). */
  seedA: number;
  seedB: number;
  patience: number;
  maxPatience: number;
  basket: BasketLine[];
  targets: string[]; // otc shelf furniture ids
  targetIdx: number;
  browseLeft: number;
  laneId: string | null;
  chairId: string | null;
  hasBag: boolean;
  angry: boolean;
  serveLeft: number;
  // Movement
  path: number[];
  pathIdx: number;
  destCell: number;
  offX: number;
  offY: number;
  hasOffTarget: boolean;
  claimA: number;
  claimB: number;
  blockedIgm: number;
}

type Emit = (event: SimEvent) => void;

// --- Tuning (§7, §16, §26, §30) ---

const NPC_CAP = 40;
const SPAWN_END_IGM = 1170; // 19:30 (§5)
/** §16/§26 rush windows — exported so the clock strip's shading (§28) and
 *  the arrival sampler can never drift apart; deeply readonly so the shared
 *  reference genuinely cannot. */
export const RUSH_WINDOWS: readonly (readonly [number, number])[] = [
  [720, 840], // 12:00–14:00
  [1020, 1140], // 17:00–19:00
];
const RUSH_MULT = 1.6;

/**
 * The store's slice of Old Town demand until §17 routing lands (M12/13),
 * tuned to the §26 baseline: 20 visitors/day at 2.5★ with the Tier-1
 * formulary, mixed ~65% OTC / ~35% Rx. OTC intent and Rx generation are
 * separate §17 streams, so each gets its own share constant — and the Rx
 * side is anchored to Tier-1 coverage, which is what makes a new license
 * grow the day naturally: more fillable categories, more scripts routed
 * here, no artificial multiplier (milestone 08).
 */
const BASE_OTC_VISITORS = 13; // 20 × 0.65 (§26 mix)
const BASE_RX_VISITORS = 7; // 20 × 0.35
const OLD_TOWN = districtById(STORE_DISTRICT_ID);
const OTC_SHARE = BASE_OTC_VISITORS / ((OLD_TOWN.population / 1000) * OLD_TOWN.otcIntent);
// Anchored to the same predicate the generator draws with (fillableDrugs at
// L1 = Tier 1 minus refrigerated), so a future cold-chain Tier-1 SKU can't
// silently detune the baseline.
const RX_SHARE_TUNE =
  BASE_RX_VISITORS /
  TIER1_DRUGS.filter((def) => !def.refrigerated).reduce(
    (sum, def) => sum + drugDailyDemand(OLD_TOWN, def),
    0,
  );

const WALK_SPEED = 0.5; // cells per igm ≈ 1.2 m/s at 1×
const ANGRY_SPEED = 0.68;
const CHECKOUT_IGM = 4; // §26: register checkout and Rx pickup
const DROPOFF_IGM = 3; // handing a script across the counter
const COUNSEL_IGM = 10; // §26 counsel duration (chatty pickups)
const BLOCKED_REPATH_IGM = 7.2; // 3 real s at 1× (§6)
const SIT_QUEUE_POS = 3; // queue position from which customers grab a chair
const STAND_QUEUE_POS = 1; // seated customers rejoin the line at this position
const QUEUE_MAX_SLOTS = 12;
const BASKET_MAX = 4;
const EXTRA_ITEM_CHANCE = 0.6;
const RX_BROWSE_WAIT_IGM = 60; // §7: waiting Rx patients start browsing
const COUNSEL_BASKET_CHANCE = 0.5; // §8: +$4 basket chance after counsel
const COUNSEL_BASKET_VALUE = 4;
const REP_SERVE = 0.02;
const REP_COUNSEL = 0.03;
const REP_VACCINE = 0.01; // §26: +0.01 a shot
const REP_WALKOUT = -0.06;
const REP_WALKOUT_HURRIED = -0.09;
const REP_REFUSED = -0.08; // §15 unfillable script (stock-out)
const REP_ERROR = -0.15; // §15 dispensed error
const REP_CHARMING = 0.01; // §9 Charming trait, per counsel or checkout

/** Receipt copy for §15 reasons — action names stay identical everywhere (§28). */
export const REP_REASONS = {
  serve: "Happy serves",
  counsel: "Counsel chats",
  vaccine: "Vaccinations",
  walkout: "Walk-outs",
  refused: "Scripts refused",
  error: "Dispensing errors",
  familyLoan: "Family loan",
  charming: "Charming touch",
  drift: "Word settles",
} as const;

interface ArchetypeDef {
  id: Archetype;
  share: number;
  patience: number;
  targetsMin: number;
  targetsMax: number;
  browseMin: number;
  browseMax: number;
}

/** §7 archetype table. Hurried grab one thing and won't linger. */
const ARCHETYPES: readonly ArchetypeDef[] = [
  { id: "hurried", share: 0.25, patience: 45, targetsMin: 1, targetsMax: 1, browseMin: 1.5, browseMax: 3 },
  { id: "steady", share: 0.35, patience: 90, targetsMin: 1, targetsMax: 2, browseMin: 4, browseMax: 8 },
  { id: "bargain", share: 0.2, patience: 90, targetsMin: 2, targetsMax: 3, browseMin: 4, browseMax: 8 },
  { id: "chatty", share: 0.2, patience: 150, targetsMin: 2, targetsMax: 4, browseMin: 5, browseMax: 10 },
];

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickArchetype(): ArchetypeDef {
  let u = Math.random();
  for (const def of ARCHETYPES) {
    u -= def.share;
    if (u <= 0) return def;
  }
  return ARCHETYPES[ARCHETYPES.length - 1]!;
}

/** Apply a §15 reputation delta: clamp, tally by reason for the receipt, emit. */
export function applyRep(state: GameState, delta: number, emit: Emit, reason: string): void {
  const next = Math.min(5, Math.max(0, state.repStars + delta));
  const applied = next - state.repStars;
  if (applied === 0) return;
  state.repStars = next;
  state.dayStats.repDelta += applied;
  const tally = (state.dayStats.repReasons[reason] ??= { count: 0, delta: 0 });
  tally.count++;
  tally.delta += applied;
  emit({ type: "rep.changed", stars: state.repStars, delta: applied });
}

export class CustomerSystem {
  // Cell-indexed world — assigned by resizeGrid (constructor + expansion).
  private cols!: number;
  private rows!: number;
  private pathfinder!: Pathfinder;
  /** Cells customers may path through: public zone minus furniture. */
  private staticWalk!: Uint8Array;
  private scratchWalk!: Uint8Array;
  /** Per-cell claim: poolIndex + 1, or 0 (door cells stay unclaimed). */
  private occupied!: Int32Array;
  private doorExempt!: Uint8Array;
  private doors!: [number, number][];

  private pool: Customer[] = [];
  private freeSlots: number[] = [];
  private nextId = 1;
  private activeCountInternal = 0;

  private queues = new Map<string, Customer[]>();
  private queueSlots = new Map<string, number[]>();
  private chairOccupants = new Map<string, number>(); // chairId → poolIndex

  private arrivals: number[] = [];
  private arrivalIdx = 0;
  /** §14/§26 vaccine walk-ins: their own 3–6/day schedule once the service
   *  exists — the §7 mix's 5% slice, kept apart from the demand streams. */
  private vaccineArrivals: number[] = [];
  private vaccineIdx = 0;
  /** Today's Rx slice of the visitor mix — set by beginDay from formulary
   *  breadth (§17); starts at the §26 baseline for a mid-morning load. */
  private rxShare = 0.35;
  private stressLevel = 0; // 0..3 → ×1 / ×3 / ×9 / ×27 spawn multiplier
  private pathScratch: number[] = [];
  /** Bound after construction (Sim wires the two systems together, §9). */
  private staff: StaffSystem | null = null;
  /** Charming counselor flags for chats in progress, by customer id. */
  private counselCharm = new Set<number>();

  /** Dev/debug: cumulative archetype tally for share verification. */
  readonly archetypeCounts: Record<Archetype, number> = {
    hurried: 0,
    steady: 0,
    bargain: 0,
    chatty: 0,
  };

  constructor(
    state: GameState,
    private workflow: RxWorkflow,
  ) {
    this.resizeGrid(state.store.grid.cols, state.store.grid.rows);
    this.layoutChanged(state);
  }

  /** Allocate every cell-indexed structure for a cols×rows floor. The
   *  constructor and gridChanged both come through here, so a new buffer
   *  can't be added to one and silently missed by the other. */
  private resizeGrid(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pathfinder = new Pathfinder(cols, rows);
    this.staticWalk = new Uint8Array(cols * rows);
    this.scratchWalk = new Uint8Array(cols * rows);
    this.occupied = new Int32Array(cols * rows);
    this.doorExempt = new Uint8Array(cols * rows);
    this.doors = doorCells(cols, rows);
    for (const [x, y] of this.doors) this.doorExempt[cellIndex(cols, x, y)] = 1;
  }

  /** Pooled customer array for render iteration (check `active`). */
  get list(): readonly Customer[] {
    return this.pool;
  }

  get activeCount(): number {
    return this.activeCountInternal;
  }

  queueLength(stationId: string): number {
    return this.queues.get(stationId)?.length ?? 0;
  }

  /** Staffed-era wiring (§9): lets stations be manned by staff, not just
   *  the player, and counsel chats find a stationed pharmacist. Called by
   *  StaffSystem's own constructor, so the pair can't end up half-wired. */
  bindStaff(staff: StaffSystem): void {
    this.staff = staff;
  }

  /** True when this cell is one of any queue line's standing slots. */
  isQueueCell(cell: number): boolean {
    for (const slots of this.queueSlots.values()) {
      if (slots.includes(cell)) return true;
    }
    return false;
  }

  /** True while someone is mid-checkout (or mid-shot) at this station — a
   *  worker walking off mid-serve wastes the customer's progress, so staff
   *  finish first. Called from per-tick staff AI, so the station's lanes
   *  are matched against the live queue keys (`${stationId}#…`) instead of
   *  building every possible lane id per call (§30). */
  frontIsPaying(stationId: string): boolean {
    if (this.queues.get(stationId)?.[0]?.mode === "pay") return true;
    for (const [laneId, q] of this.queues) {
      if (
        q[0]?.mode === "pay" &&
        laneId.length > stationId.length &&
        laneId.charCodeAt(stationId.length) === 0x23 && // '#'
        laneId.startsWith(stationId)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whoever is behind this station: the player (base speed), a staffer
   *  (their §26 speed curve × trait), or nobody. */
  private stationWorker(state: GameState, stationId: string): StationWorker | null {
    if (state.workingStationId === stationId && !state.buildMode) {
      return { mult: 1, charming: false };
    }
    return this.staff?.workerAt(stationId) ?? null;
  }

  // --- Day scheduling (§7, §17, §26) ---

  beginDay(state: GameState): void {
    // Two §17 streams share the day: OTC intent, and the Rx scripts the
    // store's licenses and equipment can actually capture (§12, milestone 08).
    // §16 seasons lean on the Rx side per category — flu season's ×1.8 on
    // respiratory and antibiotics genuinely brings more patients through
    // the door, the same way a new license does.
    const otcVisitors = (OLD_TOWN.population / 1000) * OLD_TOWN.otcIntent * OTC_SHARE;
    let rxVisitors = 0;
    for (const def of fillableDrugs(state)) {
      rxVisitors += drugDailyDemand(OLD_TOWN, def) * rxDemandMult(state, def.category);
    }
    rxVisitors *= RX_SHARE_TUNE;
    this.rxShare = rxVisitors / (otcVisitors + rxVisitors);

    const repMult = 0.4 + 0.24 * state.repStars;
    const dayNoise = randRange(0.85, 1.15);
    // §16/§26 on the whole door: the summer lull, the winter crowd, and a
    // storm day's ×0.6 all scale today's schedule.
    let n = Math.round((otcVisitors + rxVisitors) * repMult * dayNoise * visitorMult(state));
    n *= 3 ** this.stressLevel;
    this.arrivals = this.sampleArrivals(n, DAY_START_IGM);
    this.arrivalIdx = 0;

    // §14/§26: 3–6 vaccine walk-ins a day once L4, fridge and station stand,
    // on the same rush curve as everyone else — and ×4 through flu season.
    this.vaccineArrivals = vaccinationUnlocked(state)
      ? this.sampleArrivals(
          Math.round(randInt(VACCINE_WALKINS_MIN, VACCINE_WALKINS_MAX) * vaccineWalkinMult(state)),
          DAY_START_IGM,
        )
      : [];
    this.vaccineIdx = 0;
  }

  /** §13 renovation: the store is closed for the rest of today. Whoever is
   *  already inside finishes; nobody else comes through the door. */
  cancelArrivals(): void {
    this.arrivals = [];
    this.arrivalIdx = 0;
    this.vaccineArrivals = [];
    this.vaccineIdx = 0;
  }

  /** Dev stress spawner (milestone 03): each N press ×3s the remaining spawn
   *  schedule, cycling ×1 → ×3 → ×9 → ×27 → off so the §30 40-NPC cap is
   *  actually reachable. Returns the new multiplier. */
  cycleStress(state: GameState): number {
    const prevMult = 3 ** this.stressLevel;
    this.stressLevel = (this.stressLevel + 1) % 4;
    const mult = 3 ** this.stressLevel;
    if (state.phase === "shift") {
      const remaining = this.arrivals.length - this.arrivalIdx;
      const target = Math.ceil((remaining / prevMult) * mult);
      const from = Math.max(state.clockIgm, DAY_START_IGM);
      const tail = this.sampleArrivals(target, from);
      this.arrivals = this.arrivals.slice(0, this.arrivalIdx).concat(tail);
    }
    return mult;
  }

  /** Non-uniform arrival times over [from, 19:30] with ×1.6 rush windows. */
  private sampleArrivals(n: number, from: number): number[] {
    const segments: [start: number, end: number, weight: number][] = [];
    let cursor = Math.max(from, DAY_START_IGM);
    const marks = [cursor, ...RUSH_WINDOWS.flat(), SPAWN_END_IGM]
      .filter((m) => m >= cursor && m <= SPAWN_END_IGM)
      .sort((a, b) => a - b);
    for (let i = 0; i < marks.length - 1; i++) {
      const start = marks[i]!;
      const end = marks[i + 1]!;
      if (end <= start) continue;
      const inRush = RUSH_WINDOWS.some(([rs, re]) => start >= rs && end <= re);
      segments.push([start, end, (end - start) * (inRush ? RUSH_MULT : 1)]);
    }
    const total = segments.reduce((sum, [, , w]) => sum + w, 0);
    const times: number[] = [];
    if (total <= 0) return times;
    for (let i = 0; i < n; i++) {
      let u = Math.random() * total;
      for (const [start, end, weight] of segments) {
        if (u <= weight) {
          times.push(start + (u / weight) * (end - start));
          break;
        }
        u -= weight;
      }
    }
    times.sort((a, b) => a - b);
    return times;
  }

  // --- Layout-derived data ---

  /** Service-counter lane keys: one drop-off line, one pickup line (§8). */
  static dropLaneId(counterId: string): string {
    return `${counterId}#drop`;
  }

  static pickLaneId(counterId: string): string {
    return `${counterId}#pick`;
  }

  /** The vaccine station's own short line (§14). The `#` keeps it out of
   *  every register-only sweep, like the counter lanes. */
  static vaxLaneId(stationId: string): string {
    return `${stationId}#vax`;
  }

  /**
   * The counter's two lane cells: the drop-off tray sits on the local-west
   * half of the mesh, pickup on the local-east (render/meshes/furniture.ts).
   */
  static laneCells(counter: PlacedFurniture): { drop: [number, number]; pick: [number, number] } {
    const { cellX: x, cellY: y } = counter;
    switch (counter.rot) {
      case 0:
        return { drop: [x, y], pick: [x + 1, y] };
      case 1:
        return { drop: [x, y + 1], pick: [x, y] };
      case 2:
        return { drop: [x + 1, y], pick: [x, y] };
      case 3:
        return { drop: [x, y], pick: [x, y + 1] };
    }
  }

  /**
   * The floor itself grew (§6 expansion, morning-only so nobody is inside):
   * every cell-indexed structure is sized to cols×rows and cell indices
   * change meaning, so the buffers are rebuilt from the new grid before the
   * usual layout re-derivation runs.
   */
  gridChanged(state: GameState): void {
    const { cols, rows } = state.store.grid;
    if (cols === this.cols && rows === this.rows) return;
    this.resizeGrid(cols, rows);
    this.queues.clear();
    this.chairOccupants.clear();
    this.layoutChanged(state);
  }

  /** Rebuild walkable/queue geometry after any furniture change. */
  layoutChanged(state: GameState, emit: Emit = () => {}): void {
    const { cols } = this;
    this.staticWalk.fill(1);
    for (const item of state.store.furniture) {
      const def = furnitureDef(item.defId);
      if (def.walkable) continue;
      const rect = footprintRect(def.cells, item.cellX, item.cellY, item.rot);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          this.staticWalk[cellIndex(cols, x, y)] = 0;
        }
      }
    }
    // Customers keep to the public zone (§6).
    const zone = backroomZone(state);
    if (zone) {
      for (let y = zone.y; y < zone.y + zone.h; y++) {
        for (let x = zone.x; x < zone.x + zone.w; x++) {
          this.staticWalk[cellIndex(cols, x, y)] = 0;
        }
      }
    }

    // Queue slot lines: one per register, two lanes per service counter, one
    // short line per vaccine station (§14). Placement only guarantees *some*
    // reachable neighbor of a footprint, not the exact front cell a line
    // seeds from — so every lane falls back to any open side rather than
    // ever standing with zero slots, silently turning customers away.
    this.queueSlots.clear();
    for (const item of state.store.furniture) {
      const [fx, fy] = FACING[item.rot]!;
      if (item.defId === "counter_register") {
        let slots = this.computeSlots(item.cellX + fx, item.cellY + fy, fx, fy, 1);
        if (slots.length === 0) slots = this.fallbackSlots(item);
        this.queueSlots.set(item.id, slots);
      } else if (item.defId === "vaccine_station") {
        // The line forms at the prep-table half — the same local-west cell
        // the counter calls its drop tray (render/meshes/furniture.ts).
        const { drop } = CustomerSystem.laneCells(item);
        let slots = this.computeSlots(drop[0] + fx, drop[1] + fy, fx, fy, 1);
        if (slots.length === 0) slots = this.fallbackSlots(item);
        this.queueSlots.set(CustomerSystem.vaxLaneId(item.id), slots);
      } else if (item.defId === "counter_service") {
        const { drop, pick } = CustomerSystem.laneCells(item);
        // Lanes bend apart so the two lines never share cells; a lane that
        // needs the fallback keeps that guarantee by avoiding its sibling.
        let dropSlots = this.computeSlots(drop[0] + fx, drop[1] + fy, fx, fy, 1);
        let pickSlots = this.computeSlots(pick[0] + fx, pick[1] + fy, fx, fy, -1);
        if (dropSlots.length === 0) dropSlots = this.fallbackSlots(item, new Set(pickSlots));
        if (pickSlots.length === 0) pickSlots = this.fallbackSlots(item, new Set(dropSlots));
        this.queueSlots.set(CustomerSystem.dropLaneId(item.id), dropSlots);
        this.queueSlots.set(CustomerSystem.pickLaneId(item.id), pickSlots);
      }
    }

    // Disband queues whose station vanished; cancel any scripts they held.
    for (const [laneId, q] of this.queues) {
      if (this.queueSlots.has(laneId)) continue;
      for (const member of [...q]) {
        this.removeFromQueue(member);
        this.cancelScript(state, member, emit);
        this.returnBasket(state, member);
        this.beginLeave(member, false);
      }
      this.queues.delete(laneId);
    }

    // Script waiters lose their pipeline if the service counter is gone.
    const counterExists = state.store.furniture.some((f) => f.defId === "counter_service");
    if (!counterExists) {
      for (const c of this.pool) {
        if (!c.active || c.scriptId === 0 || c.laneId !== null || c.mode === "leave") continue;
        this.cancelScript(state, c, emit);
        if (c.chairId) {
          this.chairOccupants.delete(c.chairId);
          c.chairId = null;
        }
        this.returnBasket(state, c);
        this.beginLeave(c, false);
      }
    }
    for (const [chairId, poolIndex] of [...this.chairOccupants]) {
      if (state.store.furniture.some((f) => f.id === chairId)) continue;
      this.chairOccupants.delete(chairId);
      const c = this.pool[poolIndex];
      if (c?.active && (c.mode === "sit" || c.mode === "toChair")) {
        c.chairId = null;
        c.mode = "toQueue"; // refreshQueue below repaths them to a slot
      }
    }

    // Re-route everyone whose destination may have moved.
    for (const c of this.pool) {
      if (!c.active) continue;
      if (c.mode === "toShelf") this.planNextTarget(state, c);
      else if (c.mode === "toChair" && c.chairId) {
        const chair = state.store.furniture.find((f) => f.id === c.chairId);
        if (chair) this.pathToChair(c, chair);
      } else if (c.mode === "rxWait") {
        // The loiter spot may now sit inside new furniture; pick a fresh one.
        this.pathToLoiter(c);
      } else if (c.mode === "leave") this.beginLeave(c, c.angry);
    }
    for (const laneId of this.queues.keys()) this.refreshQueue(laneId);
  }

  /** Last-resort queue seeding when a lane's front cell is walled off: the
   *  first walkable cell touching the fixture's footprint, with the line
   *  walking away from there. `avoid` keeps the fallback (seed and snake
   *  both) off a sibling lane's cells. */
  private fallbackSlots(item: PlacedFurniture, avoid?: ReadonlySet<number>): number[] {
    const { cols, rows } = this;
    const rect = footprintRect(furnitureDef(item.defId).cells, item.cellX, item.cellY, item.rot);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        for (const [dx, dy] of FACING) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const cell = cellIndex(cols, nx, ny);
          if (!this.staticWalk[cell] || avoid?.has(cell)) continue;
          const slots = this.computeSlots(nx, ny, dx, dy, 1, avoid);
          if (slots.length > 0) return slots;
        }
      }
    }
    return [];
  }

  /** Queue slot cells snaking out from a station front (§27). `bend` picks
   *  which perpendicular the line prefers, so paired lanes split apart;
   *  `avoid` (fallback lanes only) hard-excludes a sibling's cells. */
  private computeSlots(
    startX: number,
    startY: number,
    fx: number,
    fy: number,
    bend: -1 | 1,
    avoid?: ReadonlySet<number>,
  ): number[] {
    const { cols, rows } = this;
    const slots: number[] = [];
    let dx = fx;
    let dy = fy;
    let x = startX;
    let y = startY;
    while (slots.length < QUEUE_MAX_SLOTS) {
      const inBounds = x >= 0 && x < cols && y >= 0 && y < rows;
      const cell = inBounds ? cellIndex(cols, x, y) : -1;
      if (!inBounds || !this.staticWalk[cell] || slots.includes(cell) || avoid?.has(cell)) {
        if (slots.length === 0) break;
        // Bend the line: try the two perpendicular directions off the tail.
        const last = slots[slots.length - 1]!;
        const lx = last % cols;
        const ly = (last - lx) / cols;
        let bent = false;
        for (const [ox, oy] of [
          [-dy * bend, dx * bend],
          [dy * bend, -dx * bend],
        ] as const) {
          const nx = lx + ox;
          const ny = ly + oy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const nc = cellIndex(cols, nx, ny);
          if (!this.staticWalk[nc] || slots.includes(nc) || avoid?.has(nc)) continue;
          dx = ox;
          dy = oy;
          x = nx;
          y = ny;
          bent = true;
          break;
        }
        if (!bent) break;
        continue;
      }
      slots.push(cell);
      x += dx;
      y += dy;
    }
    return slots;
  }

  // --- Tick ---

  tick(state: GameState, emit: Emit): void {
    const dIgm = IGM_PER_TICK;

    // Spawn due arrivals (deferred while at the §30 concurrency cap).
    while (this.arrivalIdx < this.arrivals.length && state.clockIgm >= this.arrivals[this.arrivalIdx]!) {
      if (this.arrivals[this.arrivalIdx]! >= SPAWN_END_IGM) {
        this.arrivalIdx++;
        continue;
      }
      if (this.activeCountInternal >= NPC_CAP) {
        this.arrivals[this.arrivalIdx] = state.clockIgm + 5;
        break;
      }
      this.spawn(state, emit);
      this.arrivalIdx++;
    }
    while (
      this.vaccineIdx < this.vaccineArrivals.length &&
      state.clockIgm >= this.vaccineArrivals[this.vaccineIdx]!
    ) {
      if (this.vaccineArrivals[this.vaccineIdx]! >= SPAWN_END_IGM) {
        this.vaccineIdx++;
        continue;
      }
      if (this.activeCountInternal >= NPC_CAP) {
        this.vaccineArrivals[this.vaccineIdx] = state.clockIgm + 5;
        break;
      }
      this.spawn(state, emit, "vaccine");
      this.vaccineIdx++;
    }

    for (const c of this.pool) {
      if (!c.active) continue;
      c.prevX = c.x;
      c.prevY = c.y;
      c.prevYaw = c.yaw;
      c.prevStride = c.stride;
      this.updateCustomer(state, c, dIgm, emit);
    }

    this.serveRegisters(state, dIgm, emit);
    this.serveCounters(state, dIgm, emit);
    this.serveVaccines(state, dIgm, emit);
  }

  /** True when `c` is between drop-off and pickup, waiting on their script. */
  private isScriptWaiting(c: Customer): boolean {
    return c.scriptId !== 0 && c.laneId === null;
  }

  /**
   * Shared per-tick handling for a script waiter: patience drain, ready →
   * pickup lane, wait > 60 igm → waiting-room browse (§7). Returns true when
   * the caller must stop (walked out, or the mode changed underneath it).
   */
  private rxWaitTick(
    state: GameState,
    c: Customer,
    dIgm: number,
    drainRate: number,
    emit: Emit,
  ): boolean {
    if (this.drainPatience(state, c, dIgm, drainRate, emit)) return true;
    c.waitIgm += dIgm;
    const script = this.workflow.script(c.scriptId);
    if (!script) {
      // Safety net: the script vanished — leave quietly.
      c.scriptId = 0;
      this.returnBasket(state, c);
      this.beginLeave(c, false);
      return true;
    }
    if (script.stage === "ready") {
      this.goPickup(state, c, emit);
      return true;
    }
    if (!c.hasBrowsed && c.waitIgm >= RX_BROWSE_WAIT_IGM && (c.mode === "sit" || c.mode === "rxWait")) {
      this.startRxBrowse(state, c);
      return true;
    }
    return false;
  }

  private updateCustomer(state: GameState, c: Customer, dIgm: number, emit: Emit): void {
    switch (c.mode) {
      case "enter":
        if (this.step(c, dIgm)) {
          if (c.kind === "rx") this.goDropoff(state, c, emit);
          else if (c.kind === "vaccine") this.goVaccineQueue(state, c);
          else this.planNextTarget(state, c);
        }
        return;
      case "toShelf":
        if (this.isScriptWaiting(c) && this.rxWaitTick(state, c, dIgm, 1, emit)) return;
        if (this.step(c, dIgm)) {
          const def = ARCHETYPES.find((a) => a.id === c.archetype)!;
          c.browseLeft = randRange(def.browseMin, def.browseMax);
          c.mode = "browse";
        }
        return;
      case "browse":
        if (this.isScriptWaiting(c) && this.rxWaitTick(state, c, dIgm, 1, emit)) return;
        c.browseLeft -= dIgm;
        if (c.browseLeft <= 0) {
          this.finishBrowse(state, c, emit);
          c.targetIdx++;
          this.planNextTarget(state, c);
        }
        return;
      case "toQueue":
        if (this.drainPatience(state, c, dIgm, 1, emit)) return;
        if (this.step(c, dIgm)) c.mode = "queue";
        return;
      case "queue":
        if (this.drainPatience(state, c, dIgm, 1, emit)) return;
        if (this.queuePos(c) >= SIT_QUEUE_POS) this.trySit(state, c);
        return;
      case "toChair":
        if (this.isScriptWaiting(c)) {
          if (this.rxWaitTick(state, c, dIgm, 1, emit)) return;
        } else if (this.drainPatience(state, c, dIgm, 1, emit)) return;
        if (this.step(c, dIgm)) {
          c.mode = "sit";
          if (c.chairId) {
            const chair = state.store.furniture.find((f) => f.id === c.chairId);
            if (chair) {
              const [fx, fy] = FACING[chair.rot]!;
              c.yaw = Math.atan2(fx, fy);
            }
          }
        }
        return;
      case "sit":
        if (this.isScriptWaiting(c)) {
          this.rxWaitTick(state, c, dIgm, 0.5, emit); // §26 seated half drain
          return;
        }
        if (this.drainPatience(state, c, dIgm, 0.5, emit)) return;
        if (this.queuePos(c) <= STAND_QUEUE_POS) this.standUp(c);
        return;
      case "rxWait":
        if (this.rxWaitTick(state, c, dIgm, 1, emit)) return;
        this.step(c, dIgm); // finish walking to the loiter spot
        return;
      case "pay":
        return; // progress lives in serveRegisters/serveCounters
      case "leave":
        if (this.step(c, dIgm)) this.despawn(c);
        return;
    }
  }

  /** Register service (§8, §26): 4 igm per checkout — the player's hands or
   *  a cashier's (×their speed curve). */
  private serveRegisters(state: GameState, dIgm: number, emit: Emit): void {
    for (const [regId, q] of this.queues) {
      if (regId.includes("#")) continue; // counter lanes live in serveCounters
      const front = q[0];
      if (!front) continue;
      const worker = this.stationWorker(state, regId);
      if (!worker) {
        if (front.mode === "pay") front.mode = "queue"; // the till went dark
        continue;
      }
      const slot0 = this.queueSlots.get(regId)?.[0];
      if (slot0 === undefined) continue;
      if (front.mode === "queue" && this.atCell(front, slot0)) {
        front.mode = "pay";
        if (front.serveLeft <= 0) front.serveLeft = CHECKOUT_IGM * worker.mult;
        // Face the counter while paying.
        const reg = state.store.furniture.find((f) => f.id === regId);
        if (reg) {
          const [fx, fy] = FACING[reg.rot]!;
          front.yaw = Math.atan2(-fx, -fy);
        }
      }
      if (front.mode === "pay") {
        front.serveLeft -= dIgm;
        if (front.serveLeft <= 0) this.completeSale(state, front, emit);
      }
    }
  }

  /**
   * Service counter (§8): the player or a cashier works drop-offs and
   * pickups, one patient at a time. Pickup lane first — they have waited
   * the longest.
   */
  private serveCounters(state: GameState, dIgm: number, emit: Emit): void {
    for (const counter of state.store.furniture) {
      if (counter.defId !== "counter_service") continue;
      const worker = this.stationWorker(state, counter.id);
      const lanes = [
        CustomerSystem.pickLaneId(counter.id),
        CustomerSystem.dropLaneId(counter.id),
      ];

      if (!worker) {
        for (const laneId of lanes) {
          const front = this.queues.get(laneId)?.[0];
          if (!front || front.mode !== "pay") continue;
          if (front.counseling) {
            // Counsel cut short — the bag is already handed over; they go.
            front.counseling = false;
            this.counselCharm.delete(front.id);
            this.staff?.endCounsel(counter.id);
            this.leaveQueueStructures(front);
            this.beginLeave(front, false);
          } else {
            front.mode = "queue"; // whoever was serving stepped away
          }
        }
        continue;
      }

      // One pair of hands: continue whoever is mid-serve, else start with pickup.
      let serving: Customer | null = null;
      let servingLane = "";
      for (const laneId of lanes) {
        const front = this.queues.get(laneId)?.[0];
        if (front?.mode === "pay") {
          serving = front;
          servingLane = laneId;
          break;
        }
      }
      if (!serving) {
        for (const laneId of lanes) {
          const front = this.queues.get(laneId)?.[0];
          const slot0 = this.queueSlots.get(laneId)?.[0];
          if (!front || slot0 === undefined) continue;
          if (front.mode !== "queue" || !this.atCell(front, slot0)) continue;
          serving = front;
          servingLane = laneId;
          front.mode = "pay";
          if (front.serveLeft <= 0) {
            front.serveLeft =
              (laneId.endsWith("#pick") ? CHECKOUT_IGM : DROPOFF_IGM) * worker.mult;
          }
          const [fx, fy] = FACING[counter.rot]!;
          front.yaw = Math.atan2(-fx, -fy);
          break;
        }
      }
      if (!serving) continue;

      // A chat waits for its pharmacist to reach the counter (§8); patience
      // stays frozen in the meantime — they're being seen to.
      if (serving.counseling && this.staff && !this.staff.counselorReady(counter.id)) {
        continue;
      }
      serving.serveLeft -= dIgm;
      if (serving.serveLeft > 0) continue;

      if (serving.counseling) this.completeCounsel(state, serving, emit);
      else if (servingLane.endsWith("#pick")) this.completePickup(state, serving, emit);
      else this.completeDropoff(state, serving, emit);
    }
  }

  /**
   * Vaccine station service (§14, §26): 15 igm a shot by whoever staffs the
   * station — the stationed pharmacist, or the player's own hands. The dose
   * comes out of the fridge at the end; a walk-in who reaches the front with
   * no dose in the bins leaves the §15 walk-out way.
   */
  private serveVaccines(state: GameState, dIgm: number, emit: Emit): void {
    for (const station of state.store.furniture) {
      if (station.defId !== "vaccine_station") continue;
      const laneId = CustomerSystem.vaxLaneId(station.id);
      const front = this.queues.get(laneId)?.[0];
      if (!front) continue;
      const worker = this.stationWorker(state, station.id);
      if (!worker) {
        if (front.mode === "pay") front.mode = "queue"; // the needle stepped away
        continue;
      }
      const slot0 = this.queueSlots.get(laneId)?.[0];
      if (slot0 === undefined) continue;
      if (front.mode === "queue" && this.atCell(front, slot0)) {
        // §14: no dose to give — better they leave now than wait on nothing.
        // It's a sale lost to an empty bin like any other (§11): it counts
        // against the fill rate and can trip the reorder-rules unlock.
        if (shelvedUnits(state.store, VACCINE_DOSE_ID) <= 0) {
          recordStockOut(state, VACCINE_DOSE_ID, emit);
          emit({ type: "vaccine.noDose", customerId: front.id });
          this.walkout(state, front, emit);
          continue;
        }
        front.mode = "pay";
        if (front.serveLeft <= 0) front.serveLeft = VACCINE_IGM * worker.mult;
        const [fx, fy] = FACING[station.rot]!;
        front.yaw = Math.atan2(-fx, -fy);
      }
      if (front.mode === "pay") {
        front.serveLeft -= dIgm;
        if (front.serveLeft <= 0) this.completeVaccination(state, front, emit);
      }
    }
  }

  /** Shot done: one dose out of the fridge, $30 in, +0.01 rep (§14, §26). */
  private completeVaccination(state: GameState, c: Customer, emit: Emit): void {
    if (!takeShelved(state.store, VACCINE_DOSE_ID)) {
      // Another station used the last dose mid-shot — vanishingly rare.
      recordStockOut(state, VACCINE_DOSE_ID, emit);
      emit({ type: "vaccine.noDose", customerId: c.id });
      this.walkout(state, c, emit);
      return;
    }
    state.dayStats.vaccinations++;
    recordSale(state.store, VACCINE_DOSE_ID, 1);
    post(state, "vaccine", VACCINE_REIMBURSEMENT, emit);
    applyRep(state, REP_VACCINE, emit, REP_REASONS.vaccine);
    emit({ type: "vaccine.given", customerId: c.id, total: VACCINE_REIMBURSEMENT });
    this.leaveQueueStructures(c);
    this.beginLeave(c, false);
  }

  /** Drop-off handoff done: accept into the fill queue, or refuse (§15). */
  private completeDropoff(state: GameState, c: Customer, emit: Emit): void {
    const script = this.workflow.script(c.scriptId);
    if (!script) {
      this.leaveQueueStructures(c);
      this.beginLeave(c, false);
      return;
    }
    if (this.workflow.tryAccept(state, script, emit)) {
      this.leaveQueueStructures(c);
      c.waitIgm = 0;
      this.beginScriptWait(state, c);
    } else {
      // Out of stock: the script is refused and logged for the receipt.
      state.dayStats.refusals++;
      recordStockOut(state, script.drugId, emit);
      applyRep(state, REP_REFUSED, emit, REP_REASONS.refused);
      emit({ type: "rx.refused", drugId: script.drugId, customerId: c.id });
      c.scriptId = 0;
      this.leaveQueueStructures(c);
      this.beginLeave(c, false);
    }
  }

  /** Pickup handoff: copay + reimbursement credit together (§10), basket
   *  rings up too; a latent wrong fill surfaces here (§8). */
  private completePickup(state: GameState, c: Customer, emit: Emit): void {
    const script = this.workflow.script(c.scriptId);
    if (!script) {
      this.leaveQueueStructures(c);
      this.beginLeave(c, false);
      return;
    }
    const drug = drugDef(script.drugId);
    const basketTotal = c.basket.reduce((sum, line) => sum + line.price, 0);

    state.dayStats.fills++;
    recordSale(state.store, script.drugId, 1);
    post(state, "rx.reimbursement", drug.reimbursement, emit);
    post(state, "rx.copay", COPAY, emit);
    if (basketTotal > 0) {
      state.dayStats.otcSales++;
      state.dayStats.otcUnits += c.basket.length;
      for (const line of c.basket) recordSale(state.store, line.skuId, 1);
      post(state, "otc.sale", basketTotal, emit);
    }
    let cashDelta = COPAY + drug.reimbursement + basketTotal;
    const counterId = c.laneId ? c.laneId.split("#")[0]! : null;

    const wrong = script.filledWithDrugId !== script.drugId;
    // Chatty patients take the chat if a pharmacist can give it: the owner
    // behind the counter, or a stationed one who isn't mid-verify (§8, §9).
    let counsel: StationWorker | null = null;
    if (!wrong && c.archetype === "chatty" && counterId) {
      if (state.workingStationId === counterId) counsel = { mult: 1, charming: false };
      else counsel = this.staff?.requestCounsel(state, counterId, COUNSEL_IGM) ?? null;
    }
    if (wrong) {
      // §8 copy voice: an error is refunded, never depicted as harm.
      const refund = COPAY + drug.reimbursement;
      cashDelta -= refund;
      state.dayStats.errors++;
      post(state, "refund", -refund, emit);
      applyRep(state, REP_ERROR, emit, REP_REASONS.error);
      emit({ type: "rx.errorDispensed", scriptId: script.id, refund });
    } else {
      applyRep(state, REP_SERVE, emit, REP_REASONS.serve);
      const worker = counterId ? this.stationWorker(state, counterId) : null;
      if (worker?.charming) applyRep(state, REP_CHARMING, emit, REP_REASONS.charming);
    }

    emit({ type: "rx.pickedUp", scriptId: script.id, total: cashDelta, counseled: counsel !== null });
    this.workflow.finish(script, emit);
    c.scriptId = 0;
    c.basket.length = 0;
    c.hasBag = true;

    if (counsel) {
      // The 10 igm counsel chat at the counter (§8), at the counselor's pace.
      c.counseling = true;
      c.serveLeft = COUNSEL_IGM * counsel.mult;
      if (counsel.charming) this.counselCharm.add(c.id);
      return;
    }
    this.leaveQueueStructures(c);
    this.beginLeave(c, false);
  }

  private completeCounsel(state: GameState, c: Customer, emit: Emit): void {
    c.counseling = false;
    applyRep(state, REP_COUNSEL, emit, REP_REASONS.counsel);
    if (this.counselCharm.delete(c.id)) {
      applyRep(state, REP_CHARMING, emit, REP_REASONS.charming);
    }
    const counterId = c.laneId ? c.laneId.split("#")[0]! : null;
    if (counterId) this.staff?.endCounsel(counterId);
    if (Math.random() < COUNSEL_BASKET_CHANCE) {
      post(state, "otc.sale", COUNSEL_BASKET_VALUE, emit);
    }
    this.leaveQueueStructures(c);
    this.beginLeave(c, false);
  }

  // --- Spawning / despawning ---

  private obtain(): Customer {
    const slot = this.freeSlots.pop();
    if (slot !== undefined) return this.pool[slot]!;
    const c: Customer = {
      poolIndex: this.pool.length,
      id: 0,
      active: false,
      name: "",
      archetype: "steady",
      kind: "otc",
      mode: "enter",
      scriptId: 0,
      waitIgm: 0,
      hasBrowsed: false,
      counseling: false,
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      yaw: 0,
      prevYaw: 0,
      stride: 0,
      prevStride: 0,
      seedA: 0,
      seedB: 0,
      patience: 0,
      maxPatience: 1,
      basket: [],
      targets: [],
      targetIdx: 0,
      browseLeft: 0,
      laneId: null,
      chairId: null,
      hasBag: false,
      angry: false,
      serveLeft: 0,
      path: [],
      pathIdx: 0,
      destCell: -1,
      offX: 0,
      offY: 0,
      hasOffTarget: false,
      claimA: -1,
      claimB: -1,
      blockedIgm: 0,
    };
    this.pool.push(c);
    return c;
  }

  private spawn(state: GameState, emit: Emit, kind?: CustomerKind): void {
    const c = this.obtain();
    const def = pickArchetype();
    c.id = this.nextId++;
    c.active = true;
    c.name = randomFullName();
    c.archetype = def.id;
    c.mode = "enter";
    c.seedA = Math.random();
    c.seedB = Math.random();
    c.patience = def.patience;
    c.maxPatience = def.patience;
    c.basket.length = 0;
    c.targets.length = 0;
    c.targetIdx = 0;
    c.browseLeft = 0;
    c.laneId = null;
    c.chairId = null;
    c.hasBag = false;
    c.angry = false;
    c.serveLeft = 0;
    c.scriptId = 0;
    c.waitIgm = 0;
    c.hasBrowsed = false;
    c.counseling = false;
    c.path.length = 0;
    c.pathIdx = 0;
    c.destCell = -1;
    c.claimA = -1;
    c.claimB = -1;
    c.blockedIgm = 0;

    const door = this.doors[Math.floor(Math.random() * this.doors.length)]!;
    c.x = door[0] + randRange(-0.35, 0.35);
    c.y = this.rows + randRange(1.1, 1.7);
    c.prevX = c.x;
    c.prevY = c.y;
    c.yaw = Math.atan2(door[0] - c.x, door[1] - c.y);
    c.prevYaw = c.yaw;
    c.stride = 0;
    c.prevStride = 0;
    c.offX = door[0];
    c.offY = door[1];
    c.hasOffTarget = true;

    // §26 mix, ~35% Rx at the Tier-1 baseline; today's actual split follows
    // formulary breadth (§17). Rx needs a service counter to drop off at.
    // Vaccine walk-ins arrive on their own §14 schedule, already decided.
    if (kind === "vaccine") {
      c.kind = "vaccine";
    } else {
      const counterExists = state.store.furniture.some((f) => f.defId === "counter_service");
      c.kind = counterExists && Math.random() < this.rxShare ? "rx" : "otc";
    }
    if (c.kind === "rx") {
      c.scriptId = this.workflow.createScript(state, c.id, c.name).id;
    } else if (c.kind === "otc") {
      this.pickShelfTargets(state, c, def.targetsMin, def.targetsMax);
    }

    this.activeCountInternal++;
    this.archetypeCounts[def.id]++;
    state.dayStats.visitors++;
    emit({ type: "customer.spawned", id: c.id, archetype: c.archetype });
  }

  /** Target 1–n stocked shelves weighted by remaining units (§7). */
  private pickShelfTargets(state: GameState, c: Customer, min: number, max: number): void {
    c.targets.length = 0;
    c.targetIdx = 0;
    const stocked: { id: string; weight: number }[] = [];
    for (const item of state.store.furniture) {
      if (item.defId !== "otc_shelf") continue;
      const slots = state.store.shelfSlots[item.id];
      if (!slots || slots.length === 0) continue;
      // Weight by what is actually on the shelf — empty labels pull no one in.
      let units = 0;
      for (const skuId of slots) units += shelvedUnits(state.store, skuId);
      if (units > 0) stocked.push({ id: item.id, weight: units });
    }
    let wanted = Math.min(randInt(min, max), stocked.length);
    while (wanted-- > 0) {
      const total = stocked.reduce((sum, s) => sum + s.weight, 0);
      let u = Math.random() * total;
      for (let i = 0; i < stocked.length; i++) {
        u -= stocked[i]!.weight;
        if (u <= 0) {
          c.targets.push(stocked[i]!.id);
          stocked.splice(i, 1);
          break;
        }
      }
    }
  }

  private despawn(c: Customer): void {
    this.releaseClaims(c);
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    this.removeFromQueue(c);
    this.counselCharm.delete(c.id);
    c.basket.length = 0;
    c.active = false;
    this.freeSlots.push(c.poolIndex);
    this.activeCountInternal--;
  }

  // --- Behavior helpers ---

  /** Walk to the next target shelf, else to a checkout queue, else out.
   *  Rx script waiters go back to waiting instead of checking out (§7). */
  private planNextTarget(state: GameState, c: Customer): void {
    while (c.targetIdx < c.targets.length) {
      const shelf = state.store.furniture.find((f) => f.id === c.targets[c.targetIdx]);
      if (shelf && this.pathToShelfFront(c, shelf)) {
        c.mode = "toShelf";
        return;
      }
      c.targetIdx++;
    }
    if (c.scriptId !== 0) {
      this.beginScriptWait(state, c);
      return;
    }
    if (c.basket.length > 0 && this.joinQueue(state, c)) return;
    this.returnBasket(state, c);
    this.beginLeave(c, false);
  }

  // --- Rx patient flow (§7, §8) ---

  private cancelScript(state: GameState, c: Customer, emit: Emit): void {
    if (c.scriptId === 0) return;
    this.workflow.cancel(state, c.scriptId, emit);
    c.scriptId = 0;
  }

  /** Vaccine walk-in through the door: the shortest station line (§14). */
  private goVaccineQueue(state: GameState, c: Customer): void {
    let bestLane: string | null = null;
    let bestLen = Infinity;
    for (const item of state.store.furniture) {
      if (item.defId !== "vaccine_station") continue;
      const laneId = CustomerSystem.vaxLaneId(item.id);
      if (!this.queueSlots.get(laneId)?.length) continue;
      const len = this.queues.get(laneId)?.length ?? 0;
      if (len < bestLen) {
        bestLen = len;
        bestLane = laneId;
      }
    }
    if (!bestLane) {
      // The station went away while they crossed the lot: leave quietly.
      this.beginLeave(c, false);
      return;
    }
    this.joinLane(state, c, bestLane);
  }

  /** Fresh through the door: line up at the drop-off lane. */
  private goDropoff(state: GameState, c: Customer, emit: Emit): void {
    const counter = state.store.furniture.find((f) => f.defId === "counter_service");
    const laneId = counter ? CustomerSystem.dropLaneId(counter.id) : null;
    if (!laneId || !this.queueSlots.get(laneId)?.length) {
      this.cancelScript(state, c, emit);
      this.beginLeave(c, false);
      return;
    }
    this.joinLane(state, c, laneId);
  }

  /** Script ready: leave the chair/shelves and line up for pickup. */
  private goPickup(state: GameState, c: Customer, emit: Emit): void {
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    const counter = state.store.furniture.find((f) => f.defId === "counter_service");
    const laneId = counter ? CustomerSystem.pickLaneId(counter.id) : null;
    if (!laneId || !this.queueSlots.get(laneId)?.length) {
      this.cancelScript(state, c, emit);
      this.returnBasket(state, c);
      this.beginLeave(c, false);
      return;
    }
    this.joinLane(state, c, laneId);
  }

  /** Settle in for the fill wait: a chair if one is free, else stand around. */
  private beginScriptWait(state: GameState, c: Customer): void {
    if (this.trySit(state, c)) return;
    c.mode = "rxWait";
    this.pathToLoiter(c);
  }

  /** §7: waits over 60 igm turn into a browse round on the OTC shelves. */
  private startRxBrowse(state: GameState, c: Customer): void {
    c.hasBrowsed = true;
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    this.pickShelfTargets(state, c, 1, 2);
    this.planNextTarget(state, c);
  }

  /** Stand somewhere out of the way: not a queue slot, not the doorway. */
  private pathToLoiter(c: Customer): void {
    const { cols, rows } = this;
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = Math.floor(Math.random() * cols);
      const y = Math.floor(Math.random() * rows);
      const cell = cellIndex(cols, x, y);
      if (!this.staticWalk[cell] || this.doorExempt[cell]) continue;
      const owner = this.occupied[cell]!;
      if (owner !== 0 && owner !== c.poolIndex + 1) continue;
      let isSlot = false;
      for (const slots of this.queueSlots.values()) {
        if (slots.includes(cell)) {
          isSlot = true;
          break;
        }
      }
      if (isSlot) continue;
      if (this.setPath(c, cell, false)) return;
    }
    // Nowhere obvious to stand; wait right here.
    c.path.length = 0;
    c.pathIdx = 0;
    c.hasOffTarget = false;
  }

  /** Path to a walkable cell on the shelf's browse side. Nearest-first. */
  private pathToShelfFront(c: Customer, shelf: PlacedFurniture): boolean {
    const { cols, rows } = this;
    const def = furnitureDef(shelf.defId);
    const rect = footprintRect(def.cells, shelf.cellX, shelf.cellY, shelf.rot);
    const [fx, fy] = FACING[shelf.rot]!;
    let best = -1;
    let bestScore = Infinity;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const nx = x + fx;
        const ny = y + fy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const cell = cellIndex(cols, nx, ny);
        if (!this.staticWalk[cell]) continue;
        const owner = this.occupied[cell]!;
        const busy = owner !== 0 && owner !== c.poolIndex + 1 ? 100 : 0;
        const score = busy + Math.abs(nx - c.x) + Math.abs(ny - c.y);
        if (score < bestScore) {
          bestScore = score;
          best = cell;
        }
      }
    }
    return best !== -1 && this.setPath(c, best, false);
  }

  /**
   * The shopper picks a label off the shelf they browsed, then stock and price
   * decide whether it reaches the basket: an empty label is a stock-out (§11),
   * an over-priced one is a balk (§10 — Bargain above 1.15×, everyone above
   * 1.35×).
   */
  private finishBrowse(state: GameState, c: Customer, emit: Emit): void {
    if (c.basket.length >= BASKET_MAX) return;
    const shelfId = c.targets[c.targetIdx];
    if (shelfId === undefined) return;
    const slots = state.store.shelfSlots[shelfId];
    if (!slots || slots.length === 0) return;
    if (c.basket.length > 0 && Math.random() > EXTRA_ITEM_CHANCE) return;

    // §16 seasons lean on the shelf pick: spring's ×2.5 pull toward the
    // allergy labels, winter's ×3 toward cold & flu.
    const weightOf = (skuId: string): number => {
      const def = otcDef(skuId);
      return def.demandWeight * otcDemandMult(state, def.category);
    };
    const total = slots.reduce((sum, skuId) => sum + weightOf(skuId), 0);
    let u = Math.random() * total;
    let wanted: string | null = null;
    for (const skuId of slots) {
      u -= weightOf(skuId);
      if (u <= 0) {
        wanted = skuId;
        break;
      }
    }
    if (wanted === null) return;

    if (shelvedUnits(state.store, wanted) <= 0) {
      recordStockOut(state, wanted, emit);
      return;
    }
    if (balksAt(priceMultiplier(state.store, wanted), c.archetype === "bargain")) {
      recordBalk(state, wanted);
      return;
    }
    takeShelved(state.store, wanted);
    c.basket.push({ skuId: wanted, shelfId, price: otcPrice(state.store, wanted) });
  }

  /** Join the shortest register queue. False if no register is usable. */
  private joinQueue(state: GameState, c: Customer): boolean {
    let bestReg: string | null = null;
    let bestLen = Infinity;
    for (const [laneId, slots] of this.queueSlots) {
      if (laneId.includes("#") || slots.length === 0) continue; // registers only
      const len = this.queues.get(laneId)?.length ?? 0;
      if (len < bestLen) {
        bestLen = len;
        bestReg = laneId;
      }
    }
    if (!bestReg) return false;
    this.joinLane(state, c, bestReg);
    return true;
  }

  /** Enter any queue line (register or counter lane) at the back. */
  private joinLane(state: GameState, c: Customer, laneId: string): void {
    let q = this.queues.get(laneId);
    if (!q) {
      q = [];
      this.queues.set(laneId, q);
    }
    q.push(c);
    c.laneId = laneId;
    c.serveLeft = 0;
    c.mode = "toQueue";
    if (this.queuePos(c) >= SIT_QUEUE_POS && this.trySit(state, c)) return;
    this.pathToSlot(c);
  }

  private queuePos(c: Customer): number {
    if (!c.laneId) return -1;
    const q = this.queues.get(c.laneId);
    return q ? q.indexOf(c) : -1;
  }

  private pathToSlot(c: Customer): void {
    if (!c.laneId) return;
    const slots = this.queueSlots.get(c.laneId);
    if (!slots || slots.length === 0) return;
    const pos = this.queuePos(c);
    const slot = slots[Math.min(Math.max(pos, 0), slots.length - 1)]!;
    if (c.destCell === slot && (c.mode === "queue" || c.mode === "toQueue")) return;
    if (this.setPath(c, slot, false)) c.mode = "toQueue";
  }

  /** Retarget every member after a join/leave shuffles positions. */
  private refreshQueue(regId: string): void {
    const q = this.queues.get(regId);
    if (!q) return;
    for (let i = 0; i < q.length; i++) {
      const member = q[i]!;
      if (member.mode === "sit" || member.mode === "toChair") {
        if (i <= STAND_QUEUE_POS) this.standUp(member);
        continue;
      }
      if (member.mode === "pay") continue;
      this.pathToSlot(member);
    }
  }

  /** Grab the nearest free chair when the line is long (§26 half drain). */
  private trySit(state: GameState, c: Customer): boolean {
    let bestChair: PlacedFurniture | null = null;
    let bestDist = Infinity;
    for (const item of state.store.furniture) {
      if (item.defId !== "chair_waiting" || this.chairOccupants.has(item.id)) continue;
      const dist = Math.abs(item.cellX - c.x) + Math.abs(item.cellY - c.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestChair = item;
      }
    }
    if (!bestChair) return false;
    if (!this.pathToChair(c, bestChair)) return false;
    this.chairOccupants.set(bestChair.id, c.poolIndex);
    c.chairId = bestChair.id;
    c.mode = "toChair";
    return true;
  }

  /** Path to a cell beside the chair, then slide onto the chair cell. */
  private pathToChair(c: Customer, chair: PlacedFurniture): boolean {
    const { cols, rows } = this;
    const chairCell = cellIndex(cols, chair.cellX, chair.cellY);
    let bestAdj = -1;
    let bestDist = Infinity;
    for (const [dx, dy] of FACING) {
      const nx = chair.cellX + dx;
      const ny = chair.cellY + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const cell = cellIndex(cols, nx, ny);
      if (!this.staticWalk[cell]) continue;
      const dist = Math.abs(nx - c.x) + Math.abs(ny - c.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestAdj = cell;
      }
    }
    if (bestAdj === -1 || !this.setPath(c, bestAdj, false)) return false;
    c.path.push(chairCell);
    c.destCell = chairCell;
    return true;
  }

  private standUp(c: Customer): void {
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    c.mode = "toQueue";
    this.pathToSlot(c);
  }

  /** Returns true when the customer walked out (caller must stop updating). */
  private drainPatience(
    state: GameState,
    c: Customer,
    dIgm: number,
    rate: number,
    emit: Emit,
  ): boolean {
    c.patience -= dIgm * rate;
    if (c.patience > 0) return false;
    c.patience = 0;
    this.walkout(state, c, emit);
    return true;
  }

  private walkout(state: GameState, c: Customer, emit: Emit): void {
    state.dayStats.walkouts++;
    this.returnBasket(state, c);
    this.cancelScript(state, c, emit); // the script is lost with them (§7)
    applyRep(
      state,
      c.archetype === "hurried" ? REP_WALKOUT_HURRIED : REP_WALKOUT,
      emit,
      REP_REASONS.walkout,
    );
    emit({ type: "customer.walkout", id: c.id, archetype: c.archetype });
    this.leaveQueueStructures(c);
    this.beginLeave(c, true);
  }

  private completeSale(state: GameState, c: Customer, emit: Emit): void {
    const total = c.basket.reduce((sum, line) => sum + line.price, 0);
    state.dayStats.otcSales++;
    state.dayStats.otcUnits += c.basket.length;
    for (const line of c.basket) recordSale(state.store, line.skuId, 1);
    post(state, "otc.sale", total, emit);
    emit({ type: "sale.completed", customerId: c.id, items: c.basket.length, total });
    applyRep(state, REP_SERVE, emit, REP_REASONS.serve); // happy serve (§15)
    const worker = c.laneId ? this.stationWorker(state, c.laneId) : null;
    if (worker?.charming) applyRep(state, REP_CHARMING, emit, REP_REASONS.charming);
    c.basket.length = 0;
    c.hasBag = true;
    this.leaveQueueStructures(c);
    this.beginLeave(c, false);
  }

  private leaveQueueStructures(c: Customer): void {
    const regId = c.laneId;
    this.removeFromQueue(c);
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    if (regId) this.refreshQueue(regId);
  }

  private removeFromQueue(c: Customer): void {
    if (!c.laneId) return;
    const q = this.queues.get(c.laneId);
    if (q) {
      const i = q.indexOf(c);
      if (i !== -1) q.splice(i, 1);
    }
    c.laneId = null;
  }

  /** Put unpurchased basket items back on their shelves. */
  private returnBasket(state: GameState, c: Customer): void {
    for (const line of c.basket) returnShelved(state.store, line.skuId);
    c.basket.length = 0;
  }

  /** Head for the nearest door, then off the lot. Angry = walk-out pace. */
  private beginLeave(c: Customer, angry: boolean): void {
    c.angry = angry;
    c.mode = "leave";
    let found = false;
    for (const [dx, dy] of this.doors) {
      if (this.setPath(c, cellIndex(this.cols, dx, dy), false)) {
        found = true;
        break; // doors are adjacent cells; the first reachable one is fine
      }
    }
    if (!found) {
      // Trapped by a mid-shift renovation: give up on pathing and slip out.
      c.path.length = 0;
      c.pathIdx = 0;
    }
    c.offX = found ? c.path[c.path.length - 1]! % this.cols : c.x;
    c.offY = this.rows + 1.8;
    c.hasOffTarget = true;
  }

  // --- Movement: claims, pathing, stepping ---

  private tryClaim(c: Customer, cell: number): boolean {
    if (this.doorExempt[cell]) return true;
    const owner = this.occupied[cell]!;
    if (owner !== 0 && owner !== c.poolIndex + 1) return false;
    this.occupied[cell] = c.poolIndex + 1;
    return true;
  }

  private releaseCell(c: Customer, cell: number): void {
    if (cell === -1 || this.doorExempt[cell]) return;
    if (this.occupied[cell] === c.poolIndex + 1) this.occupied[cell] = 0;
  }

  private releaseClaims(c: Customer): void {
    this.releaseCell(c, c.claimA);
    this.releaseCell(c, c.claimB);
    c.claimA = -1;
    c.claimB = -1;
  }

  /**
   * A* to destCell from the customer's current cell (forced walkable so
   * chair-seated or newly-enclosed customers can still route out). On success
   * the path replaces c.path and claims collapse onto the start cell; on
   * failure the customer's current path and claims are left untouched.
   */
  private setPath(c: Customer, destCell: number, avoidOthers: boolean): boolean {
    const { cols } = this;
    const sx = Math.round(c.x);
    const sy = Math.round(c.y);
    const start = cellIndex(cols, sx, sy);

    let map = this.staticWalk;
    if (avoidOthers) {
      map = this.scratchWalk;
      map.set(this.staticWalk);
      for (let i = 0; i < this.occupied.length; i++) {
        const owner = this.occupied[i]!;
        if (owner !== 0 && owner !== c.poolIndex + 1) map[i] = 0;
      }
    }

    const savedStart = map[start]!;
    map[start] = 1;
    const tx = destCell % cols;
    const ty = (destCell - tx) / cols;
    const len = this.pathfinder.findPath(map, sx, sy, tx, ty, this.pathScratch);
    map[start] = savedStart;
    if (len === -1) return false;

    c.path.length = 0;
    for (const cell of this.pathScratch) c.path.push(cell);
    c.pathIdx = 0;
    c.destCell = destCell;
    c.hasOffTarget = false;
    c.blockedIgm = 0;
    // Claims collapse onto the start cell.
    if (c.claimA !== start) this.releaseCell(c, c.claimA);
    if (c.claimB !== start) this.releaseCell(c, c.claimB);
    c.claimB = -1;
    c.claimA = this.tryClaim(c, start) ? start : -1;
    return true;
  }

  /** Advance along path + off-grid target. True when fully arrived. */
  private step(c: Customer, dIgm: number): boolean {
    let budget = (c.angry ? ANGRY_SPEED : WALK_SPEED) * dIgm;
    while (budget > 0) {
      let tx: number;
      let ty: number;
      const onPath = c.pathIdx < c.path.length;
      if (onPath) {
        const cell = c.path[c.pathIdx]!;
        tx = cell % this.cols;
        ty = (cell - tx) / this.cols;
        // Claim the waypoint before stepping toward it (§6 reservation).
        // claimB === -2 marks an in-progress unclaimed shoulder-through.
        if (c.claimB !== cell && c.claimB !== -2 && cell !== c.claimA) {
          if (!this.tryClaim(c, cell)) {
            c.blockedIgm += dIgm;
            if (c.blockedIgm >= BLOCKED_REPATH_IGM) {
              if (this.setPath(c, c.destCell, true)) return false; // rerouted
              // No route around. If the jam is mid-path (e.g. a head-on
              // meeting in a 1-wide aisle), shoulder through unclaimed
              // rather than freeze; at the final cell, keep waiting.
              if (cell !== c.destCell && c.blockedIgm >= BLOCKED_REPATH_IGM * 3) {
                c.blockedIgm = 0;
                c.claimB = -2; // sentinel: traversing without a claim
                continue;
              }
            }
            return false;
          }
          c.claimB = cell;
        }
      } else if (c.hasOffTarget) {
        tx = c.offX;
        ty = c.offY;
      } else {
        return true;
      }

      const dx = tx - c.x;
      const dy = ty - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-4) {
        const move = Math.min(budget, dist);
        c.x += (dx / dist) * move;
        c.y += (dy / dist) * move;
        c.yaw = Math.atan2(dx, dy);
        c.stride += move;
        budget -= move;
        if (move < dist - 1e-6) return false;
      }
      // Waypoint reached.
      c.x = tx;
      c.y = ty;
      c.blockedIgm = 0;
      if (onPath) {
        const cell = c.path[c.pathIdx]!;
        if (c.claimA !== cell) this.releaseCell(c, c.claimA);
        c.claimA = this.doorExempt[cell] ? -1 : cell;
        if (c.claimA !== -1) this.tryClaim(c, cell); // no-op if shouldered onto a busy cell
        c.claimB = -1;
        c.pathIdx++;
      } else {
        c.hasOffTarget = false;
        return true;
      }
    }
    return false;
  }

  private atCell(c: Customer, cell: number): boolean {
    const cx = cell % this.cols;
    const cy = (cell - cx) / this.cols;
    return Math.abs(c.x - cx) < 0.12 && Math.abs(c.y - cy) < 0.12;
  }
}
