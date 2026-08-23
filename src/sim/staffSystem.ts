// Staff on the floor (SPEC §9, §26, §27): hired staff walk the store as NPCs,
// path to their assigned station and work its queue — cashiers ring checkouts
// and counter lanes, techs fill (probabilistically, §26), pharmacists verify
// and step over to counsel — with the §9 priority: own-station queue, else an
// unmanned front desk (cashiers), else a Stock Hawk restock run, else drift
// to a break spot. The player clicking a station displaces its worker; the
// worker resumes when the player steps away. Staff cross both zones (§6) and
// don't claim cells — a small crew slips through the crowd.
// Pure sim — no DOM, no three.js.

import { IGM_PER_TICK } from "../core/clock";
import { cellIndex, doorCells, FACING, footprintRect, type CellRect } from "../core/grid";
import { Pathfinder } from "../core/pathfind";
import { furnitureDef } from "../data/furniture";
import type { CustomerSystem } from "./customers";
import type { SimEvent } from "./events";
import { hasEmptySlot, restock, restockableUnits } from "./inventory";
import { backroomZone } from "./placement";
import {
  fillErrorRate,
  taskDuration,
  verifyCatchRate,
  type StaffMember,
} from "./staff";
import type { GameState, PlacedFurniture } from "./state";
import { FILL_IGM, VERIFY_IGM, type RxWorkflow } from "./workflow";

type Emit = (event: SimEvent) => void;

/** For construction-time calls, where no agent can hold a claim yet. */
const NO_EMIT: Emit = () => {};

const WALK_SPEED = 0.6; // cells per igm — a working pace, brisker than browsing
/** A long fuse: staff hold their post through workday lulls and only drift
 *  to the break spot when it has been properly quiet — the walk back is
 *  latency a waiting patient pays for. */
const IDLE_TO_BREAK_IGM = 90;
const RESTOCK_IGM = 6; // a §26-scale task; ×speed curve like the rest
/** A Stock Hawk won't make the trip for a couple of loose boxes — unless a
 *  label has run completely dry. */
const RESTOCK_MIN_UNITS = 6;
const COUNSEL_SLACK_IGM = 3; // agent timer backs up the customer's, not vice versa

const FRONT_DEFS: ReadonlySet<string> = new Set(["counter_register", "counter_service"]);
const RESTOCK_DEFS: ReadonlySet<string> = new Set(["otc_shelf", "rx_shelf"]);

/** What an agent is walking toward / standing at. */
type TargetKind = "post" | "shelf" | "break" | "counsel";

export interface StaffAgent {
  member: StaffMember;
  // Continuous cell coordinates + render interpolation state (§30).
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  yaw: number;
  prevYaw: number;
  stride: number;
  prevStride: number;
  /** Where they're headed (or standing): station / shelf / break / counsel. */
  targetKind: TargetKind;
  targetId: string | null;
  targetCell: number;
  arrived: boolean;
  /** Fill or verify claim in progress (0 = none). */
  taskScriptId: number;
  taskKind: "fill" | "verify" | null;
  taskLeft: number;
  restockLeft: number;
  counselLeft: number;
  idleIgm: number;
  path: number[];
  pathIdx: number;
}

export interface StationWorker {
  /** Task-duration multiplier: §26 speed curve × trait (§9). */
  mult: number;
  charming: boolean;
}

export class StaffSystem {
  private cols: number;
  private rows: number;
  private pathfinder: Pathfinder;
  /** Cells staff may cross: everything but furniture — both zones (§6). */
  private walk: Uint8Array;
  private breakCells: number[] = [];
  private agentList: StaffAgent[] = [];
  private pathScratch: number[] = [];
  private doors: [number, number][];
  /** Who took each counter's chat (counter id → member id): endCounsel must
   *  end that pharmacist's chat, not everyone standing near the counter. */
  private counselors = new Map<string, string>();

