// Sim facade: owns GameState, ticks the clock + customers, accepts commands,
// emits events. Pure simulation — no DOM, no three.js.

import type { EventBus } from "../core/bus";
import { DAY_END_IGM, IGM_PER_TICK } from "../core/clock";
import type { Rot } from "../core/grid";
import { handleCommand, type Command } from "./commands";
import { applyRep, CustomerSystem, REP_REASONS } from "./customers";
import { closeDay, groupTotal } from "./economy";
import type { SimEvent } from "./events";
import { hasEmptySlot, restockableUnits, rollHistory } from "./inventory";
import {
  backroomZone,
  itemAvailability,
  validatePlacement,
  type PlacementCheck,
} from "./placement";
import { refreshHiringPool } from "./staff";
import { StaffSystem } from "./staffSystem";
import { createGameState, type GameState } from "./state";
import { RxWorkflow } from "./workflow";

/** §15 family-loan reputation cost — "word gets around". */
const REP_FAMILY_LOAN = -0.3;

export class Sim {
  readonly customers: CustomerSystem;
  readonly workflow: RxWorkflow;
  readonly staff: StaffSystem;
  private state: GameState;
  private lastEmittedMinute: number;
  private emit: (event: SimEvent) => void;

  /** `initial` comes from a hydrated save (§23); omit it for a new run. */
  constructor(
    private bus: EventBus<SimEvent>,
    initial?: GameState,
  ) {
    this.state = initial ?? createGameState();
    this.lastEmittedMinute = Math.floor(this.state.clockIgm);
    this.emit = (event) => this.bus.emit(event);
    this.workflow = new RxWorkflow();
    this.customers = new CustomerSystem(this.state, this.workflow);
    // Binds itself back into the customer system on construction.
    this.staff = new StaffSystem(this.state, this.workflow, this.customers);
    // New games and freshly migrated saves start with an undrawn pool (§9).
    refreshHiringPool(this.state);
  }

  /** Read-only view of the state for HUD rendering. Never mutate through this. */
  get snapshot(): Readonly<GameState> {
    return this.state;
  }

  dispatch(command: Command): void {
    handleCommand(this.state, command, this.emit);
    switch (command.type) {
      case "store.open":
        if (this.state.phase === "shift") this.customers.beginDay(this.state);
        break;
      case "day.advance":
        this.staff.beginDay(this.state, this.emit);
        break;
      case "furniture.place":
      case "furniture.move":
      case "furniture.sell":
        this.customers.layoutChanged(this.state, this.emit);
        this.staff.layoutChanged(this.state, this.emit);
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "station.workHere":
      case "station.leave":
      case "build.enter":
        // The displaced worker lets go of their script before the player's
        // hands reach for the same queue.
        this.staff.playerStationChanged(this.state, this.emit);
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "staff.hire":
      case "staff.fire":
        this.staff.rosterChanged(this.state, this.emit);
        break;
      case "fill.pickBin":
        this.workflow.pickBin(command.drugId, this.emit);
        break;
      case "stock.restock":
        // Fresh bin units may unblock a fill the bench gave up on.
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "dev.stressToggle": {
        const mult = this.customers.cycleStress(this.state);
        this.bus.emit({ type: "dev.stress", mult });
        break;
      }
    }
    this.lastEmittedMinute = Math.floor(this.state.clockIgm);
  }

  // --- Read-only selectors (SPEC §4) ---

  /** Can this def be bought right now (gates, uniqueness, cash)? */
  itemAvailability(defId: string): PlacementCheck {
    return itemAvailability(this.state, defId);
  }

  /** Would placing (or moving, with ignoreId) at this cell be valid, and why not? */
  validatePlacement(
    defId: string,
    cellX: number,
    cellY: number,
    rot: Rot,
    ignoreId?: string,
  ): PlacementCheck {
    return validatePlacement(this.state, defId, cellX, cellY, rot, ignoreId);
  }

  /** Backroom zone rect derived from the service counter, or null. */
  backroomZone(): ReturnType<typeof backroomZone> {
    return backroomZone(this.state);
  }

  /** Customers currently queued at a register (queue chip, §27). */
  queueLength(stationId: string): number {
    return this.customers.queueLength(stationId);
  }

  /** Units this shelf or bin could take from the backroom right now (§11). */
  restockableUnits(furnitureId: string): number {
    return restockableUnits(this.state, furnitureId);
  }

  /** True when a label on this shelf has run dry — the chip turns rose. */
  hasEmptySlot(furnitureId: string): boolean {
    return hasEmptySlot(this.state, furnitureId);
  }

  /** A verifier is on duty when the player works a desk or a pharmacist is
   *  stationed at one (§8: scripts queue for them, even mid-walk). */
  private verifierOnDuty(): boolean {
    const desks = this.state.store.furniture.filter((f) => f.defId === "verify_desk");
    if (desks.length === 0) return false;
    if (desks.some((d) => d.id === this.state.workingStationId)) return true;
    return this.state.store.staff.some(
      (m) =>
        m.role === "pharmacist" &&
        m.assignment &&
        desks.some((d) => d.id === m.assignment!.stationId),
    );
  }

  /** Advance one fixed tick (100 ms scaled). Clock only moves during the shift. */
  tick(): void {
    if (this.state.buildMode) return;
    if (this.state.phase !== "shift") return;

    if (this.state.clockIgm < DAY_END_IGM) {
      this.state.clockIgm += IGM_PER_TICK;
      if (this.state.clockIgm >= DAY_END_IGM - 1e-9) {
        this.state.clockIgm = DAY_END_IGM;
      }
      const minute = Math.floor(this.state.clockIgm);
      if (minute !== this.lastEmittedMinute) {
        this.lastEmittedMinute = minute;
        this.bus.emit({ type: "clock.minute", igm: this.state.clockIgm });
      }
    }

    this.workflow.setVerifier(this.state, this.verifierOnDuty(), this.emit);
    this.staff.tick(this.state, this.emit);
    this.customers.tick(this.state, this.emit);
    this.workflow.tick(this.state, this.emit);

    // 20:00: the clock freezes while remaining customers finish (§5),
    // then the day closes.
    if (this.state.clockIgm >= DAY_END_IGM && this.customers.activeCount === 0) {
      if (this.state.workingStationId !== null) {
        this.state.workingStationId = null;
        this.bus.emit({ type: "station.changed", stationId: null });
      }
      // §15 daily drift: 1% toward 2.5 (neglect decays, grudges fade).
      applyRep(this.state, (2.5 - this.state.repStars) * 0.01, this.emit, REP_REASONS.drift);
      // §10 books: fixed costs, loan servicing, then Aunt Rosa's soft floor.
      const gross = groupTotal(this.state.dayStats, "revenue");
      const summary = closeDay(this.state, this.emit);
      if (summary.familyLoan > 0) {
        applyRep(this.state, REP_FAMILY_LOAN, this.emit, REP_REASONS.familyLoan);
      }
      rollHistory(this.state, gross);
      this.state.phase = "close";
      this.bus.emit({ type: "day.phaseChanged", phase: this.state.phase, day: this.state.day });
    }
  }
}
