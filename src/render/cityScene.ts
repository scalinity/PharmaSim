// City map scene (SPEC §17, §27, §30): six districts as faceted plates of
// warm-gray sidewalk on sage ground, tinted blocks of instanced extruded
// buildings, park discs, flat road ribbons along the data/districts.ts
// polylines (M15's trucks will drive these), the river past Riverside,
// facility landmarks in simple iconic massing, empty branch lots (buyable
// in M14), and the player store's pine cross. Everything is built once and
// merged hard — the whole map is ~8 draw calls; only the hover ring moves.

import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RingGeometry,
  Scene,
  Color,
  Vector3,
  type Raycaster,
  Plane,
} from "three";
import {
  DISTRICT_MAPS,
  DISTRICTS,
  RIVER,
  ROADS,
  STORE_SITE,
  type DistrictMapDef,
  type FacilityKind,
} from "../data/districts";
import { PartsBuilder } from "./meshes/parts";

// §27 world palette + map inks.
const GROUND_SAGE = 0x8fae8b;
const SIDEWALK = 0xcfc9bd;
const ROAD = 0xb5ad9d;
const PARK_SAGE = 0x7c9b77;
const RIVER_BLUE = 0x8db6c4;
const LOT_CREAM = 0xf1ead8;
const LOT_POST = 0xe6ddc8;
const LANDMARK_WHITE = 0xf3f2ec;
const PINE = 0x2f6b4f;
const ROSE = 0xc0524e;
const AMBER = 0xe7a03c;

const PLATE_H = 0.12;
const ROAD_Y = 0.05;
const ROAD_HALF = 0.9;
const RIVER_HALF = 1.8;

/** mulberry32 — deterministic scatter, so the city never reshuffles. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat ribbon along a polyline: one quad per segment, a small disc rounding
 *  each joint. Built into the shared PartsBuilder. */
function addRibbon(
  b: PartsBuilder,
  points: readonly [number, number][],
  half: number,
  y: number,
  color: number,
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i]!;
    const [x1, z1] = points[i + 1]!;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const quad = new PlaneGeometry(len, half * 2);
    quad.rotateX(-Math.PI / 2);
    quad.rotateY(-Math.atan2(dz, dx));
    b.add(quad, color, (x0 + x1) / 2, y, (z0 + z1) / 2);
  }
  for (const [x, z] of points) {
    const joint = new CircleGeometry(half, 8);
    joint.rotateX(-Math.PI / 2);
    b.add(joint, color, x, y, z);
  }
}

export class CityScene {
  readonly scene = new Scene();

  private hoverRing: Mesh;
  private hoverMat = new MeshBasicMaterial({ color: PINE, transparent: true, depthWrite: false });
  private hoverId: string | null = null;
  private pulseT = 0;

  private groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  private hit = new Vector3();