  constructor(
    state: GameState,
    private workflow: RxWorkflow,
    private customers: CustomerSystem,
  ) {
    const { cols, rows } = state.store.grid;
    this.cols = cols;
    this.rows = rows;
    this.pathfinder = new Pathfinder(cols, rows);
    this.walk = new Uint8Array(cols * rows);
    this.doors = doorCells(cols, rows);
    // Back-register with the customer system here, so the two can never be
    // constructed half-wired (§9: stations manned by staff, not just the
    // player).
    customers.bindStaff(this);
    this.layoutChanged(state, NO_EMIT);
    this.rosterChanged(state, NO_EMIT);
    // A loaded save starts the crew already on the floor, at their spots.
    this.agentList.forEach((agent, i) => this.placeAtBreak(agent, i, NO_EMIT));
  }

  /** Live agents for the render layer (positions interpolate on stride). */
  get agents(): readonly StaffAgent[] {
    return this.agentList;
  }

  // --- Queries the customer system serves against ---

  /** The staffer standing at and working this station right now, or null. */
  workerAt(stationId: string): StationWorker | null {
    for (const agent of this.agentList) {
      if (agent.targetKind !== "post" || agent.targetId !== stationId || !agent.arrived) continue;
      return { mult: taskDuration(agent.member, 1), charming: agent.member.trait === "charming" };
    }
    return null;
  }

  /**
   * A chatty pickup wants its chat (§8): send over a stationed pharmacist who
   * isn't mid-verify. Returns their service profile, or null — no pharmacist,
   * no counsel, no hard feelings.
   */
  requestCounsel(state: GameState, counterId: string, baseIgm: number): StationWorker | null {
    if (this.counselors.has(counterId)) return null; // one chat per counter
    const counter = state.store.furniture.find((f) => f.id === counterId);
    if (!counter) return null;
    for (const agent of this.agentList) {
      const member = agent.member;
      if (member.role !== "pharmacist" || agent.taskScriptId !== 0) continue;
      if (agent.targetKind === "counsel") continue;
      if (!this.isOnDuty(state, member)) continue;
      const mult = taskDuration(member, 1);
      agent.counselLeft = baseIgm * mult + COUNSEL_SLACK_IGM;
      this.counselors.set(counterId, member.id);
      this.setTarget(agent, "counsel", counterId, this.counselCell(counter));
      return { mult, charming: member.trait === "charming" };
    }
    return null;
  }

  /** The chat wrapped up (or the patient left): back to the desk. */
  endCounsel(counterId: string): void {
    const memberId = this.counselors.get(counterId);
    if (memberId === undefined) return;
    this.counselors.delete(counterId);
    for (const agent of this.agentList) {
      if (agent.member.id === memberId && agent.targetKind === "counsel") {
        agent.counselLeft = 0;
      }
    }
  }

  /** Drop any chat this member had taken (fired mid-walk, day reset). */
  private dropCounselor(memberId: string): void {
    for (const [counterId, holder] of this.counselors) {
      if (holder === memberId) this.counselors.delete(counterId);
    }
  }

  /** Assigned to a station that exists — "stationed", §9. */
  private isOnDuty(state: GameState, member: StaffMember): boolean {
    if (!member.assignment) return false;
    return state.store.furniture.some((f) => f.id === member.assignment!.stationId);
  }

  // --- Roster / layout / player churn ---

