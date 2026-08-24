// Pointer → grid picking and the build-mode interaction state machine:
// palette selection spawns a grid-snapped ghost (R rotates, click places,
// right-click/Esc cancels), clicking placed furniture selects it for
// move/sell, and P toggles the debug A* path overlay (SPEC §6).

import { Plane, Raycaster, Vector2, Vector3, type Mesh, type OrthographicCamera } from "three";
import type { EventBus } from "../core/bus";
import { cellIndex, doorCells, rotatedSize, type Rot } from "../core/grid";
import { Pathfinder } from "../core/pathfind";
import { furnitureDef, STATION_NAMES } from "../data/furniture";
import type { SimEvent } from "../sim/events";
import type { Sim } from "../sim/sim";
import { activeStore } from "../sim/state";
import type { RxBinBoard } from "./rxBins";
import { FLOOR_Y, type StoreScene } from "./storeScene";

const CLICK_SLOP_PX = 5;

/** Fixtures a click restocks from the backroom (§11, §14, §25). */
const RESTOCK_DEFS = new Set(["otc_shelf", "rx_shelf", "cabinet_controlled", "fridge_medical"]);

export interface BuildSelection {
  id: string;
  defId: string;
}

export interface PickingCallbacks {
  toast(message: string, tone?: "error" | "info"): void;
  /** Placed item selected/deselected for move/sell. */
  selectionChanged(selection: BuildSelection | null): void;
  /** Palette def picked up / put down as the placement ghost. */
  paletteChanged(defId: string | null): void;
  /** Station interaction hint while hovering a register mid-shift. */
  stationHint(text: string | null): void;
  /** OTC shelf under the pointer (§11 price tags + restock), or null. */
  shelfHover(shelfId: string | null, clientX: number, clientY: number): void;
  /** Medical fridge under the pointer (§14 capacity meter), or null. */
  fridgeHover(fridgeId: string | null, clientX: number, clientY: number): void;
}

export class Picking {
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private floorPlane = new Plane(new Vector3(0, 1, 0), -FLOOR_Y);
  private hitPoint = new Vector3();

  /** Def riding the ghost (a new buy, or the moving item's def). */
  private ghostDefId: string | null = null;
  private movingId: string | null = null;
  private ghostRot: Rot = 0;
  private selection: BuildSelection | null = null;

  private hoverCellX = -1;
  private hoverCellY = -1;
  private hasHoverCell = false;

  private pathOn = false;
  private pathfinder: Pathfinder;
  private pathOut: number[] = [];
  private bestPath: number[] = [];

  private downX = 0;
  private downY = 0;
  private downButton = -1;
  private canvasCursor = "";
  /** City view up (M12): the store's picking sleeps under the map. */
  private suspended = false;

