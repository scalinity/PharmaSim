// Bootstrap: fonts, styles, save profile, sim, renderer, camera, lighting,
// HUD, app shell, loop. The profile is read before anything is built, so the
// world behind the title screen is the store the player left (§23).

import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./ui/tokens.css";
import "./ui/hud.css";

import { Raycaster, Vector2, Vector3 } from "three";
import { EventBus } from "./core/bus";
import { seasonForDay } from "./core/clock";
import { cellToWorld, FACING } from "./core/grid";
import { startLoop } from "./core/loop";
import { COMPETITOR_DEFS } from "./data/competitors";
import { DISTRICT_MAPS, DISTRICTS, STORE_SITE } from "./data/districts";
import { createStorage } from "./platform/storage";
import { CustomerSystem } from "./sim/customers";
import type { SimEvent } from "./sim/events";
import { hydrate, migrate, serialize, type SaveFile } from "./sim/save";
import { Sim } from "./sim/sim";
import { activeStore, createGameState } from "./sim/state";
import { CameraRig, type CameraPose } from "./render/cameraRig";
import { CityScene } from "./render/cityScene";
import { Lighting } from "./render/lighting";
import { NpcView } from "./render/npcView";
import { Picking } from "./render/picking";
import { Renderer } from "./render/renderer";
import { RxBinBoard } from "./render/rxBins";
import { StaffView } from "./render/staffView";
import { StoreScene } from "./render/storeScene";
import { createCityOverlay } from "./ui/screens/cityOverlay";
import { createHud } from "./ui/hud";
import { createShell, type ShellPersistence } from "./ui/shell";

/** Set across a deliberate reload to say "skip the title, we're playing". */
const BOOT_KEY = "pharmasim.boot";
/** Ambient yaw drift behind the title card, rad/s. */
const TITLE_ORBIT = 0.055;

if ("__TAURI_INTERNALS__" in window || "__TAURI__" in window) {
  document.documentElement.classList.add("app-shell");
}

const storage = createStorage();
const bootIntoPlay = window.sessionStorage.getItem(BOOT_KEY) === "play";
window.sessionStorage.removeItem(BOOT_KEY);

let saved: SaveFile | null = null;
let bootNotice: string | null = null;
try {
  const raw = await storage.load();
  if (raw !== null) saved = migrate(raw);
} catch (error) {
  // A hand-edited or half-written profile must not take the game down with
  // it: boot as a new store and say what happened at the title.
  const reason = error instanceof Error ? error.message : "Your save couldn't be read.";
  bootNotice = `${reason} Import a save, or start a new store.`;
}

const hudRoot = document.getElementById("hud")!;
hudRoot.hidden = true; // the title comes first (§23 boot → title → play)

const bus = new EventBus<SimEvent>();
const sim = new Sim(bus, saved ? hydrate(saved) : undefined);

const renderer = new Renderer();
const store = new StoreScene(sim, bus);
const npcs = new NpcView(sim, store.scene);
const staffView = new StaffView(sim, store.scene);
const lighting = new Lighting(store.scene);
// The city map (M12, §17/§27): its own scene under the same §27 day arc —
// shadow-free, since the single 1024 map belongs to the active store (§30).
const city = new CityScene();
const cityLighting = new Lighting(city.scene, { shadows: false });
const rig = new CameraRig(renderer.canvas);
rig.setAspect(renderer.aspect);
renderer.onResize((width, height) => rig.setAspect(width / height));

bus.on("clock.minute", (e) => {
  lighting.setTime(e.igm);
  cityLighting.setTime(e.igm);
});
// §27 winter edge dimming follows the calendar; §16 outages drop the key to
// 20% cold. Both *listeners* are registered further down, behind the saves
// block — day.phaseChanged is the autosave's own event, and persistence must
// stay ahead of every later subscriber in its chain (§23).
lighting.setSeason(seasonForDay(sim.snapshot.day) === "Winter");
lighting.setTime(sim.snapshot.clockIgm);
lighting.fitFloor(activeStore(sim.snapshot).grid.cols, activeStore(sim.snapshot).grid.rows);
cityLighting.setSeason(seasonForDay(sim.snapshot.day) === "Winter");
cityLighting.setTime(sim.snapshot.clockIgm);
bus.on("expansion.bought", (e) => lighting.fitFloor(e.cols, e.rows));

// §28 era tint: the active store's generation rides the document root, and
// every surface reading --paper quietly modernizes with it (ui/tokens.css).
document.documentElement.dataset.era = String(activeStore(sim.snapshot).era);
bus.on("era.changed", (e) => {
  document.documentElement.dataset.era = String(e.era);
});

