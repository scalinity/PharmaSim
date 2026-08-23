// Procedural flat-shaded furniture factories (SPEC §6, §27): composed boxes
// and cylinders, one merged geometry per def with a distinct silhouette.
// Frame: rot-0 footprint w×h centered on the origin, w along X, h along Z,
// floor at y = 0, item facing +Z (south, the door).
//
// Era reskins (§13): every factory draws its structure from the EraPalette's
// roles — wood, woodLight, metal, surface — so a renovation swaps materials
// while the silhouettes stay put (walnut shelf → chrome-edge teal → white
// gondola → light oak). Geometry is cached per (era, def) and rebuilt only
// when the era changes (§30). The constants below are era-invariant: paper,
// product boxes, the pine cross, clinical whites.

import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, type BufferGeometry } from "three";
import { furnitureDef } from "../../data/furniture";
import { eraPalette, type EraPalette } from "../eras";
import { PartsBuilder } from "./parts";

const WHITE = 0xfafaf7;
const PAPER = 0xfbf8f0;
const STEEL = 0xa9b2b0;
const DARK = 0x3c4643;
const PINE = 0x2f6b4f;
const AMBER = 0xe7a03c;
const ROSE = 0xc0524e;
const LEAF = 0x4d7043;
const CLAY = 0xb0663f;
const BARK = 0x6b4a32;

function box(w: number, h: number, d: number): BoxGeometry {
  return new BoxGeometry(w, h, d);
}

function cyl(rTop: number, rBottom: number, h: number, segments = 8): CylinderGeometry {
  return new CylinderGeometry(rTop, rBottom, h, segments);
}

function counterService(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(1.86, 0.92, 0.62), p.wood, 0, 0.46, 0.04);
  b.add(box(2.0, 0.05, 0.76), p.metal, 0, 0.945, 0.04);
  // Front panel trim
  b.add(box(1.7, 0.5, 0.03), p.woodLight, 0, 0.5, 0.36);
  // Drop-off and pickup lane trays
  b.add(box(0.34, 0.06, 0.26), PAPER, -0.55, 1.0, 0.1);
  b.add(box(0.34, 0.06, 0.26), PAPER, 0.55, 1.0, 0.1);
  return b.build();
}

function counterRegister(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.84, 0.9, 0.62), p.wood, 0, 0.45, 0.02);
  b.add(box(0.92, 0.05, 0.72), p.surface, 0, 0.925, 0.02);
  // The till: brass in Gen 1, chrome by Gen 2, with a dark key bank and a
  // paper price flag. Gen 3+ adds the §13 barcode scanner beside it.
  b.add(box(0.34, 0.3, 0.3), p.metal, 0.12, 1.1, -0.06);
  b.add(box(0.3, 0.1, 0.06), DARK, 0.12, 1.02, 0.13);
  b.add(box(0.2, 0.14, 0.03), PAPER, 0.12, 1.32, -0.06);
  if (p.era >= 3) {
    const wand = cyl(0.035, 0.045, 0.16, 6);
    wand.rotateZ(0.5);
    b.add(wand, DARK, -0.24, 1.02, 0.12);
    b.add(box(0.12, 0.03, 0.12), DARK, -0.26, 0.945, 0.12);
  }
  return b.build();
}

function otcShelf(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  // Side panels + three boards with metal nosing, open front
  b.add(box(0.06, 1.5, 0.55), p.wood, -0.92, 0.75, 0);
  b.add(box(0.06, 1.5, 0.55), p.wood, 0.92, 0.75, 0);
  for (const y of [0.32, 0.82, 1.32]) {
    b.add(box(1.84, 0.05, 0.55), p.woodLight, 0, y, 0);
    b.add(box(1.84, 0.03, 0.03), p.metal, 0, y, 0.28);
  }
  b.add(box(1.84, 0.08, 0.55), p.wood, 0, 1.5, 0);
  // Stocked product hints
  const productColors = [AMBER, PINE, ROSE, STEEL, AMBER, PINE];
  for (let i = 0; i < 6; i++) {
    const x = -0.62 + (i % 3) * 0.62;
    const y = i < 3 ? 0.485 : 0.985;
    b.add(box(0.4, 0.26, 0.34), productColors[i]!, x, y, 0.04);
  }
  return b.build();
}

function rxShelf(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  // Tall cabinet with a back panel and a 4×3 face of labeled bins
  b.add(box(1.9, 1.9, 0.3), p.wood, 0, 0.95, -0.2);
  b.add(box(1.96, 0.08, 0.62), p.wood, 0, 1.94, -0.05);
  b.add(box(1.96, 0.12, 0.62), p.wood, 0, 0.06, -0.05);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const x = -0.6 + col * 0.6;
      const y = 0.36 + row * 0.42;
      b.add(box(0.5, 0.34, 0.34), WHITE, x, y, 0.06);
      b.add(box(0.34, 0.1, 0.02), PAPER, x, y - 0.06, 0.24);
    }
  }
  return b.build();
}

