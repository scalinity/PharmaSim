// Command union + handlers. All mutations of GameState go through here.

import { DAY_START_IGM } from "../core/clock";
import type { SimEvent } from "./events";
import type { GameState, GameSpeed } from "./state";

export type Command =
  | { type: "store.open" }
  | { type: "day.advance" }
  | { type: "speed.set"; speed: GameSpeed };

export function handleCommand(
  state: GameState,
  command: Command,
  emit: (event: SimEvent) => void,
): void {
  switch (command.type) {
    case "store.open": {
      if (state.phase !== "morning") return;
      state.phase = "shift";
      emit({ type: "day.phaseChanged", phase: state.phase, day: state.day });
      return;
    }
    case "day.advance": {
      if (state.phase !== "close") return;
      state.day += 1;
      state.clockIgm = DAY_START_IGM;
      state.phase = "morning";
      emit({ type: "day.phaseChanged", phase: state.phase, day: state.day });
      emit({ type: "clock.minute", igm: state.clockIgm });
      return;
    }
    case "speed.set": {
      if (state.speed === command.speed) return;
      state.speed = command.speed;
      emit({ type: "speed.changed", speed: state.speed });
      return;
    }
  }
}