  /** Sync agents to the roster: fired staff vanish, hires walk in the door. */
  rosterChanged(state: GameState, emit: Emit): void {
    for (let i = this.agentList.length - 1; i >= 0; i--) {
      const agent = this.agentList[i]!;
      const member = state.store.staff.find((m) => m.id === agent.member.id);
      if (!member) {
        this.releaseTask(agent, emit);
        this.dropCounselor(agent.member.id);
        this.agentList.splice(i, 1);
      } else {
        agent.member = member; // hydrated states carry fresh objects
      }
    }
    for (const member of state.store.staff) {
      if (this.agentList.some((a) => a.member.id === member.id)) continue;
      const door = this.doors[0]!;
      const agent: StaffAgent = {
        member,
        x: door[0],
        y: door[1],
        prevX: door[0],
        prevY: door[1],
        yaw: Math.PI, // facing into the store
        prevYaw: Math.PI,
        stride: 0,
        prevStride: 0,
        targetKind: "break",
        targetId: null,
        targetCell: cellIndex(this.cols, door[0], door[1]),
        arrived: false,
        taskScriptId: 0,
        taskKind: null,
        taskLeft: 0,
        restockLeft: 0,
        counselLeft: 0,
        idleIgm: 0,
        path: [],
        pathIdx: 0,
      };
      this.agentList.push(agent);
    }
  }