// §19/§27 map ownership: the pine cross stands on every bought lot. The
// founding store keeps its own site marker; branches (stores past the
// first) claim their district's lot.
function refreshCityOwnership(): void {
  city.setBranches(sim.snapshot.stores.slice(1).map((store) => store.districtId));
}
refreshCityOwnership();
bus.on("branch.bought", refreshCityOwnership);

// §19 morning switch: the store scene rebuilt itself off the same event
// (render/storeScene.ts); the shadow box and paper tint follow here.
bus.on("branch.activeChanged", () => {
  const store = activeStore(sim.snapshot);
  lighting.fitFloor(store.grid.cols, store.grid.rows);
  document.documentElement.dataset.era = String(store.era);
});

// --- Saves (§5, §23) ---
//
// The profile always holds a *day boundary*: the morning the player is
// playing, or the close they are reading the receipt of. Both are untimed
// phases with no customer or script in flight. A shift is never snapshotted,
// so quitting mid-shift resumes from that morning — by design, the day is
// replayed rather than half-restored.
//
// Registered before the HUD exists on purpose: emit runs listeners in
// registration order, so persistence sits ahead of every UI listener in the
// chain — a throwing panel or receipt can never starve the autosave.

let snapshot: SaveFile = serialize(sim.snapshot);
/** True once we are deliberately reloading, so the unload hook can't write
 *  the old run over the file we just replaced. */
let handingOver = false;
/** A run only becomes a file once it is played. Looking at the title screen
 *  and closing the window leaves no save behind, so "Start a new store" has
 *  nothing to ask about. */
let started = saved !== null;

function persist(): void {
  if (!started) return;
  void storage.save(snapshot).catch((error: unknown) => {
    console.warn("[save] the profile couldn't be written", error);
  });
}

bus.on("day.phaseChanged", (event) => {
  if (event.phase === "shift") return;
  snapshot = serialize(sim.snapshot);
  persist(); // autosave: the new morning, and the close behind the receipt
});

// Settings live in the save (§24), so they follow the toggle, not the day.
bus.on("settings.changed", (event) => {
  snapshot.settings = { ...event.settings };
  persist();
  document.documentElement.classList.toggle("reduce-motion", event.settings.reducedMotion);
  if (hudRoot.hidden) rig.setAutoOrbit(titleOrbit());
});

// Closing the window is a quit (§23): the last boundary goes down with it.
window.addEventListener("beforeunload", () => {
  if (handingOver || !started) return;
  void storage.save(snapshot);
});

// The render layer's calendar listeners live *behind* the saves block on
// purpose: emit runs in registration order, and nothing — not even a
// throwing color lerp — may starve the autosave of day.phaseChanged (§23).
bus.on("day.phaseChanged", (e) => {
  lighting.setSeason(seasonForDay(e.day) === "Winter");
  cityLighting.setSeason(seasonForDay(e.day) === "Winter");
  // Snap at every untimed boundary, not just the morning: the ease rides
  // clock minutes, and a close reached mid-ease (a renovation's early close,
  // or a window ending at 20:00) never ticks another one — the receipt
  // would otherwise print over a half-blacked-out floor (§13, §16).
  if (e.phase !== "shift") {
    lighting.setOutage(false, true);
    cityLighting.setOutage(false, true);
  }
  // The receipt owns the close (§28): the map goes down with the shift so
  // the paper prints over the store it reports on.
  if (e.phase === "close") setCityShown(false, true);
});
bus.on("outage.changed", (e) => {
  lighting.setOutage(e.on);
  cityLighting.setOutage(e.on);
});

const hud = createHud(hudRoot, sim, bus);
const binBoard = new RxBinBoard();
store.scene.add(binBoard.group);

const picking = new Picking(sim, bus, store, binBoard, rig.camera, renderer.canvas, {
  toast: hud.toast,
  selectionChanged: hud.selectionChanged,
  paletteChanged: hud.paletteChanged,
  stationHint: hud.stationHint,
  shelfHover: hud.shelfHover,
  fridgeHover: hud.fridgeHover,
});
hud.bindBuild(picking);

// --- City view (M12, §17/§28): a render-layer scene swap, not a dock sheet.
// The same camera rig serves both scenes with its own clamps and saved
// framing per side; a soft dip hides the cut (instant under reduced motion).