function fillBench(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.9, 0.06, 0.7), p.woodLight, 0, 0.92, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(box(0.07, 0.9, 0.07), p.wood, sx * 0.38, 0.45, sz * 0.28);
    }
  }
  b.add(box(0.84, 0.08, 0.64), p.wood, 0, 0.4, 0); // low shelf
  // Mortar and counting tray
  b.add(cyl(0.11, 0.07, 0.14), WHITE, -0.2, 1.02, 0.08);
  b.add(box(0.34, 0.04, 0.24), STEEL, 0.2, 0.97, -0.08);
  return b.build();
}

function verifyDesk(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.9, 0.05, 0.66), p.surface, 0, 0.78, 0);
  b.add(box(0.8, 0.72, 0.56), p.wood, 0, 0.39, 0);
  // Desk lamp with a cone shade, leaning over a paper stack
  b.add(cyl(0.02, 0.05, 0.5), p.metal, -0.28, 1.03, -0.18);
  const shade = cyl(0.03, 0.13, 0.14);
  shade.rotateZ(0.6);
  b.add(shade, p.metal, -0.16, 1.28, -0.18);
  b.add(box(0.3, 0.05, 0.4), PAPER, 0.15, 0.83, 0.02);
  return b.build();
}

function chairWaiting(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.5, 0.07, 0.48), p.surface, 0, 0.44, 0.02);
  const back = box(0.5, 0.55, 0.06);
  back.rotateX(-0.12);
  b.add(back, p.wood, 0, 0.73, -0.23);
  for (const sx of [-1, 1]) {
    b.add(box(0.05, 0.42, 0.05), p.wood, sx * 0.21, 0.21, 0.19);
    b.add(box(0.05, 0.42, 0.05), p.wood, sx * 0.21, 0.21, -0.21);
  }
  return b.build();
}

function fridgeMedical(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  // A medical fridge is white in any era; the hardware follows the times.
  b.add(box(0.8, 1.8, 0.72), WHITE, 0, 0.9, -0.02);
  b.add(box(0.06, 0.5, 0.06), p.metal, 0.3, 1.15, 0.35); // handle
  b.add(box(0.74, 0.02, 0.7), STEEL, 0, 0.62, 0); // door split line
  // Pine cross emblem
  b.add(box(0.26, 0.09, 0.03), PINE, -0.08, 1.35, 0.34);
  b.add(box(0.09, 0.26, 0.03), PINE, -0.08, 1.35, 0.34);
  return b.build();
}

function cabinetControlled(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.82, 1.6, 0.66), DARK, 0, 0.8, -0.02);
  b.add(box(0.86, 0.06, 0.7), STEEL, 0, 1.62, -0.02);
  b.add(box(0.86, 0.08, 0.7), STEEL, 0, 0.04, -0.02);
  // Heavy lock dial and hinges in the era's hardware finish
  const dial = cyl(0.09, 0.09, 0.08);
  dial.rotateX(Math.PI / 2);
  b.add(dial, p.metal, 0.16, 0.95, 0.32);
  b.add(box(0.05, 0.18, 0.04), p.metal, -0.36, 1.2, 0.31);
  b.add(box(0.05, 0.18, 0.04), p.metal, -0.36, 0.5, 0.31);
  return b.build();
}

function vaccineStation(p: EraPalette): BufferGeometry {
  const b = new PartsBuilder();
  // Prep table on the west half
  b.add(box(0.8, 0.05, 0.7), WHITE, -0.5, 0.82, 0);
  b.add(box(0.7, 0.78, 0.6), p.surface, -0.5, 0.4, 0);
  b.add(box(0.3, 0.04, 0.2), STEEL, -0.5, 0.87, 0.1);
  // Privacy screen: three folded panels with pine feet
  for (let i = 0; i < 3; i++) {
    const panel = box(0.34, 1.5, 0.04);
    panel.rotateY(i === 1 ? 0 : i === 0 ? 0.5 : -0.5);
    const x = 0.18 + i * 0.3;
    const z = i === 1 ? -0.1 : 0.02;
    b.add(panel, p.surface, x, 0.85, z);
    b.add(box(0.1, 0.1, 0.24), PINE, x, 0.05, z);
  }
  return b.build();
}

