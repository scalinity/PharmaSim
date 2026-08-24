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
import { DAY_START_IGM } from "../core/clock";
import { COMPETITOR_DEFS } from "../data/competitors";
import {
  DEPOT_ID,
  DEPOT_RADIUS,
  DEPOT_SITE,
  DEPOT_SPUR,
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

// §27 depot grays: concrete walls, a darker roof band, amber garage doors.
const DEPOT_GRAY = 0xb0b2ac;
const DEPOT_ROOF = 0x83898a;
const DEPOT_APRON = 0xc4bfb2;

/** §26 flavor pace: world units per in-game minute — slow enough that a
 *  cross-town run stays visible for a good stretch of the shift. */
const TRUCK_SPEED = 0.35;
/** Vans leave the yard a few minutes apart, not as one convoy. */
const TRUCK_DEPART_STAGGER_IGM = 20;

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

// --- The road graph the vans drive (M15, §27): waypoints from the ROADS
//     polylines plus the depot spur, edges between consecutive points.
//     Store sites hang off their district's center, which every road
//     already starts or ends on. Built once at module load. ---

type XZ = readonly [number, number];

function nodeKey(p: XZ): string {
  return `${p[0]},${p[1]}`;
}

const GRAPH_NODES = new Map<string, XZ>();
const GRAPH_EDGES = new Map<string, { to: string; length: number }[]>();

function edgesOf(key: string): { to: string; length: number }[] {
  let edges = GRAPH_EDGES.get(key);
  if (!edges) {
    edges = [];
    GRAPH_EDGES.set(key, edges);
  }
  return edges;
}

function addGraphEdge(a: XZ, b: XZ): void {
  const ka = nodeKey(a);
  const kb = nodeKey(b);
  GRAPH_NODES.set(ka, a);
  GRAPH_NODES.set(kb, b);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1e-4) return;
  edgesOf(ka).push({ to: kb, length });
  edgesOf(kb).push({ to: ka, length });
}

for (const road of ROADS) {
  for (let i = 0; i < road.points.length - 1; i++) {
    addGraphEdge(road.points[i]!, road.points[i + 1]!);
  }
}
for (let i = 0; i < DEPOT_SPUR.length - 1; i++) {
  addGraphEdge(DEPOT_SPUR[i]!, DEPOT_SPUR[i + 1]!);
}

/** Dijkstra over the tiny waypoint graph (~20 nodes — a plain scan beats
 *  a heap here). Returns the waypoint list from → to, inclusive. */