const cityOverlay = createCityOverlay(sim, bus);
hudRoot.append(cityOverlay.root);

// Between the canvas and the HUD in DOM order, so the dip covers the scene
// while the paper stays crisp — stacking here is document order, no z-index.
const sceneFade = document.createElement("div");
sceneFade.className = "scenefade";
renderer.canvas.after(sceneFade);

const CITY_CENTER = new Vector3(-3, 0, -3);
const CITY_VIEW_HEIGHT = 80;

/** The scene actually rendering right now. Flips inside applyCityShown. */
let cityShown = false;
/** Where the swap is *headed*. During the 180 ms fade the two differ, and
 *  every decision — the toggle, the close-phase pull-down — must read this
 *  one, or an in-flight swap survives the very handler meant to cancel it. */
let cityTarget = false;
let storePose = rig.getPose();
let cityPose: CameraPose | null = null;
let fadeTimer = 0;

function motionReduced(): boolean {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    sim.snapshot.settings.reducedMotion
  );
}

/** The actual swap: scene, camera clamps + framing, picking, overlay, pill. */
function applyCityShown(on: boolean): void {
  if (cityShown === on) return;
  cityShown = on;
  if (on) {
    // Stepping out to the map steps away from whatever station the player's
    // hands were on — a bench fill must not start while the store is away.
    if (sim.snapshot.buildMode) sim.dispatch({ type: "build.exit" });
    if (sim.snapshot.workingStationId !== null) sim.dispatch({ type: "station.leave" });
    picking.setSuspended(true);
    // The store's screen-space chips stop being placed while the map is up;
    // whatever is on screen right now comes down with the swap.
    for (const item of activeStore(sim.snapshot).furniture) {
      hud.hideStockChip(item.id);
      hud.hideQueueChip(item.id);
    }
    for (const key of liveStackKeys) hud.hideStageStack(key);
    liveStackKeys = new Set();
    for (const id of liveGlyphIds) hud.hideRoleGlyph(id);
    liveGlyphIds = new Set();
    store.setBottleneck(null);
    storePose = rig.getPose();
    rig.setViewClamp(6, 100);
    // The city's wide zoom needs a deeper frustum than the store's (§27
    // camera notes in render/cameraRig.ts).
    rig.setDepthRange(-60, 200);
    rig.setPose(cityPose ?? { ...rig.getPose(), target: CITY_CENTER.clone(), viewHeight: CITY_VIEW_HEIGHT });
  } else {
    cityPose = rig.getPose();
    rig.setViewClamp(2, 30);
    rig.setDepthRange(1, 150);
    rig.setPose(storePose);
    city.setHover(null);
    picking.setSuspended(false);
  }
  hud.setCityActive(on);
  cityOverlay.setActive(on);
  if (!on) cityOverlay.hoverDistrict(null);
}

/** Swap under a soft dip; `immediate` (phase changes) skips the fade. The
 *  guard compares the *target*, so a request landing mid-fade redirects the
 *  pending swap instead of slipping past it. */
function setCityShown(on: boolean, immediate = false): void {
  if (cityTarget === on) return;
  cityTarget = on;
  window.clearTimeout(fadeTimer);
  if (immediate || motionReduced()) {
    sceneFade.classList.remove("scenefade--on");
    applyCityShown(on);
    return;
  }
  sceneFade.classList.add("scenefade--on");
  fadeTimer = window.setTimeout(() => {
    applyCityShown(cityTarget);
    fadeTimer = window.setTimeout(() => sceneFade.classList.remove("scenefade--on"), 60);
  }, 180);
}

hud.bindCity({
  toggle: () => {
    // The receipt owns the close (§28): the map can come down under it but
    // never up — the C press waits for the next morning.
    if (!cityTarget && sim.snapshot.phase === "close") return;
    setCityShown(!cityTarget);
  },
});

// District hover: ray the map's ground through the shared camera (§27
// feedback: ring under the plate, card in the right rail).
const cityRaycaster = new Raycaster();
const cityNdc = new Vector2();
renderer.canvas.addEventListener("pointermove", (e) => {
  if (!cityShown) return;
  cityNdc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  cityRaycaster.setFromCamera(cityNdc, rig.camera);
  const id = city.districtAt(cityRaycaster);
  city.setHover(id);
  cityOverlay.hoverDistrict(id);
});

