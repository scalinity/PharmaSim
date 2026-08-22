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

import { EventBus } from "./core/bus";
import { startLoop } from "./core/loop";
import type { SimEvent } from "./sim/events";
import { Sim } from "./sim/sim";
import { CameraRig } from "./render/cameraRig";
import { Lighting } from "./render/lighting";
import { Picking } from "./render/picking";
import { Renderer } from "./render/renderer";
import { StoreScene } from "./render/storeScene";
import { createHud } from "./ui/hud";

const bus = new EventBus<SimEvent>();
const sim = new Sim(bus);

const renderer = new Renderer();
const store = new StoreScene(sim, bus);
const lighting = new Lighting(store.scene);
const rig = new CameraRig(renderer.canvas);
rig.setAspect(renderer.aspect);
renderer.onResize((width, height) => rig.setAspect(width / height));

bus.on("clock.minute", (e) => lighting.setTime(e.igm));
lighting.setTime(sim.snapshot.clockIgm);

// Dev console handle for read-only debugging; the game never uses it.
(window as unknown as Record<string, unknown>).__pharmasim = { sim, rig, store };

const hud = createHud(document.getElementById("hud")!, sim, bus);
const picking = new Picking(sim, bus, store, rig.camera, renderer.canvas, {
  toast: hud.toast,
  selectionChanged: hud.selectionChanged,
  paletteChanged: hud.paletteChanged,
});
hud.bindBuild(picking);

startLoop({
  getSpeed: () => sim.snapshot.speed,
  tick: () => sim.tick(),
  render: (dtMs) => {
    rig.update(dtMs);
    store.update(rig.camera, dtMs);
    renderer.render(store.scene, rig.camera);
  },
});
