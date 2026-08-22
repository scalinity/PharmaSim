// Customer simulation (SPEC §7, §15, §17, §26): district-driven arrival
// scheduling with rush bumps, archetypes, the browse → queue → pay → exit
// state machine, patience with chair relief, walk-outs, shelf stock decrement,
// and register service while the player works the station. Pure sim — no DOM,
// no three.js. Customer objects are pooled; the per-tick path is allocation-free.

import { DAY_START_IGM, IGM_PER_TICK } from "../core/clock";
import { cellIndex, doorCells, FACING, footprintRect } from "../core/grid";
import { Pathfinder } from "../core/pathfind";
import { districtById } from "../data/districts";
import { furnitureDef } from "../data/furniture";
import { randomFullName } from "../data/names";
import { otcDef } from "../data/otc";
import type { SimEvent } from "./events";
import { backroomZone } from "./placement";
import type { GameState, PlacedFurniture } from "./state";

export type Archetype = "hurried" | "steady" | "bargain" | "chatty";

export type CustomerMode =
  | "enter" // outside → door cell
  | "toShelf"
  | "browse"
  | "toQueue" // walking to an assigned queue slot (patience drains)
  | "queue" // standing at the slot (patience drains)
  | "toChair" // walking to a reserved waiting chair (patience drains)
  | "sit" // seated (half drain, §26)
  | "pay" // being served at the register (patience frozen)
  | "leave"; // walking out (calm or angry)

/** Modes during which the overhead patience ring is shown. */
export const WAITING_MODES: ReadonlySet<CustomerMode> = new Set([
  "toQueue",
  "queue",
  "toChair",
  "sit",
  "pay",
]);

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
  mode: CustomerMode;
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
  queueRegId: string | null;
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
const RUSH_WINDOWS: readonly [number, number][] = [
  [720, 840], // 12:00–14:00
  [1020, 1140], // 17:00–19:00
];
const RUSH_MULT = 1.6;
/** The store's slice of Old Town OTC intent until §17 routing lands (M12/13);
 *  tuned so base visitors = 20/day at the §26 baseline. */
const OLD_TOWN_SHARE = 20 / ((6_800 / 1000) * 9);

const WALK_SPEED = 0.5; // cells per igm ≈ 1.2 m/s at 1×
const ANGRY_SPEED = 0.68;
const CHECKOUT_IGM = 4;
const BLOCKED_REPATH_IGM = 7.2; // 3 real s at 1× (§6)
const SIT_QUEUE_POS = 3; // queue position from which customers grab a chair
const STAND_QUEUE_POS = 1; // seated customers rejoin the line at this position
const QUEUE_MAX_SLOTS = 12;
const BASKET_MAX = 4;
const EXTRA_ITEM_CHANCE = 0.6;
const REP_SERVE = 0.02;
const REP_WALKOUT = -0.06;
const REP_WALKOUT_HURRIED = -0.09;

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

/** Apply a §15 reputation delta: clamp, track the day's total, emit. */
export function applyRep(state: GameState, delta: number, emit: Emit): void {
  const next = Math.min(5, Math.max(0, state.repStars + delta));
  const applied = next - state.repStars;
  if (applied === 0) return;
  state.repStars = next;
  state.dayStats.repDelta += applied;
  emit({ type: "rep.changed", stars: state.repStars, delta: applied });
}

export class CustomerSystem {
  private cols: number;
  private rows: number;
  private pathfinder: Pathfinder;
  /** Cells customers may path through: public zone minus furniture. */
  private staticWalk: Uint8Array;
  private scratchWalk: Uint8Array;
  /** Per-cell claim: poolIndex + 1, or 0 (door cells stay unclaimed). */
  private occupied: Int32Array;
  private doorExempt: Uint8Array;
  private doors: [number, number][];

  private pool: Customer[] = [];
  private freeSlots: number[] = [];
  private nextId = 1;
  private activeCountInternal = 0;

