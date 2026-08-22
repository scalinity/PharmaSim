// Gen 1 store dollhouse (SPEC §6, §27): checkerboard floor, walnut-wainscot
// walls with a south door gap, camera-facing wall fade, the furniture layer
// synced to sim events, and build-mode overlays (grid, backroom tint, ghost,
// debug path ribbon).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RingGeometry,
  Scene,
  Vector3,
  type OrthographicCamera,
} from "three";
import type { EventBus } from "../core/bus";
import { cellToWorld, footprintRect, rectCenterWorld, type Rot } from "../core/grid";
import { furnitureDef } from "../data/furniture";
import type { SimEvent } from "../sim/events";
import type { Sim } from "../sim/sim";
import type { PlacedFurniture } from "../sim/state";
import { furnitureGeometry } from "./meshes/furniture";
import { PartsBuilder } from "./meshes/parts";

const GROUND_SAGE = 0x8fae8b;
const CREAM = 0xf1ead8;
const MOSS = 0x96a57f;
const WALNUT = 0x6b4a32;
const BRASS = 0xc9a86a;
const INK = 0x20302b;
const PINE = 0x2f6b4f;
const ROSE = 0xc0524e;
const AMBER = 0xe7a03c;

const SLAB_H = 0.12;
export const FLOOR_Y = SLAB_H + 0.01;
const WALL_T = 0.16;
const WALL_H = 2.3;
const WAINSCOT_H = 0.85;
const CAP_H = 0.06;
const DOOR_W = 2; // matches the two door cells
const FADE_DOT = 0.2; // wall outward · toward-camera above this starts the fade
const FADE_MIN = 0.06;

interface WallSide {
  group: Group;
  materials: MeshLambertMaterial[];
  normal: Vector3;
  opacity: number;
}

export class StoreScene {
  readonly scene = new Scene();

  private store = new Group();
  private furnitureLayer = new Group();
  private meshes = new Map<string, Mesh>();
  private walls: WallSide[] = [];

