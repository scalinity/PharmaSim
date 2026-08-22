// Command union + handlers. All mutations of GameState go through here.
// Furniture commands re-validate via placement.ts; the UI validates first
// and surfaces reasons, so failed commands are silent no-ops.

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";
import { furnitureDef } from "../data/furniture";
import type { SimEvent } from "./events";
import { validatePlacement } from "./placement";
import type { GameState, GameSpeed } from "./state";

export type Command =
  | { type: "store.open" }
  | { type: "day.advance" }
  | { type: "speed.set"; speed: GameSpeed }
  | { type: "build.enter" }
  | { type: "build.exit" }
  | { type: "furniture.place"; defId: string; cellX: number; cellY: number; rot: Rot }
  | { type: "furniture.move"; id: string; cellX: number; cellY: number; rot: Rot }
  | { type: "furniture.sell"; id: string };

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
    case "build.enter": {
      if (state.buildMode || state.phase === "close") return;
      state.buildMode = true;
      emit({ type: "build.changed", active: true });
      return;
    }
    case "build.exit": {
      if (!state.buildMode) return;
      state.buildMode = false;
      emit({ type: "build.changed", active: false });
      return;
    }
    case "furniture.place": {
      const { defId, cellX, cellY, rot } = command;
      if (!validatePlacement(state, defId, cellX, cellY, rot).ok) return;
      const def = furnitureDef(defId);
      const item = { id: `f${state.store.nextFurnitureId++}`, defId, cellX, cellY, rot };
      state.store.furniture.push(item);
      state.cash -= def.cost;
      emit({ type: "furniture.placed", item: { ...item } });
      emit({ type: "cash.changed", cash: state.cash });
      return;
    }
    case "furniture.move": {
      const item = state.store.furniture.find((f) => f.id === command.id);
      if (!item) return;
      const { cellX, cellY, rot } = command;
      if (!validatePlacement(state, item.defId, cellX, cellY, rot, item.id).ok) return;
      item.cellX = cellX;
      item.cellY = cellY;
      item.rot = rot;
      emit({ type: "furniture.moved", item: { ...item } });
      return;
    }
    case "furniture.sell": {
      const index = state.store.furniture.findIndex((f) => f.id === command.id);
      if (index === -1) return;
      const item = state.store.furniture[index]!;
      const refund = Math.round(furnitureDef(item.defId).cost / 2);
      state.store.furniture.splice(index, 1);
      state.cash += refund;
      emit({ type: "furniture.sold", id: item.id, refund });
      emit({ type: "cash.changed", cash: state.cash });
      return;
    }
  }
}
