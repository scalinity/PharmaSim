// GameState root type + factory (SPEC §5, §26).

import { DAY_START_IGM } from "../core/clock";

export type DayPhase = "morning" | "shift" | "close";
export type GameSpeed = 0 | 1 | 2;

export interface GameState {
  day: number;
  /** In-game minute of day; 480 = 08:00. Frozen outside the shift phase. */
  clockIgm: number;
  phase: DayPhase;
  cash: number;
  repStars: number;
  speed: GameSpeed;
}

export function createGameState(): GameState {
  return {
    day: 1,
    clockIgm: DAY_START_IGM,
    phase: "morning",
    cash: 12_000,
    repStars: 2.5,
    speed: 1,
  };
}
