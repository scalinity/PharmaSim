// Sim facade: owns GameState, ticks the clock, accepts commands, emits events.
// Pure simulation — no DOM, no three.js.

import type { EventBus } from "../core/bus";
import { DAY_END_IGM, IGM_PER_TICK } from "../core/clock";
import { handleCommand, type Command } from "./commands";
import type { SimEvent } from "./events";
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

  /** Advance one fixed tick (100 ms scaled). Clock only moves during the shift. */
  tick(): void {
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