  /** Rebuild the walk map and break spots after any furniture change. */
  layoutChanged(state: GameState, emit: Emit): void {
    const { cols } = this;
    this.walk.fill(1);
    for (const item of state.store.furniture) {
      const def = furnitureDef(item.defId);
      if (def.walkable) continue;
      const rect = footprintRect(def.cells, item.cellX, item.cellY, item.rot);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          this.walk[cellIndex(cols, x, y)] = 0;
        }
      }
    }
    this.computeBreakCells(state);
    // Paths may now cross new furniture; everyone re-plans from scratch.
    // A held claim goes back on the pile first — think() waits on a claim,
    // so a break target would otherwise freeze its worker for good. Chats
    // are dropped with the targets; the customer side ends its own timer.
    this.counselors.clear();
    for (const agent of this.agentList) {
      this.releaseTask(agent, emit);
      agent.path.length = 0;
      agent.pathIdx = 0;
      agent.arrived = false;
      agent.targetKind = "break";
      agent.targetId = null;
    }
  }

  /** The player took (or left) a station: its worker steps aside at once. */
  playerStationChanged(state: GameState, emit: Emit): void {
    const stationId = state.workingStationId;
    if (stationId === null) return;
    for (const agent of this.agentList) {
      if (agent.targetKind === "post" && agent.targetId === stationId) {
        this.releaseTask(agent, emit);
        agent.targetKind = "break";
        agent.targetId = null;
        agent.arrived = false;
        agent.path.length = 0;
      }
    }
  }

  /** New morning: the crew is back at their break spots, ready for open. */
  beginDay(state: GameState, emit: Emit): void {
    this.counselors.clear();
    this.rosterChanged(state, emit);
    this.agentList.forEach((agent, i) => this.placeAtBreak(agent, i, emit));
  }

  private placeAtBreak(agent: StaffAgent, index: number, emit: Emit): void {
    // No script survives a day boundary today, but a claim must never be
    // zeroed without going back on its queue — release, don't drop.
    this.releaseTask(agent, emit);
    const cell = this.breakCells[index % Math.max(1, this.breakCells.length)];
    if (cell === undefined) return;
    const cx = cell % this.cols;
    const cy = (cell - cx) / this.cols;
    agent.x = agent.prevX = cx;
    agent.y = agent.prevY = cy;
    agent.path.length = 0;
    agent.pathIdx = 0;
    agent.targetKind = "break";
    agent.targetId = null;
    agent.targetCell = cell;
    agent.arrived = true;
    agent.counselLeft = 0;
    agent.restockLeft = 0;
    agent.idleIgm = 0;
  }

  // --- Tick ---

  tick(state: GameState, emit: Emit): void {
    for (let i = 0; i < this.agentList.length; i++) {
      const agent = this.agentList[i]!;
      agent.prevX = agent.x;
      agent.prevY = agent.y;
      agent.prevYaw = agent.yaw;
      agent.prevStride = agent.stride;
      this.think(state, agent, i);
      this.stepAgent(state, agent, IGM_PER_TICK);
      this.work(state, agent, IGM_PER_TICK, emit);
    }
  }

  /** §9 priority: own-station queue · unmanned front desk (cashiers) ·
   *  Stock Hawk restock · break spot. */
  private think(state: GameState, agent: StaffAgent, index: number): void {
    const member = agent.member;

    // Mid-counsel: stay with the patient until the chat (or its slack) ends.
    if (agent.targetKind === "counsel") {
      if (agent.counselLeft > 0) return;
      this.dropCounselor(member.id);
      agent.targetKind = "break";
      agent.targetId = null;
    }

    // A held claim pins the worker to their post; drop it if the script
    // vanished underneath them (walk-out, sold desk).
    if (agent.taskScriptId !== 0) {
      const script = this.workflow.script(agent.taskScriptId);
      const stage = agent.taskKind === "fill" ? "filling" : "verifying";
      if (!script || script.stage !== stage) {
        agent.taskScriptId = 0;
        agent.taskKind = null;
      } else {
        return;
      }
    }

    const assigned = this.assignedStation(state, member);
    const displaced = assigned !== null && state.workingStationId === assigned.id;

    if (member.role === "cashier") {
      // Finish the checkout in hand before considering anywhere else.
      if (
        agent.targetKind === "post" &&
        agent.targetId !== null &&
        agent.arrived &&
        state.workingStationId !== agent.targetId &&
        this.customers.frontIsPaying(agent.targetId)
      ) {
        agent.idleIgm = 0;
        return;
      }
      // Then the longest front line — own desk wins ties. One clerk covers
      // the till and the counter (§8: pickup, drop-off and checkout staffed).
      const best = this.bestFrontStation(state, member, displaced ? null : assigned);
      if (best) {
        agent.idleIgm = 0;
        this.setTarget(agent, "post", best.id, this.workCell(best));
        return;
      }
    } else if (assigned && !displaced && this.stationNeed(assigned) > 0) {
      // Techs and pharmacists: own-station queue first (§9).
      agent.idleIgm = 0;
      this.setTarget(agent, "post", assigned.id, this.workCell(assigned));
      return;
    }

    // Mid-restock: finish the trip.
    if (agent.targetKind === "shelf" && agent.restockLeft > 0) return;

    // Stock Hawks top the floor up between tasks (§9).
    if (member.trait === "stockhawk") {
      const shelf = this.restockTarget(state, agent);
      if (shelf) {
        agent.idleIgm = 0;
        this.setTarget(agent, "shelf", shelf.id, this.shelfCell(shelf, agent));
        return;
      }
    }

    // Nothing to do. Stand at the post a moment, then drift to a break spot.
    agent.idleIgm += IGM_PER_TICK;
    if (assigned && !displaced && agent.idleIgm < IDLE_TO_BREAK_IGM) {
      this.setTarget(agent, "post", assigned.id, this.workCell(assigned));
      return;
    }
    const cell = this.breakCells[index % Math.max(1, this.breakCells.length)];
    if (cell !== undefined) this.setTarget(agent, "break", null, cell);
  }

  /** Advance whatever the agent is standing at: fills, verifies, restocks. */
  private work(state: GameState, agent: StaffAgent, dIgm: number, emit: Emit): void {
    if (agent.targetKind === "counsel") {
      agent.counselLeft -= dIgm;
      return;
    }
    if (!agent.arrived) return;
    const member = agent.member;

    if (agent.targetKind === "shelf" && agent.targetId) {
      if (agent.restockLeft <= 0) agent.restockLeft = taskDuration(member, RESTOCK_IGM);
      agent.restockLeft -= dIgm;
      if (agent.restockLeft > 0) return;
      agent.restockLeft = 0;
      const shelfId = agent.targetId;
      agent.targetKind = "break";
      agent.targetId = null;
      const units = restock(state, shelfId);
      if (units > 0) {
        emit({ type: "stock.restocked", furnitureId: shelfId, units, by: member.name });
        this.workflow.syncStation(state, emit); // fresh bins may unblock a fill
      }
      return;
    }

    if (agent.targetKind !== "post" || !agent.targetId) return;
    const station = state.store.furniture.find((f) => f.id === agent.targetId);
    if (!station) return;

    if (station.defId === "fill_bench" && member.role === "tech") {
      if (agent.taskScriptId === 0) {
        const script = this.workflow.claimFill(emit);
        if (!script) return;
        agent.taskScriptId = script.id;
        agent.taskKind = "fill";
        agent.taskLeft = taskDuration(member, FILL_IGM);
        return;
      }
      agent.taskLeft -= dIgm;
      if (agent.taskLeft > 0) return;
      const scriptId = agent.taskScriptId;
      agent.taskScriptId = 0;
      agent.taskKind = null;
      this.workflow.finishStaffFill(state, scriptId, fillErrorRate(member), emit);
      return;
    }

    if (station.defId === "verify_desk" && member.role === "pharmacist") {
      if (agent.taskScriptId === 0) {
        const script = this.workflow.claimVerify(emit);
        if (!script) return;
        agent.taskScriptId = script.id;
        agent.taskKind = "verify";
        agent.taskLeft = taskDuration(member, VERIFY_IGM);
        return;
      }
      agent.taskLeft -= dIgm;
      if (agent.taskLeft > 0) return;
      const scriptId = agent.taskScriptId;
      agent.taskScriptId = 0;
      agent.taskKind = null;
      this.workflow.finishVerify(state, scriptId, verifyCatchRate(member), emit);
    }
    // Registers and counter lanes are served by the customer system, which
    // asks workerAt() — the cashier just has to be standing here.
  }

  private releaseTask(agent: StaffAgent, emit: Emit): void {
    if (agent.taskScriptId === 0) return;
    if (agent.taskKind === "fill") this.workflow.releaseFill(agent.taskScriptId, emit);
    else this.workflow.releaseVerify(agent.taskScriptId, emit);
    agent.taskScriptId = 0;
    agent.taskKind = null;
  }

  // --- Needs and targets ---

  private assignedStation(state: GameState, member: StaffMember): PlacedFurniture | null {
    if (!member.assignment) return null;
    return state.store.furniture.find((f) => f.id === member.assignment!.stationId) ?? null;
  }

  /** Customers or scripts waiting on this station's queue(s). Pickups count
   *  double — those patients have already waited through fill and verify
   *  (§8: pickup lane first). */
  private stationNeed(station: PlacedFurniture): number {
    switch (station.defId) {
      case "counter_register":
        return this.customers.queueLength(station.id);
      case "counter_service":
        return (
          this.customers.queueLength(`${station.id}#drop`) +
          this.customers.queueLength(`${station.id}#pick`) * 2
        );
      case "fill_bench":
        return this.workflow.fillQueueLength;
      case "verify_desk":
        return this.workflow.verifyQueueLength;
      default:
        return 0;
    }
  }

  /**
   * The front station this cashier should work: the longest queue among
   * their own desk and any front desk with no player, no assignee and no
   * other worker heading for it. Their own desk wins ties; null when every
   * line is empty.
   */
  private bestFrontStation(
    state: GameState,
    member: StaffMember,
    assigned: PlacedFurniture | null,
  ): PlacedFurniture | null {
    let best: PlacedFurniture | null = null;
    let bestNeed = 0;
    if (assigned && FRONT_DEFS.has(assigned.defId)) {
      bestNeed = this.stationNeed(assigned);
      if (bestNeed > 0) best = assigned;
    }
    for (const item of state.store.furniture) {
      if (!FRONT_DEFS.has(item.defId)) continue;
      if (item.id === assigned?.id) continue;
      if (item.id === state.workingStationId) continue;
      const owned = state.store.staff.some(
        (m) => m.id !== member.id && m.assignment?.stationId === item.id,
      );
      if (owned) continue;
      const covered = this.agentList.some(
        (a) => a.member.id !== member.id && a.targetKind === "post" && a.targetId === item.id,
      );
      if (covered) continue;
      const need = this.stationNeed(item);
      if (need > bestNeed) {
        bestNeed = need;
        best = item;
      }
    }
    return best;
  }

  /** Nearest shelf or bin worth a Stock Hawk's trip, uncontested. */
  private restockTarget(state: GameState, agent: StaffAgent): PlacedFurniture | null {
    let best: PlacedFurniture | null = null;
    let bestDist = Infinity;
    for (const item of state.store.furniture) {
      if (!RESTOCK_DEFS.has(item.defId)) continue;
      const units = restockableUnits(state, item.id);
      if (units <= 0) continue;
      if (units < RESTOCK_MIN_UNITS && !hasEmptySlot(state, item.id)) continue;
      const claimed = this.agentList.some(
        (a) => a !== agent && a.targetKind === "shelf" && a.targetId === item.id,
      );
      if (claimed) continue;
      const dist = Math.abs(item.cellX - agent.x) + Math.abs(item.cellY - agent.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    return best;
  }

  private setTarget(agent: StaffAgent, kind: TargetKind, id: string | null, cell: number): void {
    if (agent.targetKind === kind && agent.targetId === id && agent.targetCell === cell) return;
    agent.targetKind = kind;
    agent.targetId = id;
    agent.targetCell = cell;
    agent.arrived = false;
    if (kind !== "shelf") agent.restockLeft = 0; // an abandoned trip starts over
    if (!this.setPath(agent, cell)) {
      // Boxed in (mid-renovation): stand where they are and try again on the
      // next layout change or think.
      agent.arrived = Math.round(agent.x) + Math.round(agent.y) * this.cols === cell;
      agent.path.length = 0;
      agent.pathIdx = 0;
    }
  }

  // --- Cells ---

  /** The cell a worker stands on: behind the station, opposite its facing. */
  private workCell(station: PlacedFurniture): number {
    const def = furnitureDef(station.defId);
    const rect = footprintRect(def.cells, station.cellX, station.cellY, station.rot);
    const [fx, fy] = FACING[station.rot]!;
    // The behind row's first cell lands on the drop-off half for counters —
    // the counsel spot takes the pickup half (counselCell below).
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const bx = x - fx;
        const by = y - fy;
        if (this.inBounds(bx, by) && this.walk[cellIndex(this.cols, bx, by)]) {
          return cellIndex(this.cols, bx, by);
        }
      }
    }
    return this.anyAdjacent(rect) ?? cellIndex(this.cols, rect.x, rect.y);
  }

  /** Where the pharmacist stands for a counter-side chat: behind pickup. */
  private counselCell(counter: PlacedFurniture): number {
    const [fx, fy] = FACING[counter.rot]!;
    // Pickup tray sits on the second lane cell (customers.ts laneCells).
    const def = furnitureDef(counter.defId);
    const rect = footprintRect(def.cells, counter.cellX, counter.cellY, counter.rot);
    const pickX = rect.x + rect.w - 1;
    const pickY = rect.y + rect.h - 1;
    const bx = pickX - fx;
    const by = pickY - fy;
    if (this.inBounds(bx, by) && this.walk[cellIndex(this.cols, bx, by)]) {
      return cellIndex(this.cols, bx, by);
    }
    return this.workCell(counter);
  }

  /** A cell in front of the shelf's face to restock from. */
  private shelfCell(shelf: PlacedFurniture, agent: StaffAgent): number {
    const def = furnitureDef(shelf.defId);
    const rect = footprintRect(def.cells, shelf.cellX, shelf.cellY, shelf.rot);
    const [fx, fy] = FACING[shelf.rot]!;
    let best = -1;
    let bestDist = Infinity;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const nx = x + fx;
        const ny = y + fy;
        if (!this.inBounds(nx, ny)) continue;
        const cell = cellIndex(this.cols, nx, ny);
        if (!this.walk[cell]) continue;
        const dist = Math.abs(nx - agent.x) + Math.abs(ny - agent.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = cell;
        }
      }
    }
    if (best !== -1) return best;
    return this.anyAdjacent(rect) ?? this.workCell(shelf);
  }

  private anyAdjacent(rect: CellRect): number | null {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        for (const [dx, dy] of FACING) {
          const nx = x + dx;
          const ny = y + dy;
          if (this.inBounds(nx, ny) && this.walk[cellIndex(this.cols, nx, ny)]) {
            return cellIndex(this.cols, nx, ny);
          }
        }
      }
    }
    return null;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.cols && y >= 0 && y < this.rows;
  }

  /** Break spots (§9): quiet corners, backroom first, away from the queues. */
  private computeBreakCells(state: GameState): void {
    const { cols, rows } = this;
    const zone = backroomZone(state);
    const scored: { cell: number; score: number }[] = [];
    const doorY = rows - 1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = cellIndex(cols, x, y);
        if (!this.walk[cell]) continue;
        if (this.customers.isQueueCell(cell)) continue;
        const inZone =
          zone !== null && x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h;
        // Deep corners score high; the doorway scores off the list.
        const edge = Math.min(x, cols - 1 - x);
        const score = (inZone ? 40 : 0) + (doorY - y) * 2 - edge * 1.5;
        scored.push({ cell, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    this.breakCells = scored.slice(0, 8).map((s) => s.cell);
  }

  // --- Movement (no cell claims: staff thread through the crowd) ---

  private setPath(agent: StaffAgent, destCell: number): boolean {
    const { cols } = this;
    const sx = Math.round(agent.x);
    const sy = Math.round(agent.y);
    const savedStart = this.walk[cellIndex(cols, sx, sy)]!;
    this.walk[cellIndex(cols, sx, sy)] = 1; // step out of anything they're inside
    const tx = destCell % cols;
    const ty = (destCell - tx) / cols;
    const len = this.pathfinder.findPath(this.walk, sx, sy, tx, ty, this.pathScratch);
    this.walk[cellIndex(cols, sx, sy)] = savedStart;
    if (len === -1) return false;
    agent.path.length = 0;
    for (const cell of this.pathScratch) agent.path.push(cell);
    agent.pathIdx = 0;
    return true;
  }

  private stepAgent(state: GameState, agent: StaffAgent, dIgm: number): void {
    if (agent.arrived) return;
    let budget = WALK_SPEED * dIgm;
    while (budget > 0) {
      if (agent.pathIdx >= agent.path.length) {
        agent.arrived = true;
        this.settleFacing(state, agent);
        return;
      }
      const cell = agent.path[agent.pathIdx]!;
      const tx = cell % this.cols;
      const ty = (cell - tx) / this.cols;
      const dx = tx - agent.x;
      const dy = ty - agent.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-4) {
        const move = Math.min(budget, dist);
        agent.x += (dx / dist) * move;
        agent.y += (dy / dist) * move;
        agent.yaw = Math.atan2(dx, dy);
        agent.stride += move;
        budget -= move;
        if (move < dist - 1e-6) return;
      }
      agent.x = tx;
      agent.y = ty;
      agent.pathIdx++;
    }
  }

  /** On arrival, face the work: outward at a station, inward at a shelf. */
  private settleFacing(state: GameState, agent: StaffAgent): void {
    const id = agent.targetId;
    if (!id) return;
    const item = state.store.furniture.find((f) => f.id === id);
    if (!item) return;
    const [fx, fy] = FACING[item.rot]!;
    if (agent.targetKind === "shelf") agent.yaw = Math.atan2(-fx, -fy);
    else agent.yaw = Math.atan2(fx, fy);
  }
}
