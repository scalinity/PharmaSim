// Sim facade: owns GameState, ticks the clock + customers, accepts commands,
// emits events. Pure simulation — no DOM, no three.js.

import type { EventBus } from "../core/bus";
import { DAY_END_IGM, IGM_PER_TICK } from "../core/clock";
import type { Rot } from "../core/grid";
import { rollCityDay } from "./city";
import { handleCommand, type Command } from "./commands";
import { applyRep, CustomerSystem, REP_REASONS } from "./customers";
import { closeDay, groupTotal, operatingProfit } from "./economy";
import type { SimEvent } from "./events";
import { endOutageAtClose, ensurePlanned, stormToday, tickWorld } from "./events-world";
import { hasEmptySlot, restockableUnits, rollHistory } from "./inventory";
import { recordMoment } from "./legacy";
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
  /** §17: today was actually planned (beginDay ran). A renovation morning
   *  opens onto scaffolding with no plan, and its close must not roll an
   *  empty day into the observed log — "four weeks" means 28 played days. */
  private dayPlanned = false;

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
    // §16: a fresh run or a just-migrated save plans its current season and
    // year here, so the first morning's world is already scheduled.
    ensurePlanned(this.state);
  }

  /** Read-only view of the state for HUD rendering. Never mutate through this. */
  get snapshot(): Readonly<GameState> {
    return this.state;
  }

  dispatch(command: Command): void {
    // Captured before the handler runs: rebuilds below must key on what the
    // command actually *did*, not on it having been dispatched — a refused
    // expansion (wrong phase, short cash, blocked doorway) changes nothing.
    const { cols: colsBefore, rows: rowsBefore } = this.state.store.grid;
    const pendingEraBefore = this.state.pendingEra;
    const dayBefore = this.state.day;
    const phaseBefore = this.state.phase;
    handleCommand(this.state, command, this.emit);
    switch (command.type) {
      case "store.open":
        // Only when the handler actually opened (morning → shift) — a
        // refused mid-shift dispatch still reads phase "shift", and a
        // second beginDay would re-roll arrivals and double-log the day's
        // routed share. A renovation morning opens onto scaffolding, not a
        // shift: nobody is scheduled, and the empty floor closes the day
        // on the first tick.
        if (phaseBefore === "morning" && this.state.phase === "shift") {
          if (this.state.pendingEra === null) {
            this.customers.beginDay(this.state);
            this.dayPlanned = true;
          }
          // §16 rain bed for a storm day — a hook milestone 17's audio takes.
          if (stormToday(this.state)) {
            this.bus.emit({ type: "ambience.rain", on: true });
          }
        }
        break;
      case "era.renovate":
        // Only when the handler actually took the purchase (§13): whoever is
        // inside finishes their business; the schedule for the rest of the
        // day is torn up.
        if (this.state.pendingEra !== pendingEraBefore) this.customers.cancelArrivals();
        break;
      case "day.advance":
        this.staff.beginDay(this.state, this.emit);
        break;
      case "dev.skipDay":
        // Only when the handler actually turned the page (morning phase) —
        // the key is global, and a refused skip must not reset the crew.
        if (this.state.day !== dayBefore) this.staff.beginDay(this.state, this.emit);
        break;
      case "furniture.place":
      case "furniture.move":
      case "furniture.sell":
        this.customers.layoutChanged(this.state, this.emit);
        this.staff.layoutChanged(this.state, this.emit);
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "expansion.buy": {
        // §6: the grid itself grew (morning-only, nobody on the floor) —
        // both agent systems rebuild their cell-indexed world, matching the
        // render layer's expansion.bought listeners.
        const grid = this.state.store.grid;
        if (grid.cols !== colsBefore || grid.rows !== rowsBefore) {
          this.customers.gridChanged(this.state);
          this.staff.gridChanged(this.state, this.emit);
        }
        break;
      }
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

    // §16 storm-day outage edges: the drop (spoilage or the generator's
    // hum) and the restored announcement, both off the persisted window.
    tickWorld(this.state, this.emit);

    this.workflow.setVerifier(this.state, this.verifierOnDuty(), this.emit);
    this.staff.tick(this.state, this.emit);
    this.customers.tick(this.state, this.emit);
    this.workflow.tick(this.state, this.emit);

    // 20:00: the clock freezes while remaining customers finish (§5), then
    // the day closes. A renovation day (§13) closes the moment the floor is
    // empty — the crew is waiting on the last customer, not on the clock.
    const dayOver = this.state.clockIgm >= DAY_END_IGM || this.state.pendingEra !== null;
    if (dayOver && this.customers.activeCount === 0) {
      // §16: a renovation can close the day mid-outage — the power comes
      // back with the shift, and a storm day's rain bed stops here too.
      endOutageAtClose(this.state, this.emit);
      if (stormToday(this.state)) this.bus.emit({ type: "ambience.rain", on: false });
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
      // §22: the first night the books close genuinely ahead is a moment.
      if (operatingProfit(this.state.dayStats) > 0) {
        recordMoment(this.state, "first_profit", this.emit);
      }
      rollHistory(this.state, gross);
      // §17: a played day's observed demand joins the 28-day window. An
      // unplanned day (renovation scaffolding) saw nothing and stays out,
      // matching the share log's one-entry-per-played-day rule.
      if (this.dayPlanned) rollCityDay(this.state);
      this.dayPlanned = false;
      this.state.phase = "close";
      this.bus.emit({ type: "day.phaseChanged", phase: this.state.phase, day: this.state.day });
    }
  }
}
