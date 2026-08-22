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
import { Renderer } from "./render/renderer";
import { createStoreScene } from "./render/storeScene";
import { createHud } from "./ui/hud";

const bus = new EventBus<SimEvent>();
const sim = new Sim(bus);

const renderer = new Renderer();
const scene = createStoreScene();
const lighting = new Lighting(scene);
const rig = new CameraRig(renderer.canvas);
rig.setAspect(renderer.aspect);
renderer.onResize((width, height) => rig.setAspect(width / height));

bus.on("clock.minute", (e) => lighting.setTime(e.igm));
lighting.setTime(sim.snapshot.clockIgm);

createHud(document.getElementById("hud")!, sim, bus);

startLoop({
  getSpeed: () => sim.snapshot.speed,
  tick: () => sim.tick(),
  render: (dtMs) => {
    rig.update(dtMs);
    renderer.render(scene, rig.camera);
  },
});