  constructor(
    private sim: Sim,
    bus: EventBus<SimEvent>,
    private scene: StoreScene,
    private binBoard: RxBinBoard,
    private camera: OrthographicCamera,
    private canvas: HTMLCanvasElement,
    private callbacks: PickingCallbacks,
  ) {
    const { cols, rows } = activeStore(sim.snapshot).grid;
    this.pathfinder = new Pathfinder(cols, rows);

    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerdown", (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.downButton = e.button;
    });
    canvas.addEventListener("pointerup", (e) => {
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
      const button = this.downButton;
      this.downButton = -1;
      if (moved > CLICK_SLOP_PX || button !== e.button) return;
      if (button === 0) this.onClick(e);
      else if (button === 2) this.cancelGhost();
    });

    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    const refresh = (): void => this.refresh();
    bus.on("furniture.placed", refresh);
    bus.on("furniture.sold", (e) => {
      if (this.selection?.id === e.id) this.setSelection(null);
      this.refresh();
    });
    bus.on("furniture.moved", (e) => {
      if (this.movingId === e.item.id) {
        this.movingId = null;
        this.ghostDefId = null;
        this.scene.setHidden(null);
        this.scene.hideGhost();
      }
      this.refresh();
    });
    bus.on("cash.changed", refresh);
    bus.on("build.changed", (e) => {
      if (!e.active) {
        this.cancelGhost();
        this.setSelection(null);
      } else {
        this.setCursor("");
        this.callbacks.stationHint(null);
      }
      this.refresh();
    });
  }

  /** Palette row clicked: pick up a placement ghost for this def. */
  selectDef(defId: string | null): void {
    this.cancelGhost();
    this.setSelection(null);
    this.ghostDefId = defId;
    this.ghostRot = 0;
    this.callbacks.paletteChanged(defId);
    this.refresh();
  }

  /** §28 city view: while the map is up, pointer and keys belong to it —
   *  hover, hints and the cursor are put away so nothing lingers over it.
   *  Build mode is exited before the swap (main.ts), so no ghost is held. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    if (on) {
      this.scene.setHover(null);
      this.setCursor("");
      this.clearHints();
    }
  }

  /** Context panel: pick the selected item up as a move ghost. */
  beginMove(): void {
    if (!this.selection) return;
    const item = activeStore(this.sim.snapshot).furniture.find((f) => f.id === this.selection!.id);
    if (!item) return;
    this.movingId = item.id;
    this.ghostDefId = item.defId;
    this.ghostRot = item.rot;
    this.scene.setHidden(item.id);
    this.scene.setHover(null);
    this.setSelection(null);
    this.refresh();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.suspended) return;
    if (e.code === "KeyB" && !e.repeat) {
      this.sim.dispatch({ type: this.sim.snapshot.buildMode ? "build.exit" : "build.enter" });
    } else if (e.code === "KeyR" && this.ghostDefId) {
      this.ghostRot = ((this.ghostRot + 1) % 4) as Rot;
      this.refresh();
    } else if (e.code === "KeyP" && !e.repeat) {
      this.pathOn = !this.pathOn;
      this.refresh();
    } else if (e.code === "Escape") {
      if (this.ghostDefId) this.cancelGhost();
      else if (this.selection) this.setSelection(null);
      else if (this.sim.snapshot.buildMode) this.sim.dispatch({ type: "build.exit" });
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.suspended) return;
    this.updateHoverCell(e.clientX, e.clientY);
    this.refresh();

    const state = this.sim.snapshot;
    if (state.buildMode) {
      // Hover highlight on placed furniture while idle in build mode.
      const idle = !this.ghostDefId;
      this.scene.setHover(idle ? this.pickFurnitureId(e.clientX, e.clientY) : null);
      this.setCursor("");
      this.clearHints();
      return;
    }

    // Mid-fill: the shelf's labeled bins take pointer priority (§8).
    if (state.phase === "shift" && this.binBoard.active) {
      const bin = this.pickBinIndex(e.clientX, e.clientY);
      this.binBoard.setHover(bin);
      if (bin !== -1) {
        this.scene.setHover(null);
        this.setCursor("pointer");
        this.clearHints();
        return;
      }
    } else {
      this.binBoard.setHover(-1);
    }

    if (state.phase === "close") {
      this.scene.setHover(null);
      this.setCursor("");
      this.clearHints();
      return;
    }

    const id = this.pickFurnitureId(e.clientX, e.clientY);
    const item = id ? activeStore(state).furniture.find((f) => f.id === id) : undefined;

    // Shelves and bins take a restock click, morning or mid-shift (§11).
    if (item && this.isRestockable(item.defId)) {
      const units = this.sim.restockableUnits(item.id);
      this.scene.setHover(item.id);
      this.setCursor(units > 0 ? "pointer" : "");
      if (item.defId === "otc_shelf") {
        this.callbacks.stationHint(null);
        this.callbacks.fridgeHover(null, 0, 0);
        this.callbacks.shelfHover(item.id, e.clientX, e.clientY);
      } else if (item.defId === "fridge_medical") {
        // The fridge's card carries the §14 capacity meter and load hint.
        this.callbacks.stationHint(null);
        this.callbacks.shelfHover(null, 0, 0);
        this.callbacks.fridgeHover(item.id, e.clientX, e.clientY);
      } else {
        const into = item.defId === "cabinet_controlled" ? "the cabinet" : "the bins";
        this.callbacks.shelfHover(null, 0, 0);
        this.callbacks.fridgeHover(null, 0, 0);
        this.callbacks.stationHint(
          units > 0
            ? `Click to move ${units} ${units === 1 ? "box" : "boxes"} into ${into}`
            : `The backroom has nothing for ${into}`,
        );
      }
      return;
    }
    this.callbacks.shelfHover(null, 0, 0);
    this.callbacks.fridgeHover(null, 0, 0);

    // Mid-shift: registers, the counter and the bench are workable (§8).
    const stationName = state.phase === "shift" && item ? STATION_NAMES[item.defId] : undefined;
    this.scene.setHover(stationName ? item!.id : null);
    this.setCursor(stationName ? "pointer" : "");
    if (stationName) {
      this.callbacks.stationHint(
        state.workingStationId === item!.id
          ? `Click to step away from the ${stationName}`
          : `Click to work the ${stationName}`,
      );
    } else {
      this.callbacks.stationHint(null);
    }
  }

  /** A shelf click restocks, except while its bins are being picked from. */
  private isRestockable(defId: string): boolean {
    if (!RESTOCK_DEFS.has(defId)) return false;
    return !(defId !== "otc_shelf" && this.binBoard.active);
  }

  private clearHints(): void {
    this.callbacks.stationHint(null);
    this.callbacks.shelfHover(null, 0, 0);
    this.callbacks.fridgeHover(null, 0, 0);
  }

  private setCursor(cursor: string): void {
    if (this.canvasCursor !== cursor) {
      this.canvasCursor = cursor;
      this.canvas.style.cursor = cursor;
    }
  }

  private onClick(e: PointerEvent): void {
    if (this.suspended) return;
    this.updateHoverCell(e.clientX, e.clientY);
    const state = this.sim.snapshot;

    if (!state.buildMode) {
      if (state.phase === "close") return;
      // A fill in progress: clicking a labeled bin fills from it (§8).
      if (state.phase === "shift" && this.binBoard.active) {
        const bin = this.pickBinIndex(e.clientX, e.clientY);
        const drugId = bin === -1 ? null : this.binBoard.drugIdAt(bin);
        if (drugId) {
          this.sim.dispatch({ type: "fill.pickBin", drugId });
          return;
        }
      }
      // Work the station you click; click anywhere else to leave the post.
      const id = this.pickFurnitureId(e.clientX, e.clientY);
      const item = id ? activeStore(state).furniture.find((f) => f.id === id) : undefined;
      // A shelf takes the backroom's stock out front (§11) — morning or mid-shift.
      if (item && this.isRestockable(item.defId)) {
        this.sim.dispatch({ type: "stock.restock", furnitureId: item.id });
        return;
      }
      if (state.phase !== "shift") return;
      const stationName = item ? STATION_NAMES[item.defId] : undefined;
      if (item && stationName) {
        if (state.workingStationId === item.id) {
          this.sim.dispatch({ type: "station.leave" });
          this.callbacks.stationHint(`Click to work the ${stationName}`);
        } else {
          this.sim.dispatch({ type: "station.workHere", stationId: item.id });
          this.callbacks.stationHint(`Click to step away from the ${stationName}`);
        }
      } else if (state.workingStationId) {
        this.sim.dispatch({ type: "station.leave" });
      }
      return;
    }

    if (this.ghostDefId) {
      if (!this.hasHoverCell) return;
      const [x, y] = this.ghostAnchor();
      const check = this.sim.validatePlacement(
        this.ghostDefId,
        x,
        y,
        this.ghostRot,
        this.movingId ?? undefined,
      );
      if (!check.ok) {
        this.callbacks.toast(check.reason, "error");
        return;
      }
      if (this.movingId) {
        this.sim.dispatch({
          type: "furniture.move",
          id: this.movingId,
          cellX: x,
          cellY: y,
          rot: this.ghostRot,
        });
      } else {
        this.sim.dispatch({
          type: "furniture.place",
          defId: this.ghostDefId,
          cellX: x,
          cellY: y,
          rot: this.ghostRot,
        });
      }
      return;
    }

    const id = this.pickFurnitureId(e.clientX, e.clientY);
    if (id) {
      const item = activeStore(state).furniture.find((f) => f.id === id);
      if (item) this.setSelection({ id: item.id, defId: item.defId });
    } else {
      this.setSelection(null);
    }
  }

  private cancelGhost(): void {
    if (this.movingId) {
      this.scene.setHidden(null);
      this.movingId = null;
    }
    if (this.ghostDefId) {
      this.ghostDefId = null;
      this.callbacks.paletteChanged(null);
    }
    this.scene.hideGhost();
  }

  private setSelection(selection: BuildSelection | null): void {
    if (this.selection?.id === selection?.id) return;
    this.selection = selection;
    this.callbacks.selectionChanged(selection);
  }

  /** Anchor (min cell) so the cursor sits near the footprint's center. */
  private ghostAnchor(): [number, number] {
    const def = furnitureDef(this.ghostDefId!);
    const [w, h] = rotatedSize(def.cells, this.ghostRot);
    return [this.hoverCellX - Math.floor((w - 1) / 2), this.hoverCellY - Math.floor((h - 1) / 2)];
  }

  /** Re-derive ghost + path overlay from the current hover cell and state. */
  private refresh(): void {
    const state = this.sim.snapshot;

    if (state.buildMode && this.ghostDefId && this.hasHoverCell) {
      const [x, y] = this.ghostAnchor();
      const check = this.sim.validatePlacement(
        this.ghostDefId,
        x,
        y,
        this.ghostRot,
        this.movingId ?? undefined,
      );
      this.scene.setGhost(this.ghostDefId, x, y, this.ghostRot, check.ok);
    } else {
      this.scene.hideGhost();
    }

    this.updatePathOverlay();
  }

  private updatePathOverlay(): void {
    if (!this.pathOn || !this.hasHoverCell) {
      this.scene.setPath(null);
      return;
    }
    const { cols, rows } = activeStore(this.sim.snapshot).grid;
    // A §6 expansion outgrows the preallocated search buffers; resize lazily.
    if (this.pathfinder.cols !== cols || this.pathfinder.rows !== rows) {
      this.pathfinder = new Pathfinder(cols, rows);
    }
    const walkable = new Uint8Array(cols * rows).fill(1);
    for (const item of activeStore(this.sim.snapshot).furniture) {
      const def = furnitureDef(item.defId);
      if (def.walkable) continue;
      const [w, h] = rotatedSize(def.cells, item.rot);
      for (let y = item.cellY; y < item.cellY + h; y++) {
        for (let x = item.cellX; x < item.cellX + w; x++) {
          walkable[cellIndex(cols, x, y)] = 0;
        }
      }
    }

    let bestLen = -1;
    for (const [doorX, doorY] of doorCells(cols, rows)) {
      const len = this.pathfinder.findPath(
        walkable,
        doorX,
        doorY,
        this.hoverCellX,
        this.hoverCellY,
        this.pathOut,
      );
      if (len !== -1 && (bestLen === -1 || len < bestLen)) {
        bestLen = len;
        this.bestPath = [...this.pathOut];
      }
    }
    this.scene.setPath(bestLen === -1 ? null : this.bestPath);
  }

  private updateHoverCell(clientX: number, clientY: number): void {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.floorPlane, this.hitPoint);
    if (!hit) {
      this.hasHoverCell = false;
      return;
    }
    const { cols, rows } = activeStore(this.sim.snapshot).grid;
    const x = Math.floor(hit.x + cols / 2);
    const y = Math.floor(hit.z + rows / 2);
    if (x < 0 || x >= cols || y < 0 || y >= rows) {
      this.hasHoverCell = false;
      return;
    }
    this.hoverCellX = x;
    this.hoverCellY = y;
    this.hasHoverCell = true;
  }

  private pickFurnitureId(clientX: number, clientY: number): string | null {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.pickTargets, false);
    const mesh = hits[0]?.object as Mesh | undefined;
    return mesh ? this.scene.itemIdOf(mesh) : null;
  }

  private pickBinIndex(clientX: number, clientY: number): number {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.binBoard.pick(this.raycaster);
  }
}