  constructor() {
    const flat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

    const ground = new Mesh(
      new PlaneGeometry(300, 300),
      new MeshLambertMaterial({ color: GROUND_SAGE, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Roads under the plates: full centerlines, visible in the gaps.
    const roads = new PartsBuilder();
    for (const road of ROADS) addRibbon(roads, road.points, ROAD_HALF, ROAD_Y, ROAD);
    this.scene.add(new Mesh(roads.build(), flat));

    const river = new PartsBuilder();
    addRibbon(river, RIVER, RIVER_HALF, 0.03, RIVER_BLUE);
    this.scene.add(new Mesh(river.build(), flat));

    // Plates, parks and branch lots merged into one grounded mesh.
    const plates = new PartsBuilder();
    for (const district of DISTRICTS) {
      const m = DISTRICT_MAPS[district.id]!;
      const plate = new CylinderGeometry(m.radius, m.radius, PLATE_H, 12);
      plates.add(plate, SIDEWALK, m.center[0], PLATE_H / 2, m.center[1]);
      for (const [px, pz, pr] of m.parks) {
        const park = new CylinderGeometry(pr, pr, 0.06, 10);
        plates.add(park, PARK_SAGE, px, PLATE_H + 0.03, pz);
      }
      // The empty lot (§19): a cream plot with a little post — nothing to
      // buy yet; M14 makes these purchasable branch sites.
      const [lx, lz] = m.lot;
      const plot = new BoxGeometry(3, 0.06, 2.4);
      plates.add(plot, LOT_CREAM, lx, PLATE_H + 0.03, lz);
      plates.add(new BoxGeometry(0.12, 0.8, 0.12), LOT_POST, lx + 1.1, PLATE_H + 0.4, lz + 0.8);
      plates.add(new BoxGeometry(0.7, 0.4, 0.06), LOT_POST, lx + 1.1, PLATE_H + 0.85, lz + 0.8);
    }
    this.scene.add(new Mesh(plates.build(), flat));

    this.buildBuildings();
    this.buildLandmarks(flat);
    this.buildStoreMarker(flat);

    const ring = new RingGeometry(0.88, 1, 48);
    ring.rotateX(-Math.PI / 2);
    this.hoverRing = new Mesh(ring, this.hoverMat);
    this.hoverRing.visible = false;
    this.hoverRing.renderOrder = 2;
    this.scene.add(this.hoverRing);
  }

  /** All districts' blocks as one InstancedMesh — one draw call (§30). */
  private buildBuildings(): void {
    let total = 0;
    for (const district of DISTRICTS) total += DISTRICT_MAPS[district.id]!.blocks;

    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0); // base-anchored, so scale.y is height
    // Own material: instance colors carry the tints; the shared vertex-color
    // material would read a color attribute the box doesn't have.
    const instanced = new InstancedMesh(
      box,
      new MeshLambertMaterial({ flatShading: true }),
      total,
    );
    const matrix = new Matrix4();
    const color = new Color();
    const tint = new Color();

    let index = 0;
    for (let d = 0; d < DISTRICTS.length; d++) {
      const district = DISTRICTS[d]!;
      const m = DISTRICT_MAPS[district.id]!;
      const rand = mulberry32(0x5eed + d * 7919);
      tint.set(m.tint);
      const placed: [number, number][] = [];
      let attempts = 0;
      while (placed.length < m.blocks && attempts < m.blocks * 30) {
        attempts++;
        const x = m.center[0] + (rand() * 2 - 1) * m.radius * 0.82;
        const z = m.center[1] + (rand() * 2 - 1) * m.radius * 0.82;
        if (Math.hypot(x - m.center[0], z - m.center[1]) > m.radius * 0.82) continue;
        if (!this.spotClear(m, district.id, x, z, placed)) continue;
        placed.push([x, z]);

        const w = 1.2 + rand() * 1.2;
        const depth = 1.2 + rand() * 1.2;
        const h = m.heights[0] + rand() * (m.heights[1] - m.heights[0]);
        matrix.makeScale(w, h, depth);
        matrix.setPosition(x, PLATE_H, z);
        instanced.setMatrixAt(index, matrix);
        // Per-block lightness jitter keeps a district's tint from banding.
        const shade = 0.9 + rand() * 0.2;
        color.setRGB(tint.r * shade, tint.g * shade, tint.b * shade);
        instanced.setColorAt(index, color);
        index++;
      }
    }
    instanced.count = index;
    this.scene.add(instanced);
  }

  /** Keep blocks off the landmark, lot, parks, store site and each other. */
  private spotClear(
    m: DistrictMapDef,
    districtId: string,
    x: number,
    z: number,
    placed: readonly [number, number][],
  ): boolean {
    if (Math.hypot(x - m.facility[0], z - m.facility[1]) < 3.4) return false;
    if (Math.hypot(x - m.lot[0], z - m.lot[1]) < 3) return false;
    for (const [px, pz, pr] of m.parks) {
      if (Math.hypot(x - px, z - pz) < pr + 1.2) return false;
    }
    if (districtId === "oldTown" && Math.hypot(x - STORE_SITE[0], z - STORE_SITE[1]) < 3.4) {
      return false;
    }
    for (const [bx, bz] of placed) {
      if (Math.hypot(x - bx, z - bz) < 2.1) return false;
    }
    return true;
  }

  /** Facility landmarks (§27 "simple iconic massing"), merged to one mesh. */
  private buildLandmarks(material: MeshLambertMaterial): void {
    const b = new PartsBuilder();
    const y = PLATE_H;

    const cross = (x: number, top: number, z: number, color: number): void => {
      b.add(new BoxGeometry(1.0, 0.3, 0.26), color, x, top, z);
      b.add(new BoxGeometry(0.3, 1.0, 0.26), color, x, top, z);
    };

    const builders: Record<FacilityKind, (x: number, z: number, tint: number) => void> = {
      clinic: (x, z) => {
        b.add(new BoxGeometry(2.6, 1.3, 2), LANDMARK_WHITE, x, y + 0.65, z);
        cross(x, y + 1.75, z, ROSE);
      },
      hospital: (x, z) => {
        b.add(new BoxGeometry(4.4, 3, 2.8), LANDMARK_WHITE, x, y + 1.5, z);
        b.add(new BoxGeometry(2.6, 1.8, 2.2), LANDMARK_WHITE, x + 3.2, y + 0.9, z + 0.3);
        cross(x, y + 3.6, z, ROSE);
        const pad = new CylinderGeometry(1.1, 1.1, 0.08, 10);
        b.add(pad, 0x6a7370, x + 3.2, y + 1.85, z + 0.3);
      },
      nursingHome: (x, z) => {
        b.add(new BoxGeometry(4.8, 1, 2.2), 0xe0cba4, x, y + 0.5, z);
        b.add(new BoxGeometry(5.2, 0.1, 0.9), LANDMARK_WHITE, x, y + 0.9, z + 1.4);
        b.add(new ConeGeometry(0.5, 0.9, 6), PARK_SAGE, x - 2.9, y + 0.45, z + 1.4);
        b.add(new ConeGeometry(0.5, 0.9, 6), PARK_SAGE, x + 2.9, y + 0.45, z + 1.4);
      },
      urgentCare: (x, z, tint) => {
        b.add(new BoxGeometry(3, 1.6, 2), tint, x, y + 0.8, z);
        b.add(new BoxGeometry(2, 1.4, 1.6), tint, x + 2.6, y + 0.7, z + 0.6);
        b.add(new BoxGeometry(0.8, 3.4, 0.8), LANDMARK_WHITE, x - 2.2, y + 1.7, z + 0.4);
        b.add(new ConeGeometry(0.7, 0.8, 4), tint, x - 2.2, y + 3.8, z + 0.4);
        b.add(new BoxGeometry(0.5, 0.5, 0.1), AMBER, x - 2.2, y + 2.9, z + 0.85);
      },
      pediatricOffice: (x, z) => {
        b.add(new BoxGeometry(2.4, 1.1, 1.8), LANDMARK_WHITE, x, y + 0.55, z);
        b.add(new BoxGeometry(2.6, 0.1, 0.7), AMBER, x, y + 1.05, z + 1.15);
        b.add(new BoxGeometry(0.4, 0.4, 0.4), AMBER, x - 1.7, y + 0.2, z + 0.6);
        b.add(new BoxGeometry(0.34, 0.34, 0.34), PINE, x - 1.7, y + 0.57, z + 0.6);
        b.add(new BoxGeometry(0.28, 0.28, 0.28), ROSE, x - 1.7, y + 0.88, z + 0.6);
      },
      walkInClinic: (x, z) => {
        b.add(new BoxGeometry(2.4, 1.5, 1.8), LANDMARK_WHITE, x, y + 0.75, z);
        b.add(new BoxGeometry(2.6, 0.1, 0.7), AMBER, x, y + 1.35, z + 1.15);
        cross(x, y + 1.95, z, ROSE);
      },
    };

    for (const district of DISTRICTS) {
      const m = DISTRICT_MAPS[district.id]!;
      for (const facility of district.facilities) {
        builders[facility.kind](m.facility[0], m.facility[1], m.tint);
      }
    }
    this.scene.add(new Mesh(b.build(), material));
  }

  /** The founding store: cream base, little shopfront, the pine cross on a
   *  pole — findable at a glance against the sage (§27). */
  private buildStoreMarker(material: MeshLambertMaterial): void {
    const [x, z] = STORE_SITE;
    const y = PLATE_H;
    const b = new PartsBuilder();
    const base = new CylinderGeometry(1.7, 1.7, 0.1, 10);
    b.add(base, LOT_CREAM, x, y + 0.05, z);
    b.add(new BoxGeometry(1.8, 1.1, 1.4), LOT_CREAM, x, y + 0.65, z);
    b.add(new BoxGeometry(2.0, 0.12, 1.6), PINE, x, y + 1.26, z);
    b.add(new BoxGeometry(0.16, 2.2, 0.16), 0x4a5a50, x, y + 2.3, z);
    b.add(new BoxGeometry(1.35, 0.44, 0.3), PINE, x, y + 3.5, z);
    b.add(new BoxGeometry(0.44, 1.35, 0.3), PINE, x, y + 3.5, z);
    this.scene.add(new Mesh(b.build(), material));
  }

  /** District plate under the pointer's ground hit, or null. */
  districtAt(raycaster: Raycaster): string | null {
    if (!raycaster.ray.intersectPlane(this.groundPlane, this.hit)) return null;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const district of DISTRICTS) {
      const m = DISTRICT_MAPS[district.id]!;
      const dist = Math.hypot(this.hit.x - m.center[0], this.hit.z - m.center[1]);
      if (dist <= m.radius + 1 && dist < bestDist) {
        bestDist = dist;
        best = district.id;
      }
    }
    return best;
  }

  /** §27 hover feedback: a soft pine ring under the district's plate. */
  setHover(districtId: string | null): void {
    if (districtId === this.hoverId) return;
    this.hoverId = districtId;
    if (!districtId) {
      this.hoverRing.visible = false;
      return;
    }
    const m = DISTRICT_MAPS[districtId]!;
    const r = m.radius + 0.9;
    this.hoverRing.position.set(m.center[0], PLATE_H + 0.05, m.center[1]);
    this.hoverRing.scale.set(r, 1, r);
    this.pulseT = 0;
    this.hoverRing.visible = true;
  }

  /** Per-frame: only the hover ring breathes. */
  update(dtMs: number): void {
    if (!this.hoverRing.visible) return;
    this.pulseT += dtMs / 1000;
    this.hoverMat.opacity = 0.42 + 0.14 * Math.sin(this.pulseT * 2.6);
  }
}
