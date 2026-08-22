// SimEvent union — everything the sim announces to render/ and ui/.

import type { DayPhase, GameSpeed } from "./state";

export type SimEvent =
  | { type: "day.phaseChanged"; phase: DayPhase; day: number }
  | { type: "clock.minute"; igm: number }
  | { type: "speed.changed"; speed: GameSpeed };
