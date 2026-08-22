// SimEvent union — everything the sim announces to render/ and ui/.

import type { DayPhase, GameSpeed, PlacedFurniture } from "./state";

export type SimEvent =
  | { type: "day.phaseChanged"; phase: DayPhase; day: number }
  | { type: "clock.minute"; igm: number }
  | { type: "speed.changed"; speed: GameSpeed }
  | { type: "build.changed"; active: boolean }
  | { type: "furniture.placed"; item: PlacedFurniture }
  | { type: "furniture.moved"; item: PlacedFurniture }
  | { type: "furniture.sold"; id: string; refund: number }
  | { type: "cash.changed"; cash: number };