  private furnitureMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private hoverMat = new MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    emissive: PINE,
    emissiveIntensity: 0.3,
  });
  private ghostMat = new MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private footprintMat = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  private ghost: Mesh;
  private footprint: Mesh;

  private zoneMesh: Mesh;
  private gridLines: Mesh;
  private pathMesh: Mesh;
  private pathGeometry = new BufferGeometry();

  /** Amber pulsing ring under the bottleneck station (§27, queue ≥ 4). */
  private bottleneckRing: Mesh;
  private bottleneckMat = new MeshBasicMaterial({
    color: AMBER,
    transparent: true,
    depthWrite: false,
  });
  private bottleneckId: string | null = null;
  private bottleneckRadius = 1;
  private pulseT = 0;

  private hoveredId: string | null = null;
  private hiddenId: string | null = null;
  private buildMode = false;

  private cols: number;
  private rows: number;
  private camDir = new Vector3();

  constructor(
    private sim: Sim,
    bus: EventBus<SimEvent>,
  ) {
    const { cols, rows } = sim.snapshot.store.grid;
    this.cols = cols;
    this.rows = rows;

    this.scene.add(this.store);
    this.buildGround();
    this.buildFloor();
    this.buildWalls();

    this.furnitureLayer.position.y = FLOOR_Y;
    this.store.add(this.furnitureLayer);

    // Ghost preview + footprint tint quad
    this.ghost = new Mesh(furnitureGeometry("chair_waiting"), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.renderOrder = 10;
    this.footprint = new Mesh(new PlaneGeometry(1, 1), this.footprintMat);
    this.footprint.rotation.x = -Math.PI / 2;
    this.footprint.visible = false;
    this.footprint.renderOrder = 9;
    this.store.add(this.ghost, this.footprint);

    // Backroom zone tint (build mode)
    this.zoneMesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.zoneMesh.rotation.x = -Math.PI / 2;
    this.zoneMesh.visible = false;
    this.zoneMesh.renderOrder = 2;
    this.store.add(this.zoneMesh);

    this.gridLines = this.buildGridLines();
    this.gridLines.visible = false;
    this.store.add(this.gridLines);

    const ringGeometry = new RingGeometry(0.82, 1, 40);
    ringGeometry.rotateX(-Math.PI / 2);
    this.bottleneckRing = new Mesh(ringGeometry, this.bottleneckMat);
    this.bottleneckRing.visible = false;
    this.bottleneckRing.renderOrder = 4;
    this.store.add(this.bottleneckRing);

    // Debug A* path ribbon (P toggle)
    this.pathMesh = new Mesh(
      this.pathGeometry,
      new MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.pathMesh.visible = false;
    this.pathMesh.renderOrder = 3;
    this.store.add(this.pathMesh);

    for (const item of sim.snapshot.store.furniture) this.addItem(item);

    bus.on("furniture.placed", (e) => this.addItem(e.item));
    bus.on("furniture.moved", (e) => this.moveItem(e.item));
    bus.on("furniture.sold", (e) => this.removeItem(e.id));
    bus.on("build.changed", (e) => this.setBuildMode(e.active));
  }

  /** Per-frame: fade whichever walls face the camera (dollhouse, SPEC §27). */
  update(camera: OrthographicCamera, dtMs: number): void {
    camera.getWorldDirection(this.camDir);
    const k = 1 - Math.exp(-10 * (dtMs / 1000));
    for (const wall of this.walls) {
      const dot = -(wall.normal.x * this.camDir.x + wall.normal.z * this.camDir.z);
      const target = dot > FADE_DOT ? FADE_MIN : 1;
      wall.opacity += (target - wall.opacity) * k;
      for (const material of wall.materials) material.opacity = wall.opacity;
    }

    if (this.bottleneckRing.visible) {
      this.pulseT += dtMs / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 4.4);
      const s = this.bottleneckRadius * (1 + pulse * 0.1);
      this.bottleneckRing.scale.set(s, 1, s);
      this.bottleneckMat.opacity = 0.45 + pulse * 0.4;
    }
  }

  /** Place (or clear) the amber bottleneck ring under a station (§27). */
  setBottleneck(id: string | null): void {
    if (id === this.bottleneckId) return;
    this.bottleneckId = id;
    if (!id) {
      this.bottleneckRing.visible = false;
      return;
    }
    const item = this.sim.snapshot.store.furniture.find((f) => f.id === id);
    if (!item) {
      this.bottleneckRing.visible = false;
      return;
    }
    const def = furnitureDef(item.defId);
    const rect = footprintRect(def.cells, item.cellX, item.cellY, item.rot);
    const [wx, wz] = rectCenterWorld(this.cols, this.rows, rect);
    this.bottleneckRadius = Math.max(rect.w, rect.h) / 2 + 0.35;
    this.bottleneckRing.position.set(wx, FLOOR_Y + 0.01, wz);
    this.bottleneckRing.scale.set(this.bottleneckRadius, 1, this.bottleneckRadius);
    this.pulseT = 0;
    this.bottleneckRing.visible = true;
  }

  get pickTargets(): Mesh[] {
    return [...this.meshes.values()];
  }

  itemIdOf(mesh: Mesh): string | null {
    for (const [id, m] of this.meshes) if (m === mesh) return id;
    return null;
  }

  setHover(id: string | null): void {
    if (id === this.hoveredId) return;
    if (this.hoveredId) {
      const prev = this.meshes.get(this.hoveredId);
      if (prev) {
        prev.material = this.furnitureMat;
        prev.position.y = 0;
      }
    }
    this.hoveredId = id;
    if (id) {
      const mesh = this.meshes.get(id);
      if (mesh) {
        mesh.material = this.hoverMat;
        mesh.position.y = 0.06; // slight lift (§27 feedback)
      }
    }
  }

  /** Hide an item while it rides the ghost during a move. */
  setHidden(id: string | null): void {
    if (this.hiddenId && this.hiddenId !== id) {
      const prev = this.meshes.get(this.hiddenId);
      if (prev) prev.visible = true;
    }
    this.hiddenId = id;
    if (id) {
      const mesh = this.meshes.get(id);
      if (mesh) mesh.visible = false;
    }
  }

  setGhost(defId: string, cellX: number, cellY: number, rot: Rot, valid: boolean): void {
    const def = furnitureDef(defId);
    const rect = footprintRect(def.cells, cellX, cellY, rot);
    const [wx, wz] = rectCenterWorld(this.cols, this.rows, rect);

    this.ghost.geometry = furnitureGeometry(defId);
    this.ghost.position.set(wx, FLOOR_Y + 0.02, wz);
    this.ghost.rotation.y = rot * (Math.PI / 2);
    this.ghostMat.color.set(valid ? PINE : ROSE);
    this.ghost.visible = true;

    this.footprint.scale.set(rect.w, rect.h, 1);
    this.footprint.position.set(wx, FLOOR_Y + 0.008, wz);
    (this.footprint.material as MeshBasicMaterial).color.set(valid ? PINE : ROSE);
    this.footprint.visible = true;
  }

  hideGhost(): void {
    this.ghost.visible = false;
    this.footprint.visible = false;
  }

  /** Path of cell indices (y·cols + x) drawn as a flat amber ribbon, or null. */
  setPath(cells: readonly number[] | null): void {
    if (!cells || cells.length === 0) {
      this.pathMesh.visible = false;
      return;
    }
    const half = 0.13;
    const y = FLOOR_Y + 0.012;
    // One quad per node plus one per segment: 6 vertices each.
    const quadCount = cells.length * 2 - 1;
    const positions = new Float32Array(quadCount * 6 * 3);
    let offset = 0;
    const pushQuad = (x0: number, z0: number, x1: number, z1: number): void => {
      const minX = Math.min(x0, x1) - half;
      const maxX = Math.max(x0, x1) + half;
      const minZ = Math.min(z0, z1) - half;
      const maxZ = Math.max(z0, z1) + half;
      // CCW seen from above (+Y normal) so the front face isn't culled.
      const quad = [minX, minZ, maxX, maxZ, maxX, minZ, minX, minZ, minX, maxZ, maxX, maxZ];
      for (let i = 0; i < 6; i++) {
        positions[offset++] = quad[i * 2]!;
        positions[offset++] = y;
        positions[offset++] = quad[i * 2 + 1]!;
      }
    };
    let prevX = 0;
    let prevZ = 0;
    for (let i = 0; i < cells.length; i++) {
      const cx = cells[i]! % this.cols;
      const cy = (cells[i]! - cx) / this.cols;
      const [wx, wz] = cellToWorld(this.cols, this.rows, cx, cy);
      pushQuad(wx, wz, wx, wz);
      if (i > 0) pushQuad(prevX, prevZ, wx, wz);
      prevX = wx;
      prevZ = wz;
    }
    this.pathGeometry.setAttribute("position", new BufferAttribute(positions, 3));
    this.pathGeometry.computeBoundingSphere();
    this.pathMesh.visible = true;
  }

  private setBuildMode(on: boolean): void {
    this.buildMode = on;
    this.gridLines.visible = on;
    this.refreshZone();
    if (!on) {
      this.hideGhost();
      this.setHover(null);
      this.setHidden(null);
    }
  }

  private refreshZone(): void {
    const zone = this.sim.backroomZone();
    if (!this.buildMode || !zone) {
      this.zoneMesh.visible = false;
      return;
    }
    const [wx, wz] = rectCenterWorld(this.cols, this.rows, zone);
    this.zoneMesh.scale.set(zone.w, zone.h, 1);
    this.zoneMesh.position.set(wx, FLOOR_Y + 0.005, wz);
    this.zoneMesh.visible = true;
  }

  private addItem(item: PlacedFurniture): void {
    const mesh = new Mesh(furnitureGeometry(item.defId), this.furnitureMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.meshes.set(item.id, mesh);
    this.placeMesh(mesh, item);
    this.furnitureLayer.add(mesh);
    this.refreshZone();
  }

  private moveItem(item: PlacedFurniture): void {
    const mesh = this.meshes.get(item.id);
    if (mesh) this.placeMesh(mesh, item);
    this.refreshZone();
  }

  private removeItem(id: string): void {
    const mesh = this.meshes.get(id);
    if (mesh) {
      this.furnitureLayer.remove(mesh);
      this.meshes.delete(id);
    }
    if (this.hoveredId === id) this.hoveredId = null;
    if (this.hiddenId === id) this.hiddenId = null;
    this.refreshZone();
  }

  private placeMesh(mesh: Mesh, item: PlacedFurniture): void {
    const def = furnitureDef(item.defId);
    const rect = footprintRect(def.cells, item.cellX, item.cellY, item.rot);
    const [wx, wz] = rectCenterWorld(this.cols, this.rows, rect);
    mesh.position.set(wx, 0, wz);
    mesh.rotation.y = item.rot * (Math.PI / 2);
  }

  // --- Shell construction ---

  private buildGround(): void {
    const ground = new Mesh(
      new PlaneGeometry(80, 80),
      new MeshLambertMaterial({ color: GROUND_SAGE, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const slab = new Mesh(
      new BoxGeometry(this.cols + 2 * WALL_T + 0.5, SLAB_H, this.rows + 2 * WALL_T + 0.5),
      new MeshLambertMaterial({ color: CREAM, flatShading: true }),
    );
    slab.position.y = SLAB_H / 2;
    slab.receiveShadow = true;
    this.store.add(slab);
  }

  private buildFloor(): void {
    const b = new PartsBuilder();
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const tile = new PlaneGeometry(1, 1);
        tile.rotateX(-Math.PI / 2);
        const [wx, wz] = cellToWorld(this.cols, this.rows, x, y);
        b.add(tile, (x + y) % 2 === 0 ? CREAM : MOSS, wx, 0, wz);
      }
    }
    const floor = new Mesh(b.build(), this.furnitureMat);
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.store.add(floor);

    // Brass threshold strip across the door gap
    const threshold = new Mesh(
      new BoxGeometry(DOOR_W, 0.02, WALL_T),
      new MeshLambertMaterial({ color: BRASS, flatShading: true }),
    );
    threshold.position.set(0, FLOOR_Y, this.rows / 2 + WALL_T / 2);
    this.store.add(threshold);
  }

  /** Cell grid drawn as thin quads (1-px GL lines vanish at this zoom). */
  private buildGridLines(): Mesh {
    const hx = this.cols / 2;
    const hz = this.rows / 2;
    const half = 0.022;
    const quads: [number, number, number, number][] = [];
    for (let x = 0; x <= this.cols; x++) quads.push([x - hx - half, -hz, x - hx + half, hz]);
    for (let y = 0; y <= this.rows; y++) quads.push([-hx, y - hz - half, hx, y - hz + half]);

    const positions = new Float32Array(quads.length * 6 * 3);
    let offset = 0;
    for (const [minX, minZ, maxX, maxZ] of quads) {
      // CCW seen from above (+Y normal) so the front face isn't culled.
      const corners = [minX, minZ, maxX, maxZ, maxX, minZ, minX, minZ, minX, maxZ, maxX, maxZ];
      for (let i = 0; i < 6; i++) {
        positions[offset++] = corners[i * 2]!;
        positions[offset++] = 0;
        positions[offset++] = corners[i * 2 + 1]!;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const lines = new Mesh(
      geometry,
      new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    lines.position.y = FLOOR_Y + 0.004;
    lines.renderOrder = 1;
    return lines;
  }

  private buildWalls(): void {
    const hx = this.cols / 2;
    const hz = this.rows / 2;
    const sides: { normal: Vector3; segments: [cx: number, cz: number, len: number][] }[] = [
      { normal: new Vector3(0, 0, -1), segments: [[0, -hz - WALL_T / 2, this.cols + 2 * WALL_T]] },
      {
        normal: new Vector3(0, 0, 1),
        segments: [
          [-(DOOR_W / 2 + (this.cols - DOOR_W) / 4), hz + WALL_T / 2, (this.cols - DOOR_W) / 2],
          [DOOR_W / 2 + (this.cols - DOOR_W) / 4, hz + WALL_T / 2, (this.cols - DOOR_W) / 2],
        ],
      },
      { normal: new Vector3(-1, 0, 0), segments: [[-hx - WALL_T / 2, 0, this.rows]] },
      { normal: new Vector3(1, 0, 0), segments: [[hx + WALL_T / 2, 0, this.rows]] },
    ];

    for (const side of sides) {
      const group = new Group();
      const wainscotMat = new MeshLambertMaterial({
        color: WALNUT,
        flatShading: true,
        transparent: true,
      });
      const upperMat = new MeshLambertMaterial({
        color: CREAM,
        flatShading: true,
        transparent: true,
      });
      const capMat = new MeshLambertMaterial({
        color: WALNUT,
        flatShading: true,
        transparent: true,
      });
      const alongX = side.normal.z !== 0;

      for (const [cx, cz, len] of side.segments) {
        const sizeX = alongX ? len : WALL_T;
        const sizeZ = alongX ? WALL_T : len;
        const wainscot = new Mesh(new BoxGeometry(sizeX, WAINSCOT_H, sizeZ), wainscotMat);
        wainscot.position.set(cx, SLAB_H + WAINSCOT_H / 2, cz);
        const upper = new Mesh(
          new BoxGeometry(sizeX, WALL_H - WAINSCOT_H, sizeZ),
          upperMat,
        );
        upper.position.set(cx, SLAB_H + WAINSCOT_H + (WALL_H - WAINSCOT_H) / 2, cz);
        const cap = new Mesh(
          new BoxGeometry(sizeX + (alongX ? 0 : 0.04), CAP_H, sizeZ + (alongX ? 0.04 : 0)),
          capMat,
        );
        cap.position.set(cx, SLAB_H + WALL_H + CAP_H / 2, cz);
        group.add(wainscot, upper, cap);
      }

      // Door posts frame the gap on the south side.
      if (side.normal.z === 1) {
        const postMat = wainscotMat;
        for (const dir of [-1, 1]) {
          const post = new Mesh(new BoxGeometry(0.14, WALL_H + 0.18, WALL_T + 0.1), postMat);
          post.position.set(dir * (DOOR_W / 2 + 0.07), SLAB_H + (WALL_H + 0.18) / 2, hz + WALL_T / 2);
          group.add(post);
        }
      }

      this.store.add(group);
      this.walls.push({
        group,
        materials: [wainscotMat, upperMat, capMat],
        normal: side.normal,
        opacity: 1,
      });
    }
  }
}
