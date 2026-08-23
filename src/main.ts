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

import { Vector3 } from "three";
import { EventBus } from "./core/bus";
import { seasonForDay } from "./core/clock";
import { cellToWorld, FACING } from "./core/grid";
import { startLoop } from "./core/loop";
import { createStorage } from "./platform/storage";
import { CustomerSystem } from "./sim/customers";
import type { SimEvent } from "./sim/events";
import { hydrate, migrate, serialize, type SaveFile } from "./sim/save";
import { Sim } from "./sim/sim";
import { createGameState } from "./sim/state";
import { CameraRig } from "./render/cameraRig";
import { Lighting } from "./render/lighting";
import { NpcView } from "./render/npcView";
import { Picking } from "./render/picking";
import { Renderer } from "./render/renderer";
import { RxBinBoard } from "./render/rxBins";
import { StaffView } from "./render/staffView";
import { StoreScene } from "./render/storeScene";
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
const rig = new CameraRig(renderer.canvas);
rig.setAspect(renderer.aspect);
renderer.onResize((width, height) => rig.setAspect(width / height));

bus.on("clock.minute", (e) => lighting.setTime(e.igm));
lighting.setTime(sim.snapshot.clockIgm);
lighting.fitFloor(sim.snapshot.store.grid.cols, sim.snapshot.store.grid.rows);
bus.on("expansion.bought", (e) => lighting.fitFloor(e.cols, e.rows));

// §28 era tint: the store's generation rides the document root, and every
// surface reading --paper quietly modernizes with it (ui/tokens.css).
document.documentElement.dataset.era = String(sim.snapshot.era);
bus.on("era.changed", (e) => {
  document.documentElement.dataset.era = String(e.era);
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
  const state = sim.snapshot;
  const { cols, rows } = state.store.grid;
  const shelf = e.shelfId ? state.store.furniture.find((f) => f.id === e.shelfId) : undefined;
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
    const { cols, rows } = state.store.grid;
    for (const member of state.store.staff) {
      const stationId = member.assignment?.stationId;
      if (!stationId) continue;
      const station = state.store.furniture.find((f) => f.id === stationId);
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
  const state = sim.snapshot;
  updateRoleGlyphs();
  if (state.phase === "close") {
    store.setBottleneck(null);
    return;
  }
  const { cols, rows } = state.store.grid;

  // Shelves that want a trip to the backroom say so (§11 restock nudge).
  // Chips are cleared by the HUD on entering build mode, so the loop can be
  // skipped outright there — no per-frame [] stand-in (§30).
  if (!state.buildMode) {
    for (const item of state.store.furniture) {
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

// --- Saves (§5, §23) ---
//
// The profile always holds a *day boundary*: the morning the player is
// playing, or the close they are reading the receipt of. Both are untimed
// phases with no customer or script in flight. A shift is never snapshotted,
// so quitting mid-shift resumes from that morning — by design, the day is
// replayed rather than half-restored.

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
        repStars: saved.repStars,
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
    store.update(rig.camera, dtMs);
    npcs.update(alpha);
    staffView.update(alpha);
    updateOverlays();
    renderer.render(store.scene, rig.camera);
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
  bus,
  renderer,
  binBoard,
  loopHooks,
  shell,
  storage,
};