function generatorBackup(): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(0.84, 0.8, 0.7), PINE, 0, 0.44, 0);
  b.add(box(0.9, 0.08, 0.76), DARK, 0, 0.04, 0);
  // Vent slats, exhaust stack, fuel cap
  for (let i = 0; i < 3; i++) {
    b.add(box(0.5, 0.05, 0.03), DARK, -0.08, 0.3 + i * 0.16, 0.35);
  }
  b.add(cyl(0.07, 0.07, 0.4), STEEL, 0.26, 1.02, -0.18);
  b.add(cyl(0.06, 0.06, 0.06), AMBER, -0.24, 0.87, -0.14);
  return b.build();
}

function dispenserRobotic(): BufferGeometry {
  // Gen 4 equipment: it is the modern era, whatever room it stands in.
  const b = new PartsBuilder();
  b.add(box(1.8, 1.7, 1.8), WHITE, 0, 0.85, 0);
  b.add(box(1.86, 0.12, 1.86), STEEL, 0, 0.06, 0);
  // Dark pick window with a pine status strip
  b.add(box(1.2, 0.5, 0.04), DARK, 0, 1.15, 0.9);
  b.add(box(1.2, 0.06, 0.04), PINE, 0, 0.82, 0.9);
  b.add(box(0.5, 0.16, 0.3), STEEL, 0, 0.5, 0.78); // output tray
  // Canister turret on the roof
  for (let i = 0; i < 3; i++) {
    b.add(cyl(0.16, 0.16, 0.5), STEEL, -0.5 + i * 0.5, 1.95, -0.3);
  }
  return b.build();
}

function decorPlant(): BufferGeometry {
  const b = new PartsBuilder();
  b.add(cyl(0.2, 0.14, 0.34), CLAY, 0, 0.17, 0);
  b.add(cyl(0.05, 0.06, 0.35, 6), BARK, 0, 0.45, 0);
  b.add(new IcosahedronGeometry(0.24, 0), LEAF, 0, 0.72, 0);
  b.add(new IcosahedronGeometry(0.17, 0), LEAF, 0.14, 0.9, 0.05);
  b.add(new IcosahedronGeometry(0.14, 0), LEAF, -0.13, 0.88, -0.08);
  return b.build();
}

function decorRug(): BufferGeometry {
  const b = new PartsBuilder();
  b.add(box(1.9, 0.02, 0.9), ROSE, 0, 0.01, 0);
  b.add(box(1.6, 0.015, 0.62), PAPER, 0, 0.025, 0);
  b.add(box(1.3, 0.012, 0.36), AMBER, 0, 0.035, 0);
  return b.build();
}

function decorPoster(p: EraPalette): BufferGeometry {
  // Hangs on the wall behind its cell (north edge at rot 0).
  const b = new PartsBuilder();
  const z = -0.42;
  b.add(box(0.72, 0.94, 0.04), p.wood, 0, 1.25, z);
  b.add(box(0.62, 0.84, 0.05), PAPER, 0, 1.25, z);
  // Tonic-ad artwork: amber sunburst over a pine bottle
  b.add(cyl(0.16, 0.16, 0.02, 12).rotateX(Math.PI / 2), AMBER, 0, 1.42, z + 0.03);
  b.add(box(0.14, 0.3, 0.02), PINE, 0, 1.12, z + 0.03);
  b.add(box(0.06, 0.08, 0.02), PINE, 0, 1.3, z + 0.03);
  return b.build();
}

const FACTORIES: Record<string, (p: EraPalette) => BufferGeometry> = {
  counter_service: counterService,
  counter_register: counterRegister,
  otc_shelf: otcShelf,
  rx_shelf: rxShelf,
  fill_bench: fillBench,
  verify_desk: verifyDesk,
  chair_waiting: chairWaiting,
  fridge_medical: fridgeMedical,
  cabinet_controlled: cabinetControlled,
  vaccine_station: vaccineStation,
  generator_backup: generatorBackup,
  dispenser_robotic: dispenserRobotic,
  decor_plant: decorPlant,
  decor_rug: decorRug,
  decor_poster: decorPoster,
};

const cache = new Map<string, BufferGeometry>();

/** Merged, vertex-colored geometry for a def in an era's materials; built
 *  once per (era, def) and shared — the era-change rebuild is a cache fill,
 *  never a per-frame cost (§30). */
export function furnitureGeometry(defId: string, era: number): BufferGeometry {
  const key = `${era}:${defId}`;
  let geometry = cache.get(key);
  if (!geometry) {
    const factory = FACTORIES[defId];
    if (!factory) throw new Error(`No mesh factory for furniture def: ${defId}`);
    furnitureDef(defId); // asserts the def exists in data too
    geometry = factory(eraPalette(era));
    cache.set(key, geometry);
  }
  return geometry;
}
