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
import { cellToWorld } from "./core/grid";
import { startLoop } from "./core/loop";
import type { SimEvent } from "./sim/events";
import { Sim } from "./sim/sim";
import { CameraRig } from "./render/cameraRig";
import { Lighting } from "./render/lighting";
import { NpcView } from "./render/npcView";
import { Picking } from "./render/picking";
import { Renderer } from "./render/renderer";
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

// Dev console handle for read-only debugging; the game never uses it.
(window as unknown as Record<string, unknown>).__pharmasim = { sim, rig, store, bus, renderer };

const hud = createHud(document.getElementById("hud")!, sim, bus);
const picking = new Picking(sim, bus, store, rig.camera, renderer.canvas, {
  toast: hud.toast,
  selectionChanged: hud.selectionChanged,
  paletteChanged: hud.paletteChanged,
  stationHint: hud.stationHint,
});
hud.bindBuild(picking);

// Amber queue chips float over registers with long lines (§27: queue ≥ 4).
const chipPoint = new Vector3();
function updateQueueChips(): void {
  const state = sim.snapshot;
  if (state.phase !== "shift") return;
  const { cols, rows } = state.store.grid;
  for (const item of state.store.furniture) {
    if (item.defId !== "counter_register") continue;
    const count = sim.queueLength(item.id);
    if (count >= 4) {
      const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
      chipPoint.set(wx, 2.2, wz).project(rig.camera);
      hud.updateQueueChip(
        item.id,
        (chipPoint.x * 0.5 + 0.5) * window.innerWidth,
        (-chipPoint.y * 0.5 + 0.5) * window.innerHeight,
        count,
      );
    } else {
      hud.hideQueueChip(item.id);
    }
  }
}

startLoop({
  getSpeed: () => sim.snapshot.speed,
  tick: () => sim.tick(),
  render: (dtMs, alpha) => {
    rig.update(dtMs);
    store.update(rig.camera, dtMs);
    npcs.update(alpha);
    updateQueueChips();
    renderer.render(store.scene, rig.camera);
  },
});