function roadPath(fromKey: string, toKey: string): XZ[] {
  if (fromKey === toKey) return [GRAPH_NODES.get(fromKey)!];
  const dist = new Map<string, number>([[fromKey, 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([fromKey]);
  while (open.size > 0) {
    let bestKey: string | null = null;
    let best = Infinity;
    for (const key of open) {
      const d = dist.get(key)!;
      if (d < best) {
        best = d;
        bestKey = key;
      }
    }
    if (bestKey === null) break;
    open.delete(bestKey);
    if (bestKey === toKey) break;
    for (const edge of GRAPH_EDGES.get(bestKey) ?? []) {
      const next = best + edge.length;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, bestKey);
        open.add(edge.to);
      }
    }
  }
  const path: XZ[] = [];
  let cursor: string | undefined = toKey;
  while (cursor !== undefined) {
    const node = GRAPH_NODES.get(cursor);
    if (!node) return [GRAPH_NODES.get(fromKey)!];
    path.unshift(node);
    if (cursor === fromKey) return path;
    cursor = prev.get(cursor);
  }
  return [GRAPH_NODES.get(fromKey)!];
}

/** One stop of a van's animated run: the district whose center anchors the
 *  road path, and the exact site (store cross or lot) to swing past. */
export interface TruckRunStop {
  districtId: string;
  site: XZ;
}

interface TruckPathPlan {
  points: XZ[];
  /** Cumulative distance at each point; [0] = 0. */
  cum: number[];
  total: number;
}

const DEPOT_KEY = nodeKey(DEPOT_SITE);
/** Vans ride just proud of the road ribbon. */
const VAN_Y = 0.1;

/** The whole day's drive: depot → each stop's district center by road, a
 *  swing through the plaza to the store site and back, then home. */
function buildRunPath(stops: readonly TruckRunStop[]): TruckPathPlan {
  const points: XZ[] = [DEPOT_SITE];
  let currentKey = DEPOT_KEY;
  for (const stop of stops) {
    const map = DISTRICT_MAPS[stop.districtId];
    if (!map) continue;
    const center: XZ = map.center;
    const centerKey = nodeKey(center);
    const leg = roadPath(currentKey, centerKey);
    for (let i = 1; i < leg.length; i++) points.push(leg[i]!);
    points.push(stop.site);
    points.push(center);
    currentKey = centerKey;
  }
  const home = roadPath(currentKey, DEPOT_KEY);
  for (let i = 1; i < home.length; i++) points.push(home[i]!);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(bx - ax, bz - az));
  }
  return { points, cum, total: cum[cum.length - 1]! };
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

  /** The §19 lot layer: for-sale posts and bought branches' shopfronts.
   *  Rebuilt whole on ownership changes — a per-run handful of merges. */
  private lotLayer: Mesh | null = null;
  private lotMaterial!: MeshLambertMaterial;

  /** The §20 depot layer: the for-sale freight lot, or the gray depot with
   *  its garage. Rebuilt once on purchase — never per frame. */
  private depotLayer: Mesh | null = null;
  /** One merged two-box van mesh per truck owned (§27). */
  private truckMeshes: Mesh[] = [];
  /** Today's animated run per truck index, or null for a parked van. */
  private truckRuns: (TruckPathPlan | null)[] = [];

  constructor() {
    const flat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

    const ground = new Mesh(
      new PlaneGeometry(300, 300),
      new MeshLambertMaterial({ color: GROUND_SAGE, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Roads under the plates: full centerlines, visible in the gaps. The
    // depot spur joins them — the ribbon the vans drive out on (M15).
    const roads = new PartsBuilder();
    for (const road of ROADS) addRibbon(roads, road.points, ROAD_HALF, ROAD_Y, ROAD);
    addRibbon(roads, DEPOT_SPUR, ROAD_HALF, ROAD_Y, ROAD);
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
      // The branch lot's plot (§19): the cream plot is static ground; what
      // stands on it — a for-sale post or a bought branch's shopfront —
      // lives on the dynamic ownership layer (setBranches).
      const [lx, lz] = m.lot;
      const plot = new BoxGeometry(3, 0.06, 2.4);
      plates.add(plot, LOT_CREAM, lx, PLATE_H + 0.03, lz);
    }
    this.scene.add(new Mesh(plates.build(), flat));

    this.buildBuildings();
    this.buildLandmarks(flat);
    this.buildStoreMarker(flat);
    this.buildRivalMarkers(flat);
    this.lotMaterial = flat;
    // Until main.ts reports ownership, every lot shows its for-sale post
    // and the freight lot stands for sale too.
    this.setBranches([]);
    this.setDepot(false);

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
    // §18: each rival's shopfront keeps its plot on its home plate.
    for (const rival of COMPETITOR_DEFS) {
      if (rival.homeDistrictId !== districtId) continue;
      if (Math.hypot(x - rival.site[0], z - rival.site[1]) < 3) return false;
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

  /** §18 rival shopfronts: the store-cross pattern in each rival's §27
   *  accent — smaller shop, shorter pole, so the player's pine cross stays
   *  the marker the eye finds first. Star ratings live on the DOM tags. */
  private buildRivalMarkers(material: MeshLambertMaterial): void {
    const b = new PartsBuilder();
    for (const rival of COMPETITOR_DEFS) {
      const [x, z] = rival.site;
      const y = PLATE_H;
      b.add(new CylinderGeometry(1.4, 1.4, 0.1, 10), LOT_CREAM, x, y + 0.05, z);
      b.add(new BoxGeometry(1.6, 0.95, 1.25), LANDMARK_WHITE, x, y + 0.55, z);
      b.add(new BoxGeometry(1.8, 0.12, 1.45), rival.accent, x, y + 1.08, z);
      b.add(new BoxGeometry(0.14, 1.7, 0.14), 0x4a5a50, x, y + 1.95, z);
      b.add(new BoxGeometry(1.05, 0.34, 0.26), rival.accent, x, y + 2.85, z);
      b.add(new BoxGeometry(0.34, 1.05, 0.26), rival.accent, x, y + 2.85, z);
    }
    this.scene.add(new Mesh(b.build(), material));
  }

  /**
   * §19/§27 lot ownership: districts with a bought branch get the player's
   * store-cross treatment on their lot (the same pattern as the founding
   * marker, branch-sized); the rest keep the for-sale post. Called on boot
   * and on every branch purchase — never per frame.
   */
  setBranches(ownedDistrictIds: readonly string[]): void {
    if (this.lotLayer) {
      this.scene.remove(this.lotLayer);
      this.lotLayer.geometry.dispose();
      this.lotLayer = null;
    }
    const owned = new Set(ownedDistrictIds);
    const b = new PartsBuilder();
    for (const district of DISTRICTS) {
      const m = DISTRICT_MAPS[district.id]!;
      const [lx, lz] = m.lot;
      const y = PLATE_H;
      if (owned.has(district.id)) {
        // A working branch: shopfront + pine cross, sized between a rival's
        // marker and the founding store so the family look reads at once.
        b.add(new BoxGeometry(1.7, 1.0, 1.3), LOT_CREAM, lx, y + 0.6, lz);
        b.add(new BoxGeometry(1.9, 0.12, 1.5), PINE, lx, y + 1.16, lz);
        b.add(new BoxGeometry(0.15, 1.9, 0.15), 0x4a5a50, lx, y + 2.1, lz);
        b.add(new BoxGeometry(1.15, 0.38, 0.28), PINE, lx, y + 3.1, lz);
        b.add(new BoxGeometry(0.38, 1.15, 0.28), PINE, lx, y + 3.1, lz);
      } else {
        b.add(new BoxGeometry(0.12, 0.8, 0.12), LOT_POST, lx + 1.1, y + 0.4, lz + 0.8);
        b.add(new BoxGeometry(0.7, 0.4, 0.06), LOT_POST, lx + 1.1, y + 0.85, lz + 0.8);
      }
    }
    this.lotLayer = new Mesh(b.build(), this.lotMaterial);
    this.scene.add(this.lotLayer);
  }

  /**
   * §20/§27 depot ownership: the freight lot's for-sale post until the DC
   * is bought, then the gray depot — long concrete walls, a west loading
   * dock, the garage wing with amber doors, the family cross on a pole by
   * the gate. Called on boot and on dc.bought — never per frame.
   */
  setDepot(built: boolean): void {
    if (this.depotLayer) {
      this.scene.remove(this.depotLayer);
      this.depotLayer.geometry.dispose();
      this.depotLayer = null;
    }
    const [dx, dz] = DEPOT_SITE;
    const b = new PartsBuilder();
    if (!built) {
      b.add(new BoxGeometry(7, 0.05, 5), DEPOT_APRON, dx, 0.03, dz);
      b.add(new BoxGeometry(0.12, 0.9, 0.12), LOT_POST, dx + 1.2, 0.45, dz + 1.4);
      b.add(new BoxGeometry(0.85, 0.5, 0.06), LOT_POST, dx + 1.2, 0.95, dz + 1.4);
    } else {
      // The yard.
      b.add(new BoxGeometry(12, 0.06, 9.5), DEPOT_APRON, dx, 0.03, dz);
      // The warehouse: gray walls, darker roof band, a west loading dock.
      b.add(new BoxGeometry(5.6, 2.4, 4.2), DEPOT_GRAY, dx + 2, 1.26, dz - 1.4);
      b.add(new BoxGeometry(6.0, 0.16, 4.6), DEPOT_ROOF, dx + 2, 2.54, dz - 1.4);
      b.add(new BoxGeometry(0.8, 0.8, 3.2), DEPOT_ROOF, dx - 1.1, 0.46, dz - 1.4);
      // The garage wing, doors facing the yard.
      b.add(new BoxGeometry(3.6, 1.6, 2.4), DEPOT_GRAY, dx + 0.8, 0.86, dz + 2.9);
      b.add(new BoxGeometry(3.9, 0.14, 2.6), DEPOT_ROOF, dx + 0.8, 1.7, dz + 2.9);
      for (let door = 0; door < 3; door++) {
        b.add(new BoxGeometry(0.06, 1.05, 0.8), AMBER, dx - 1.02, 0.6, dz + 2.05 + door * 0.9);
      }
      // The family cross by the gate — the name on the side of the yard.
      b.add(new BoxGeometry(0.14, 2.3, 0.14), 0x4a5a50, dx - 4.2, 1.15, dz - 2.6);
      b.add(new BoxGeometry(0.95, 0.32, 0.24), PINE, dx - 4.2, 2.7, dz - 2.6);
      b.add(new BoxGeometry(0.32, 0.95, 0.24), PINE, dx - 4.2, 2.7, dz - 2.6);
    }
    this.depotLayer = new Mesh(b.build(), this.lotMaterial);
    this.scene.add(this.depotLayer);
  }

  /** Garage bay for van `index`: a row along the yard's west edge. */
  private parkVan(mesh: Mesh, index: number): void {
    mesh.position.set(DEPOT_SITE[0] - 3.4, VAN_Y, DEPOT_SITE[1] - 2.6 + index * 1.15);
    mesh.rotation.y = Math.PI;
  }

  /** §27 two-box van: cream cargo box behind a pine cab on a dark runner,
   *  built along +X so yaw follows the road direction. One merged mesh —
   *  one draw call per van. */
  private makeVan(): Mesh {
    const b = new PartsBuilder();
    b.add(new BoxGeometry(1.3, 0.14, 0.56), 0x3a423e, 0, 0.12, 0);
    b.add(new BoxGeometry(0.85, 0.6, 0.6), LOT_CREAM, -0.18, 0.5, 0);
    b.add(new BoxGeometry(0.42, 0.46, 0.56), PINE, 0.44, 0.43, 0);
    return new Mesh(b.build(), this.lotMaterial);
  }

  /** One van mesh per truck in the garage; parked until a run is set. */
  setTruckCount(count: number): void {
    while (this.truckMeshes.length < count) {
      const van = this.makeVan();
      this.parkVan(van, this.truckMeshes.length);
      this.truckMeshes.push(van);
      this.scene.add(van);
    }
    while (this.truckMeshes.length > count) {
      const van = this.truckMeshes.pop()!;
      this.scene.remove(van);
      van.geometry.dispose();
    }
    this.truckRuns.length = Math.min(this.truckRuns.length, count);
  }

  /** Today's runs, index-aligned with the garage's vans; [] parks a van.
   *  Paths are computed here, once per morning — never per frame. */
  setTruckRuns(runs: readonly (readonly TruckRunStop[])[]): void {
    this.truckRuns = this.truckMeshes.map((_, i) => {
      const stops = runs[i];
      if (!stops || stops.length === 0) return null;
      return buildRunPath(stops);
    });
  }

  /** District plate under the pointer's ground hit, the freight depot's
   *  yard (DEPOT_ID), or null. */
  districtAt(raycaster: Raycaster): string | null {
    if (!raycaster.ray.intersectPlane(this.groundPlane, this.hit)) return null;
    if (Math.hypot(this.hit.x - DEPOT_SITE[0], this.hit.z - DEPOT_SITE[1]) <= DEPOT_RADIUS + 1) {
      return DEPOT_ID;
    }
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

  /** §27 hover feedback: a soft pine ring under the district's plate — or
   *  the depot's yard (M15). */
  setHover(districtId: string | null): void {
    if (districtId === this.hoverId) return;
    this.hoverId = districtId;
    if (!districtId) {
      this.hoverRing.visible = false;
      return;
    }
    let center: readonly [number, number];
    let r: number;
    if (districtId === DEPOT_ID) {
      center = DEPOT_SITE;
      r = DEPOT_RADIUS + 0.9;
    } else {
      const m = DISTRICT_MAPS[districtId]!;
      center = m.center;
      r = m.radius + 0.9;
    }
    this.hoverRing.position.set(center[0], PLATE_H + 0.05, center[1]);
    this.hoverRing.scale.set(r, 1, r);
    this.pulseT = 0;
    this.hoverRing.visible = true;
  }

  /** Per-frame: the hover ring breathes and the vans drive. The sim clock
   *  drives the vans, so a reopened map finds them mid-route and a paused
   *  game holds them still; `trucksDriving` is false outside the shift and
   *  under reduced motion — parked either way, since arrivals were already
   *  sim truth at the morning turnover (§20 flavor contract). */
  update(dtMs: number, clockIgm: number, trucksDriving: boolean): void {
    if (this.hoverRing.visible) {
      this.pulseT += dtMs / 1000;
      this.hoverMat.opacity = 0.42 + 0.14 * Math.sin(this.pulseT * 2.6);
    }
    for (let i = 0; i < this.truckMeshes.length; i++) {
      const mesh = this.truckMeshes[i]!;
      const run = this.truckRuns[i] ?? null;
      if (!trucksDriving || run === null) {
        this.parkVan(mesh, i);
        continue;
      }
      const dist = TRUCK_SPEED * (clockIgm - DAY_START_IGM - i * TRUCK_DEPART_STAGGER_IGM);
      if (dist <= 0 || dist >= run.total) {
        this.parkVan(mesh, i);
        continue;
      }
      const { points, cum } = run;
      let seg = 1;
      while (seg < cum.length - 1 && cum[seg]! < dist) seg++;
      const a = points[seg - 1]!;
      const b = points[seg]!;
      const span = cum[seg]! - cum[seg - 1]!;
      const t = span > 1e-6 ? (dist - cum[seg - 1]!) / span : 0;
      mesh.position.set(a[0] + (b[0] - a[0]) * t, VAN_Y, a[1] + (b[1] - a[1]) * t);
      if (span > 1e-6) mesh.rotation.y = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    }
  }
}
