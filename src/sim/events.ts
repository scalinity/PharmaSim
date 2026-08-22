// SimEvent union — everything the sim announces to render/ and ui/.

import type { Archetype } from "./customers";
import type { DayPhase, GameSpeed, PlacedFurniture } from "./state";

export type SimEvent =
  | { type: "day.phaseChanged"; phase: DayPhase; day: number }
  | { type: "clock.minute"; igm: number }
  | { type: "speed.changed"; speed: GameSpeed }
  | { type: "build.changed"; active: boolean }
  | { type: "furniture.placed"; item: PlacedFurniture }
  | { type: "furniture.moved"; item: PlacedFurniture }
  | { type: "furniture.sold"; id: string; refund: number }
  | { type: "cash.changed"; cash: number }
  | { type: "customer.spawned"; id: number; archetype: Archetype }
  | { type: "customer.walkout"; id: number; archetype: Archetype }
  | { type: "sale.completed"; customerId: number; items: number; total: number }
  | { type: "rep.changed"; stars: number; delta: number }
  | { type: "station.changed"; stationId: string | null }
  | { type: "dev.stress"; mult: number };
