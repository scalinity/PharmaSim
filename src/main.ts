// Bootstrap: fonts, styles, sim, renderer, camera, lighting, HUD, loop.

import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./ui/tokens.css";
import "./ui/hud.css";

import { Vector3 } from "three";
import { EventBus } from "./core/bus";
import { cellToWorld, FACING, footprintRect, rectCenterWorld } from "./core/grid";
import { startLoop } from "./core/loop";
import { furnitureDef } from "./data/furniture";
import { CustomerSystem } from "./sim/customers";
import type { SimEvent } from "./sim/events";
import { Sim } from "./sim/sim";
import { CameraRig } from "./render/cameraRig";
import { Lighting } from "./render/lighting";
import { NpcView } from "./render/npcView";
import { Picking } from "./render/picking";
import { Renderer } from "./render/renderer";
import { RxBinBoard } from "./render/rxBins";
import { StoreScene } from "./render/storeScene";
import { createHud } from "./ui/hud";

const bus = new EventBus<SimEvent>();
const sim = new Sim(bus);

const renderer = new Renderer();
const store = new StoreScene(sim, bus);
const npcs = new NpcView(sim, store.scene);
const lighting = new Lighting(store.scene);
const rig = new CameraRig(renderer.canvas);
rig.setAspect(renderer.aspect);
renderer.onResize((width, height) => rig.setAspect(width / height));

bus.on("clock.minute", (e) => lighting.setTime(e.igm));
lighting.setTime(sim.snapshot.clockIgm);

const hud = createHud(document.getElementById("hud")!, sim, bus);
const binBoard = new RxBinBoard();
store.scene.add(binBoard.group);

const picking = new Picking(sim, bus, store, binBoard, rig.camera, renderer.canvas, {
  toast: hud.toast,
  selectionChanged: hud.selectionChanged,
  paletteChanged: hud.paletteChanged,
  stationHint: hud.stationHint,
  shelfHover: hud.shelfHover,
});
hud.bindBuild(picking);

// Fill interaction (§8): labeled bins appear and the camera glides to frame
// the Rx shelf; both retract when the fill ends (done, caught, or abandoned).
bus.on("rx.fillStarted", (e) => {
  const state = sim.snapshot;
  const { cols, rows } = state.store.grid;
  const shelf = e.shelfId ? state.store.furniture.find((f) => f.id === e.shelfId) : undefined;
  if (!shelf) return;
  binBoard.show(shelf, cols, rows, e.bins);
  const def = furnitureDef(shelf.defId);
  const rect = footprintRect(def.cells, shelf.cellX, shelf.cellY, shelf.rot);
  const [wx, wz] = rectCenterWorld(cols, rows, rect);
  const [fx, fy] = FACING[shelf.rot]!;
  rig.glideTo(wx + fx * 1.2, wz + fy * 1.2, 9);
});
bus.on("rx.fillEnded", () => {
  binBoard.hide();
  rig.glideBack();
});

// Screen-space overlays: amber queue chips over registers (§27: queue ≥ 4),
// stage-queue mini-card stacks over the bench and counter lanes (§8), and
// the bottleneck ring under the deepest station at queue ≥ 4.
const chipPoint = new Vector3();
function project(wx: number, wy: number, wz: number): [number, number] {
  chipPoint.set(wx, wy, wz).project(rig.camera);
  return [
    (chipPoint.x * 0.5 + 0.5) * window.innerWidth,
    (-chipPoint.y * 0.5 + 0.5) * window.innerHeight,
  ];
}

let liveStackKeys = new Set<string>();

function updateOverlays(): void {
  const state = sim.snapshot;
  if (state.phase === "close") {
    store.setBottleneck(null);
    return;
  }
  const { cols, rows } = state.store.grid;

  // Shelves that want a trip to the backroom say so (§11 restock nudge).
  for (const item of state.buildMode ? [] : state.store.furniture) {
    if (item.defId !== "otc_shelf" && item.defId !== "rx_shelf") continue;
    const units = sim.restockableUnits(item.id);
    const empty = sim.hasEmptySlot(item.id);
    if (units === 0 && !empty) {
      hud.hideStockChip(item.id);
      continue;
    }
    const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
    const [sx, sy] = project(wx, 2.4, wz);
    hud.updateStockChip(item.id, sx, sy, units, empty);
  }

  if (state.phase !== "shift") {
    store.setBottleneck(null);
    return;
  }
  let worstId: string | null = null;
  let worstDepth = 0;
  const consider = (id: string, depth: number): void => {
    if (depth > worstDepth) {
      worstDepth = depth;
      worstId = id;
    }
  };

  const stackKeys = new Set<string>();
  const stack = (key: string, wx: number, wz: number, count: number, label: string): void => {
    if (count <= 0) return;
    stackKeys.add(key);
    const [sx, sy] = project(wx, 1.9, wz);
    hud.updateStageStack(key, sx, sy, count, label);
  };

  for (const item of state.store.furniture) {
    if (item.defId === "counter_register") {
      const count = sim.queueLength(item.id);
      consider(item.id, count);
      if (count >= 4) {
        const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
        const [sx, sy] = project(wx, 2.2, wz);
        hud.updateQueueChip(item.id, sx, sy, count);
      } else {
        hud.hideQueueChip(item.id);
      }
    } else if (item.defId === "counter_service") {
      const { drop, pick } = CustomerSystem.laneCells(item);
      const dropCount = sim.queueLength(CustomerSystem.dropLaneId(item.id));
      const pickCount = sim.queueLength(CustomerSystem.pickLaneId(item.id));
      consider(item.id, Math.max(dropCount, pickCount));
      const [dx, dz] = cellToWorld(cols, rows, drop[0], drop[1]);
      const [px, pz] = cellToWorld(cols, rows, pick[0], pick[1]);
      stack(`${item.id}#drop`, dx, dz, dropCount, "drop-off");
      stack(`${item.id}#pick`, px, pz, pickCount, "pickup");
    } else if (item.defId === "fill_bench") {
      const depth = sim.workflow.fillDepth;
      consider(item.id, depth);
      const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
      stack(item.id, wx, wz, depth, "fill");
    }
  }
  for (const key of liveStackKeys) {
    if (!stackKeys.has(key)) hud.hideStageStack(key);
  }
  liveStackKeys = stackKeys;

  store.setBottleneck(worstDepth >= 4 ? worstId : null);
}

const loopHooks = {
  getSpeed: () => sim.snapshot.speed,
  tick: () => sim.tick(),
  render: (dtMs: number, alpha: number) => {
    rig.update(dtMs);
    store.update(rig.camera, dtMs);
    npcs.update(alpha);
    updateOverlays();
    renderer.render(store.scene, rig.camera);
  },
};
startLoop(loopHooks);

// Dev console handle for read-only debugging; the game never uses it.
(window as unknown as Record<string, unknown>).__pharmasim = {
  sim,
  rig,
  store,
  bus,
  renderer,
  binBoard,
  loopHooks,
};
