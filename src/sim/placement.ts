// Placement rules (SPEC §6): footprint fit, zone rules, wall mounts,
// flood-fill reachability, gates, and cash. Shared by the command handlers
// (authoritative) and the UI (ghost tint, palette states, toast reasons).

import {
  cellIndex,
  deriveBackroom,
  doorCells,
  footprintRect,
  rectContains,
  rectInBounds,
  wallDir,
  type CellRect,
  type Rot,
} from "../core/grid";
import { floodFill } from "../core/pathfind";
import { furnitureDef, LICENSE_NAMES, type FurnitureDef } from "../data/furniture";
import { activeStore, type GameState, type PlacedFurniture } from "./state";

export type PlacementCheck = { ok: true } | { ok: false; reason: string };

function itemRect(item: PlacedFurniture): CellRect {
  return footprintRect(furnitureDef(item.defId).cells, item.cellX, item.cellY, item.rot);
}

/** Backroom zone derived from the service counter's line, or null. */
export function backroomZone(state: GameState, ignoreId?: string): CellRect | null {
  const counter = activeStore(state).furniture.find(
    (f) => f.defId === "counter_service" && f.id !== ignoreId,
  );
  if (!counter) return null;
  const { cols, rows } = activeStore(state).grid;
  return deriveBackroom(itemRect(counter), counter.rot, cols, rows);
}

/**
 * True when furniture stands where the door would sit on a cols×rows floor.
 * §6 keeps the door south-center, so it moves when the walls do — an
 * expansion must not drop it under a fixture placed legally on the old floor,
 * or the flood fill would refuse every placement from then on.
 */
export function doorwayBlocked(state: GameState, cols: number, rows: number): boolean {
  const doors = doorCells(cols, rows);
  return activeStore(state).furniture.some((item) => {
    if (furnitureDef(item.defId).walkable) return false;
    const rect = itemRect(item);
    return doors.some(([x, y]) => rectContains(rect, x, y));
  });
}

/** Why a def can't be bought right now (license/era/equipment gates), or null. */
export function gateReason(state: GameState, def: FurnitureDef): string | null {
  if (!def.requires) return null;
  const { license, era, furniture } = def.requires;
  if (license && !state.licenses.includes(license)) {
    return `Needs the ${LICENSE_NAMES[license] ?? license} license`;
  }
  if (era && activeStore(state).era < era) return `Needs the Gen ${era} renovation`;
  if (furniture) {
    for (const requiredId of furniture) {
      if (!activeStore(state).furniture.some((f) => f.defId === requiredId)) {
        return `Needs a ${furnitureDef(requiredId).name.toLowerCase()}`;
      }
    }
  }
  return null;
}

/** Palette availability: gates, uniqueness, then cash. */
export function itemAvailability(state: GameState, defId: string): PlacementCheck {
  const def = furnitureDef(defId);
  const gate = gateReason(state, def);
  if (gate) return { ok: false, reason: gate };
  if (def.unique && activeStore(state).furniture.some((f) => f.defId === def.id)) {
    return { ok: false, reason: "One per store" };
  }
  if (state.cash < def.cost) {
    return { ok: false, reason: `Short $${(def.cost - state.cash).toLocaleString("en-US")}` };
  }
  return { ok: true };
}

interface CellMaps {
  /** Cell holds any furniture (no stacking). */
  occupied: Uint8Array;
  /** Cell is impassable for pathing (walkable decor doesn't block). */
  walkable: Uint8Array;
}

function buildCellMaps(state: GameState, ignoreId: string | undefined): CellMaps {
  const { cols, rows } = activeStore(state).grid;
  const occupied = new Uint8Array(cols * rows);
  const walkable = new Uint8Array(cols * rows).fill(1);
  for (const item of activeStore(state).furniture) {
    if (item.id === ignoreId) continue;
    const def = furnitureDef(item.defId);
    const rect = itemRect(item);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const cell = cellIndex(cols, x, y);
        occupied[cell] = 1;
        if (!def.walkable) walkable[cell] = 0;
      }
    }
  }
  return { occupied, walkable };
}

function blockRect(walkable: Uint8Array, cols: number, rect: CellRect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) walkable[cellIndex(cols, x, y)] = 0;
  }
}

/** True when the rect has at least one 4-adjacent cell marked reachable. */
function hasReachableNeighbor(
  rect: CellRect,
  reached: Uint8Array,
  cols: number,
  rows: number,
): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (x > 0 && reached[cellIndex(cols, x - 1, y)]) return true;
      if (x < cols - 1 && reached[cellIndex(cols, x + 1, y)]) return true;
      if (y > 0 && reached[cellIndex(cols, x, y - 1)]) return true;
      if (y < rows - 1 && reached[cellIndex(cols, x, y + 1)]) return true;
    }
  }
  return false;
}

/**
 * Full placement validation for buying (`ignoreId` unset) or moving
 * (`ignoreId` = the item being moved; skips gates and cash).
 */
export function validatePlacement(
  state: GameState,
  defId: string,
  cellX: number,
  cellY: number,
  rot: Rot,
  ignoreId?: string,
): PlacementCheck {
  const def = furnitureDef(defId);
  const { cols, rows } = activeStore(state).grid;

  if (!ignoreId) {
    const availability = itemAvailability(state, defId);
    if (!availability.ok) return availability;
  }

  const rect = footprintRect(def.cells, cellX, cellY, rot);
  if (!rectInBounds(rect, cols, rows)) return { ok: false, reason: "Outside the floor" };

  const { occupied, walkable } = buildCellMaps(state, ignoreId);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (occupied[cellIndex(cols, x, y)]) return { ok: false, reason: "Space is taken" };
    }
  }

  if (def.zone !== "any") {
    // The moved counter itself is zone 'any', so deriving from the remaining
    // furniture (minus ignoreId) is always the right line.
    const zone = backroomZone(state, ignoreId);
    if (def.zone === "backroom") {
      if (!zone) return { ok: false, reason: "Place the service counter first" };
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          if (!rectContains(zone, x, y)) {
            return { ok: false, reason: "Belongs in the backroom" };
          }
        }
      }
    } else if (zone) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          if (rectContains(zone, x, y)) {
            return { ok: false, reason: "Belongs on the shop floor" };
          }
        }
      }
    }
  }

  const doors = doorCells(cols, rows);
  if (def.wallMounted) {
    const [dx, dy] = wallDir(rot);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const wallX = x + dx;
        const wallY = y + dy;
        const onPerimeter = wallX < 0 || wallX >= cols || wallY < 0 || wallY >= rows;
        const overDoorGap = dy > 0 && doors.some(([doorX]) => doorX === x);
        if (!onPerimeter || overDoorGap) return { ok: false, reason: "Needs a wall behind it" };
      }
    }
  }

  // Reachability: door ↔ every station must stay connected (flood fill).
  if (!def.walkable) blockRect(walkable, cols, rect);
  const reached = floodFill(cols, rows, walkable, doors);
  if (!doors.some(([x, y]) => reached[cellIndex(cols, x, y)])) {
    return { ok: false, reason: "Blocks the door" };
  }
  if (def.needsAccess && !hasReachableNeighbor(rect, reached, cols, rows)) {
    return { ok: false, reason: "No path from the door" };
  }
  for (const item of activeStore(state).furniture) {
    if (item.id === ignoreId) continue;
    const itemDef = furnitureDef(item.defId);
    if (!itemDef.needsAccess) continue;
    if (!hasReachableNeighbor(itemRect(item), reached, cols, rows)) {
      return { ok: false, reason: `Cuts off the ${itemDef.name.toLowerCase()}` };
    }
  }

  return { ok: true };
}
