// Sim facade: owns GameState, ticks the clock, accepts commands, emits events.
// Pure simulation — no DOM, no three.js.

import type { EventBus } from "../core/bus";
import { DAY_END_IGM, IGM_PER_TICK } from "../core/clock";
import type { Rot } from "../core/grid";
import { handleCommand, type Command } from "./commands";
import type { SimEvent } from "./events";
import {
  backroomZone,
  itemAvailability,
  validatePlacement,
  type PlacementCheck,
} from "./placement";
import { createGameState, type GameState } from "./state";

export class Sim {
  private state: GameState;
  private lastEmittedMinute: number;

  constructor(private bus: EventBus<SimEvent>) {
    this.state = createGameState();
    this.lastEmittedMinute = Math.floor(this.state.clockIgm);
  }

  /** Read-only view of the state for HUD rendering. Never mutate through this. */
  get snapshot(): Readonly<GameState> {
    return this.state;
  }

  dispatch(command: Command): void {
    handleCommand(this.state, command, (event) => this.bus.emit(event));
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

  /** Advance one fixed tick (100 ms scaled). Clock only moves during the shift. */
  tick(): void {
    if (this.state.buildMode) return;
    if (this.state.phase !== "shift") return;

    this.state.clockIgm += IGM_PER_TICK;

    if (this.state.clockIgm >= DAY_END_IGM - 1e-9) {
      this.state.clockIgm = DAY_END_IGM;
    }

    const minute = Math.floor(this.state.clockIgm);
    if (minute !== this.lastEmittedMinute) {
      this.lastEmittedMinute = minute;
      this.bus.emit({ type: "clock.minute", igm: this.state.clockIgm });
    }

    if (this.state.clockIgm >= DAY_END_IGM) {
      this.state.phase = "close";
      this.bus.emit({ type: "day.phaseChanged", phase: this.state.phase, day: this.state.day });
    }
  }
}