/**
 * How tight the fill glide frames the shelf (§8). A 0.37 m label at the
 * glide's 35° pitch stands about 0.3 m tall; 90 px of that is what it takes
 * for a condensed "Levothyroxine" to stay a word rather than a smudge. The
 * 4-bin face is 2.4 m across, so a wide short window also has to come in
 * until that face is at least half the view — otherwise the names shrink
 * into the green around the store.
 */
const LABEL_WORLD_H = 0.3;
const LABEL_TARGET_PX = 90;
const SHELF_FACE_W = 2.4;

function fillViewHeight(): number {
  const byType = (LABEL_WORLD_H * window.innerHeight) / LABEL_TARGET_PX;
  const byFace = SHELF_FACE_W / (0.5 * (window.innerWidth / window.innerHeight));
  return Math.min(byType, byFace);
}

// Fill interaction (§8): labeled bins appear and the camera glides to frame
// the Rx shelf; both retract when the fill ends (done, caught, or abandoned).
bus.on("rx.fillStarted", (e) => {
  // Entering the city stepped the player away from every station, so a fill
  // can't start under the map — but never glide a camera that isn't home.
  if (cityShown) return;
  const state = sim.snapshot;
  const { cols, rows } = activeStore(state).grid;
  const shelf = e.shelfId ? activeStore(state).furniture.find((f) => f.id === e.shelfId) : undefined;
  if (!shelf) return;
  binBoard.show(shelf, cols, rows, e.bins);
  const [fx, fy] = FACING[shelf.rot]!;
  // The cabinet's smaller face needs a tighter frame to keep labels readable.
  rig.glideTo(binBoard.focus, fillViewHeight() * binBoard.viewScale, Math.atan2(fx, fy));
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
let liveGlyphIds = new Set<string>();

/** §27: a small role glyph over each staffed station — $ rings, ℞ fills,
 *  ✓ verifies. Shown from the morning on, so assignments read at a glance. */
const ROLE_GLYPHS: Record<string, string> = {
  cashier: "$",
  tech: "℞",
  pharmacist: "✓",
  manager: "M",
};

function updateRoleGlyphs(): void {
  const state = sim.snapshot;
  const ids = new Set<string>();
  if (!state.buildMode && state.phase !== "close") {
    const { cols, rows } = activeStore(state).grid;
    for (const member of activeStore(state).staff) {
      const stationId = member.assignment?.stationId;
      if (!stationId) continue;
      const station = activeStore(state).furniture.find((f) => f.id === stationId);
      if (!station) continue;
      const [wx, wz] = cellToWorld(cols, rows, station.cellX, station.cellY);
      const [sx, sy] = project(wx, 2.75, wz);
      hud.updateRoleGlyph(member.id, sx, sy, ROLE_GLYPHS[member.role] ?? "•");
      ids.add(member.id);
    }
  }
  for (const id of liveGlyphIds) {
    if (!ids.has(id)) hud.hideRoleGlyph(id);
  }
  liveGlyphIds = ids;
}

function updateOverlays(): void {
  if (hudRoot.hidden) return; // title screen: no chips to place
  if (cityShown) {
    // The map's own overlay: street tags pinned to each district's plate,
    // the §18 rivals' shop tags over their marker crosses, and the player's
    // own pine tags over the founding site and every bought lot (§19).
    for (const district of DISTRICTS) {
      const m = DISTRICT_MAPS[district.id]!;
      const [sx, sy] = project(m.center[0], 0.4, m.center[1]);
      cityOverlay.updateLabel(district.id, sx, sy);
    }
    for (const rival of COMPETITOR_DEFS) {
      const [sx, sy] = project(rival.site[0], 3.9, rival.site[1]);
      cityOverlay.updateLabel(rival.id, sx, sy);
    }
    const stores = sim.snapshot.stores;
    for (let i = 0; i < stores.length; i++) {
      const site = i === 0 ? STORE_SITE : DISTRICT_MAPS[stores[i]!.districtId]!.lot;
      const [sx, sy] = project(site[0], 4.4, site[1]);
      cityOverlay.updateLabel(`branch:${stores[i]!.id}`, sx, sy);
    }
    return;
  }
  const state = sim.snapshot;
  updateRoleGlyphs();
  if (state.phase === "close") {
    store.setBottleneck(null);
    return;
  }
  const { cols, rows } = activeStore(state).grid;

  // Shelves that want a trip to the backroom say so (§11 restock nudge).
  // Chips are cleared by the HUD on entering build mode, so the loop can be
  // skipped outright there — no per-frame [] stand-in (§30).
  if (!state.buildMode) {
    for (const item of activeStore(state).furniture) {
      if (
        item.defId !== "otc_shelf" &&
        item.defId !== "rx_shelf" &&
        item.defId !== "cabinet_controlled" &&
        item.defId !== "fridge_medical"
      ) {
        continue;
      }
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

  // One read per frame each — the depth getters walk the script map.
  const fillDepth = sim.workflow.fillDepth;
  const verifyDepth = sim.workflow.verifyDepth;
  const autoDepth = sim.workflow.autoFillDepth;

  for (const item of activeStore(state).furniture) {
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
    } else if (item.defId === "vaccine_station") {
      // The vaccine line is a station queue like any other (§14): it feeds
      // the amber bottleneck ring and gets the ≥4 waiting chip.
      const count = sim.queueLength(CustomerSystem.vaxLaneId(item.id));
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
      consider(item.id, fillDepth);
      const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
      stack(item.id, wx, wz, fillDepth, "fill");
    } else if (item.defId === "verify_desk") {
      consider(item.id, verifyDepth);
      const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
      stack(item.id, wx, wz, verifyDepth, "verify");
    } else if (item.defId === "dispenser_robotic") {
      // The machine's own lane (§6): same card stack, same legibility.
      consider(item.id, autoDepth);
      const [wx, wz] = cellToWorld(cols, rows, item.cellX, item.cellY);
      stack(item.id, wx, wz, autoDepth, "auto-fill");
    }
  }
  for (const key of liveStackKeys) {
    if (!stackKeys.has(key)) hud.hideStageStack(key);
  }
  liveStackKeys = stackKeys;

  store.setBottleneck(worstDepth >= 4 ? worstId : null);
}

function reboot(intent: "play" | null): void {
  handingOver = true;
  if (intent === null) window.sessionStorage.removeItem(BOOT_KEY);
  else window.sessionStorage.setItem(BOOT_KEY, intent);
  window.location.reload();
}

/** Reduced motion, from the OS or the settings toggle, stops the orbit too. */
function titleOrbit(): number {
  const reduced =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    sim.snapshot.settings.reducedMotion;
  return reduced ? 0 : TITLE_ORBIT;
}

// A new run and an imported run are both *different states*, so they start a
// new session: write the profile, then boot from it. One construction path,
// no half-swapped world.
const persistence: ShellPersistence = {
  exportSave: () => storage.exportFile(),
  importSave: async () => {
    const raw = await storage.importFile();
    if (raw === null) return false; // cancelled
    await storage.save(migrate(raw));
    reboot("play");
    return true;
  },
  startNewGame: async () => {
    await storage.save(serialize(createGameState()));
    reboot("play");
  },
  saveAndQuit: async () => {
    await storage.save(snapshot);
    reboot(null);
  },
};

const shell = createShell(document.getElementById("shell")!, {
  sim,
  persistence,
  summary: saved
    ? {
        day: saved.day,
        season: seasonForDay(saved.day),
        cash: saved.cash,
        // The daybook line shows the store the run left off in (§19).
        repStars: (saved.stores.find((s) => s.id === saved.activeStoreId) ?? saved.stores[0]!)
          .repStars,
      }
    : null,
  onPlay: () => enterPlay(),
  hudDismiss: () => hud.dismiss(),
});

function enterPlay(): void {
  hudRoot.hidden = false;
  rig.setAutoOrbit(0);
  hud.enterPlay();
  // Whatever we are now playing is the save (§23: one profile).
  started = true;
  snapshot = serialize(sim.snapshot);
  persist();
}

document.documentElement.classList.toggle("reduce-motion", sim.snapshot.settings.reducedMotion);

const loopHooks = {
  getSpeed: () => sim.snapshot.speed,
  tick: () => sim.tick(),
  render: (dtMs: number, alpha: number) => {
    rig.update(dtMs);
    if (cityShown) {
      city.update(dtMs);
    } else {
      store.update(rig.camera, dtMs);
      npcs.update(alpha);
      staffView.update(alpha);
    }
    updateOverlays();
    renderer.render(cityShown ? city.scene : store.scene, rig.camera);
  },
};
startLoop(loopHooks);

if (bootIntoPlay) {
  enterPlay();
} else {
  rig.setAutoOrbit(titleOrbit());
  shell.showTitle(bootNotice);
}

// Dev console handle for read-only debugging; the game never uses it.
(window as unknown as Record<string, unknown>).__pharmasim = {
  sim,
  rig,
  store,
  city,
  bus,
  renderer,
  binBoard,
  loopHooks,
  shell,
  storage,
};