  private queues = new Map<string, Customer[]>();
  private queueSlots = new Map<string, number[]>();
  private chairOccupants = new Map<string, number>(); // chairId → poolIndex

  private arrivals: number[] = [];
  private arrivalIdx = 0;
  private stressLevel = 0; // 0..3 → ×1 / ×3 / ×9 / ×27 spawn multiplier
  private pathScratch: number[] = [];

  /** Dev/debug: cumulative archetype tally for share verification. */
  readonly archetypeCounts: Record<Archetype, number> = {
    hurried: 0,
    steady: 0,
    bargain: 0,
    chatty: 0,
  };

  constructor(state: GameState) {
    const { cols, rows } = state.store.grid;
    this.cols = cols;
    this.rows = rows;
    this.pathfinder = new Pathfinder(cols, rows);
    this.staticWalk = new Uint8Array(cols * rows);
    this.scratchWalk = new Uint8Array(cols * rows);
    this.occupied = new Int32Array(cols * rows);
    this.doorExempt = new Uint8Array(cols * rows);
    this.doors = doorCells(cols, rows);
    for (const [x, y] of this.doors) this.doorExempt[cellIndex(cols, x, y)] = 1;
    this.layoutChanged(state);
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

  // --- Day scheduling (§7, §17, §26) ---

  beginDay(state: GameState): void {
    const oldTown = districtById("oldTown");
    const districtVisits = (oldTown.population / 1000) * oldTown.otcIntent;
    const repMult = 0.4 + 0.24 * state.repStars;
    const dayNoise = randRange(0.85, 1.15);
    let n = Math.round(districtVisits * OLD_TOWN_SHARE * repMult * dayNoise);
    n *= 3 ** this.stressLevel;
    this.arrivals = this.sampleArrivals(n, DAY_START_IGM);
    this.arrivalIdx = 0;
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

  /** Rebuild walkable/queue geometry after any furniture change. */
  layoutChanged(state: GameState): void {
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

    // Queue slot lines per register.
    this.queueSlots.clear();
    for (const item of state.store.furniture) {
      if (item.defId !== "counter_register") continue;
      this.queueSlots.set(item.id, this.computeSlots(item));
    }

    // Disband queues whose register vanished; stand up unseated sitters.
    for (const [regId, q] of this.queues) {
      if (this.queueSlots.has(regId)) continue;
      for (const member of [...q]) {
        this.removeFromQueue(member);
        this.returnBasket(state, member);
        this.beginLeave(member, false);
      }
      this.queues.delete(regId);
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
      } else if (c.mode === "leave") this.beginLeave(c, c.angry);
    }
    for (const regId of this.queues.keys()) this.refreshQueue(regId);
  }

  /** Queue slot cells snaking out from the register's front (§27). */
  private computeSlots(reg: PlacedFurniture): number[] {
    const { cols, rows } = this;
    const slots: number[] = [];
    const facing = FACING[reg.rot]!;
    let dx = facing[0];
    let dy = facing[1];
    let x = reg.cellX + dx;
    let y = reg.cellY + dy;
    while (slots.length < QUEUE_MAX_SLOTS) {
      const inBounds = x >= 0 && x < cols && y >= 0 && y < rows;
      const cell = inBounds ? cellIndex(cols, x, y) : -1;
      if (!inBounds || !this.staticWalk[cell] || slots.includes(cell)) {
        if (slots.length === 0) break;
        // Bend the line: try the two perpendicular directions off the tail.
        const last = slots[slots.length - 1]!;
        const lx = last % cols;
        const ly = (last - lx) / cols;
        let bent = false;
        for (const [ox, oy] of [
          [-dy, dx],
          [dy, -dx],
        ] as const) {
          const nx = lx + ox;
          const ny = ly + oy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const nc = cellIndex(cols, nx, ny);
          if (!this.staticWalk[nc] || slots.includes(nc)) continue;
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

    for (const c of this.pool) {
      if (!c.active) continue;
      c.prevX = c.x;
      c.prevY = c.y;
      c.prevYaw = c.yaw;
      c.prevStride = c.stride;
      this.updateCustomer(state, c, dIgm, emit);
    }

    this.serveRegisters(state, dIgm, emit);
  }

  private updateCustomer(state: GameState, c: Customer, dIgm: number, emit: Emit): void {
    switch (c.mode) {
      case "enter":
        if (this.step(c, dIgm)) this.planNextTarget(state, c);
        return;
      case "toShelf":
        if (this.step(c, dIgm)) {
          const def = ARCHETYPES.find((a) => a.id === c.archetype)!;
          c.browseLeft = randRange(def.browseMin, def.browseMax);
          c.mode = "browse";
        }
        return;
      case "browse":
        c.browseLeft -= dIgm;
        if (c.browseLeft <= 0) {
          this.finishBrowse(state, c);
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
        if (this.drainPatience(state, c, dIgm, 1, emit)) return;
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
        if (this.drainPatience(state, c, dIgm, 0.5, emit)) return;
        if (this.queuePos(c) <= STAND_QUEUE_POS) this.standUp(c);
        return;
      case "pay":
        return; // progress lives in serveRegisters
      case "leave":
        if (this.step(c, dIgm)) this.despawn(c);
        return;
    }
  }

  /** Register service (§8, §26): 4 igm per checkout while the player works. */
  private serveRegisters(state: GameState, dIgm: number, emit: Emit): void {
    for (const [regId, q] of this.queues) {
      const front = q[0];
      if (!front) continue;
      const working = state.workingStationId === regId && !state.buildMode;
      if (!working) {
        if (front.mode === "pay") front.mode = "queue"; // player stepped away
        continue;
      }
      const slot0 = this.queueSlots.get(regId)?.[0];
      if (slot0 === undefined) continue;
      if (front.mode === "queue" && this.atCell(front, slot0)) {
        front.mode = "pay";
        if (front.serveLeft <= 0) front.serveLeft = CHECKOUT_IGM;
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
      mode: "enter",
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
      queueRegId: null,
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

  private spawn(state: GameState, emit: Emit): void {
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
    c.queueRegId = null;
    c.chairId = null;
    c.hasBag = false;
    c.angry = false;
    c.serveLeft = 0;
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

    // Target shelves: 1–4 stocked shelves weighted by remaining units (§7).
    const stocked: { id: string; weight: number }[] = [];
    for (const item of state.store.furniture) {
      if (item.defId !== "otc_shelf") continue;
      const slots = state.store.shelfStock[item.id];
      if (!slots) continue;
      const units = slots.reduce((sum, s) => sum + s.units, 0);
      if (units > 0) stocked.push({ id: item.id, weight: units });
    }
    let wanted = Math.min(randInt(def.targetsMin, def.targetsMax), stocked.length);
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

    this.activeCountInternal++;
    this.archetypeCounts[def.id]++;
    state.dayStats.visitors++;
    emit({ type: "customer.spawned", id: c.id, archetype: c.archetype });
  }

  private despawn(c: Customer): void {
    this.releaseClaims(c);
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    this.removeFromQueue(c);
    c.basket.length = 0;
    c.active = false;
    this.freeSlots.push(c.poolIndex);
    this.activeCountInternal--;
  }

  // --- Behavior helpers ---

  /** Walk to the next target shelf, else to a checkout queue, else out. */
  private planNextTarget(state: GameState, c: Customer): void {
    while (c.targetIdx < c.targets.length) {
      const shelf = state.store.furniture.find((f) => f.id === c.targets[c.targetIdx]);
      if (shelf && this.pathToShelfFront(c, shelf)) {
        c.mode = "toShelf";
        return;
      }
      c.targetIdx++;
    }
    if (c.basket.length > 0 && this.joinQueue(state, c)) return;
    this.returnBasket(state, c);
    this.beginLeave(c, false);
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

  private finishBrowse(state: GameState, c: Customer): void {
    if (c.basket.length >= BASKET_MAX) return;
    const shelfId = c.targets[c.targetIdx];
    if (shelfId === undefined) return;
    const slots = state.store.shelfStock[shelfId];
    if (!slots) return;
    const inStock = slots.filter((s) => s.units > 0);
    if (inStock.length === 0) return; // empty slots can't be browsed into a basket
    if (c.basket.length > 0 && Math.random() > EXTRA_ITEM_CHANCE) return;
    const total = inStock.reduce((sum, s) => sum + otcDef(s.skuId).demandWeight, 0);
    let u = Math.random() * total;
    for (const slot of inStock) {
      u -= otcDef(slot.skuId).demandWeight;
      if (u <= 0) {
        slot.units--;
        // MSRP ×1.0 until the pricing slider lands in 05 (§10).
        c.basket.push({ skuId: slot.skuId, shelfId, price: otcDef(slot.skuId).msrp });
        return;
      }
    }
  }

  /** Join the shortest register queue. False if no register is usable. */
  private joinQueue(state: GameState, c: Customer): boolean {
    let bestReg: string | null = null;
    let bestLen = Infinity;
    for (const [regId, slots] of this.queueSlots) {
      if (slots.length === 0) continue;
      const len = this.queues.get(regId)?.length ?? 0;
      if (len < bestLen) {
        bestLen = len;
        bestReg = regId;
      }
    }
    if (!bestReg) return false;
    let q = this.queues.get(bestReg);
    if (!q) {
      q = [];
      this.queues.set(bestReg, q);
    }
    q.push(c);
    c.queueRegId = bestReg;
    c.serveLeft = 0;
    c.mode = "toQueue";
    if (this.queuePos(c) >= SIT_QUEUE_POS && this.trySit(state, c)) return true;
    this.pathToSlot(c);
    return true;
  }

  private queuePos(c: Customer): number {
    if (!c.queueRegId) return -1;
    const q = this.queues.get(c.queueRegId);
    return q ? q.indexOf(c) : -1;
  }

  private pathToSlot(c: Customer): void {
    if (!c.queueRegId) return;
    const slots = this.queueSlots.get(c.queueRegId);
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
    applyRep(state, c.archetype === "hurried" ? REP_WALKOUT_HURRIED : REP_WALKOUT, emit);
    emit({ type: "customer.walkout", id: c.id, archetype: c.archetype });
    this.leaveQueueStructures(c);
    this.beginLeave(c, true);
  }

  private completeSale(state: GameState, c: Customer, emit: Emit): void {
    const total = c.basket.reduce((sum, line) => sum + line.price, 0);
    state.cash += total;
    state.dayStats.sales++;
    state.dayStats.revenue += total;
    emit({ type: "cash.changed", cash: state.cash });
    emit({ type: "sale.completed", customerId: c.id, items: c.basket.length, total });
    applyRep(state, REP_SERVE, emit); // happy serve (§15)
    c.basket.length = 0;
    c.hasBag = true;
    this.leaveQueueStructures(c);
    this.beginLeave(c, false);
  }

  private leaveQueueStructures(c: Customer): void {
    const regId = c.queueRegId;
    this.removeFromQueue(c);
    if (c.chairId) {
      this.chairOccupants.delete(c.chairId);
      c.chairId = null;
    }
    if (regId) this.refreshQueue(regId);
  }

  private removeFromQueue(c: Customer): void {
    if (!c.queueRegId) return;
    const q = this.queues.get(c.queueRegId);
    if (q) {
      const i = q.indexOf(c);
      if (i !== -1) q.splice(i, 1);
    }
    c.queueRegId = null;
  }

  /** Put unpurchased basket items back on their shelves. */
  private returnBasket(state: GameState, c: Customer): void {
    for (const line of c.basket) {
      const slots = state.store.shelfStock[line.shelfId];
      const slot = slots?.find((s) => s.skuId === line.skuId);
      if (slot) slot.units++;
    }
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
