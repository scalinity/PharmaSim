// Sim facade: owns GameState, ticks the clock + customers, accepts commands,
// emits events. Pure simulation — no DOM, no three.js.

import type { EventBus } from "../core/bus";
import { DAY_END_IGM, IGM_PER_TICK } from "../core/clock";
import type { Rot } from "../core/grid";
import { handleCommand, type Command } from "./commands";
import { applyRep, CustomerSystem, REP_REASONS } from "./customers";
import type { SimEvent } from "./events";
import {
  backroomZone,
  itemAvailability,
  validatePlacement,
  type PlacementCheck,
} from "./placement";
import { createGameState, type GameState } from "./state";
import { RxWorkflow } from "./workflow";

export class Sim {
  readonly customers: CustomerSystem;
  readonly workflow: RxWorkflow;
  private state: GameState;
  private lastEmittedMinute: number;
  private emit: (event: SimEvent) => void;

  constructor(private bus: EventBus<SimEvent>) {
    this.state = createGameState();
    this.lastEmittedMinute = Math.floor(this.state.clockIgm);
    this.emit = (event) => this.bus.emit(event);
    this.workflow = new RxWorkflow();
    this.customers = new CustomerSystem(this.state, this.workflow);
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
      case "furniture.place":
      case "furniture.move":
      case "furniture.sell":
        this.customers.layoutChanged(this.state, this.emit);
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "station.workHere":
      case "station.leave":
      case "build.enter":
        this.workflow.syncStation(this.state, this.emit);
        break;
      case "fill.pickBin":
        this.workflow.pickBin(command.drugId, this.emit);
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
      this.state.phase = "close";
      this.bus.emit({ type: "day.phaseChanged", phase: this.state.phase, day: this.state.day });
    }
  }
}
