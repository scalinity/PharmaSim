// Instanced customer crowd (SPEC §27, §30): capsule body + sphere head +
// accent/bag box layers = 3 draw calls for the whole crowd, plus one
// instanced shader quad for the overhead patience rings and a single merged
// mesh for the owner working a station. Positions interpolate between sim
// ticks; walking adds a stride-driven bob (angry walk-outs storm out).

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Scene,
} from "three";
import { FACING, footprintRect, rectCenterWorld } from "../core/grid";
import { furnitureDef } from "../data/furniture";
import { showsPatienceRing } from "../sim/customers";
import type { Sim } from "../sim/sim";
import { PartsBuilder } from "./meshes/parts";
import { FLOOR_Y } from "./storeScene";

const MAX_NPCS = 40;

// §27 people palette: 6-part color scheme approximated as outfit/skin/accent.
const OUTFITS = [0x7d93a3, 0x8fae8b, 0xb0663f, 0xc9a86a, 0x96a57f, 0xa9b2b0];
const SKINS = [0xf2d3b3, 0xe0b08c, 0xc08a5f, 0x8d5b3b, 0x6b4630, 0xf7e1c8];
const ACCENTS: Record<string, number> = {
  hurried: 0xc0524e, // rose — walks out loudly
  steady: 0x2f6b4f, // pine
  bargain: 0xe7a03c, // amber
  chatty: 0x3e8c84, // teal
};
const BAG_COLOR = 0xd9c49a; // kraft paper

const BODY_Y = 0.5; // capsule center over the feet
const HEAD_Y = 1.22;
const ACCENT_Y = 0.78;
const RING_Y = 1.72;
const BOB_AMP = 0.045;
const BOB_FREQ = 5.2; // radians per cell of stride
const SEAT_SINK = 0.22;

const RING_VERT = /* glsl */ `
  attribute float aProgress;
  varying vec2 vUv;
  varying float vProgress;
  void main() {
    vUv = uv;
    vProgress = aProgress;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vProgress;
  const float TAU = 6.28318530718;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p);
    float ring = smoothstep(0.30, 0.335, r) * (1.0 - smoothstep(0.455, 0.49, r));
    if (ring < 0.01) discard;
    float a = fract(atan(p.x, p.y) / TAU + 0.5);
    float filled = 1.0 - step(vProgress, a);
    vec3 pine = vec3(0.184, 0.420, 0.310);
    vec3 amber = vec3(0.906, 0.627, 0.235);
    vec3 rose = vec3(0.753, 0.322, 0.306);
    vec3 c = vProgress > 0.5
      ? mix(amber, pine, (vProgress - 0.5) * 2.0)
      : mix(rose, amber, vProgress * 2.0);
    gl_FragColor = vec4(c, ring * mix(0.14, 0.95, filled));
  }
`;

export class NpcView {
  private bodies: InstancedMesh;
  private heads: InstancedMesh;
  /** Archetype accent bands + carried bags share one box layer. */
  private boxes: InstancedMesh;
  private rings: InstancedMesh;
  private ringProgress: InstancedBufferAttribute;
  private owner: Mesh;

  private cols: number;
  private rows: number;

  // Scratch — no per-frame allocations (§30).
  private m = new Matrix4();
  private pos = new Vector3();
  private quat = new Quaternion();
  private scale = new Vector3(1, 1, 1);
  private axisY = new Vector3(0, 1, 0);
  private axisX = new Vector3(1, 0, 0);
  private tilt = new Quaternion();
  private color = new Color();

  constructor(
    private sim: Sim,
    scene: Scene,
  ) {
    const { cols, rows } = sim.snapshot.store.grid;
    this.cols = cols;
    this.rows = rows;

    const material = new MeshLambertMaterial({ flatShading: true });

    this.bodies = new InstancedMesh(new CapsuleGeometry(0.19, 0.62, 3, 10), material, MAX_NPCS);
    this.heads = new InstancedMesh(new SphereGeometry(0.16, 10, 8), material, MAX_NPCS);
    this.boxes = new InstancedMesh(new BoxGeometry(1, 1, 1), material, MAX_NPCS * 2);
    for (const mesh of [this.bodies, this.heads, this.boxes]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
    }
    this.bodies.castShadow = true;
    this.heads.castShadow = true;

    const ringGeometry = new PlaneGeometry(0.85, 0.85);
    ringGeometry.rotateX(-Math.PI / 2);
    this.ringProgress = new InstancedBufferAttribute(new Float32Array(MAX_NPCS), 1);
    this.ringProgress.setUsage(DynamicDrawUsage);
    ringGeometry.setAttribute("aProgress", this.ringProgress);
    this.rings = new InstancedMesh(
      ringGeometry,
      new ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
      MAX_NPCS,
    );
    this.rings.instanceMatrix.setUsage(DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.rings.renderOrder = 5;

    this.owner = this.buildOwner();
    this.owner.visible = false;

    scene.add(this.bodies, this.heads, this.boxes, this.rings, this.owner);
  }

  /** The player-owner in a white coat (§27), shown behind a worked station. */
  private buildOwner(): Mesh {
    const b = new PartsBuilder();
    b.add(new CapsuleGeometry(0.2, 0.64, 3, 10), 0xfafaf7, 0, BODY_Y + 0.02, 0);
    b.add(new SphereGeometry(0.16, 10, 8), 0xe0b08c, 0, HEAD_Y + 0.02, 0);
    b.add(new BoxGeometry(0.16, 0.16, 0.05), 0x2f6b4f, 0, 0.82, 0.19); // pine cross badge
    const mesh = new Mesh(b.build(), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.castShadow = true;
    return mesh;
  }

  /** Compose all instance matrices for the frame. alpha = tick interpolation. */
  update(alpha: number): void {
    const state = this.sim.snapshot;
    const { cols, rows } = this;
    let n = 0; // body/head instance cursor
    let nb = 0; // box layer cursor (accents + bags)
    let nr = 0; // ring cursor

    for (const c of this.sim.customers.list) {
      if (!c.active) continue;

      const x = c.prevX + (c.x - c.prevX) * alpha;
      const y = c.prevY + (c.y - c.prevY) * alpha;
      const stride = c.prevStride + (c.stride - c.prevStride) * alpha;
      let dYaw = (c.yaw - c.prevYaw) % (Math.PI * 2);
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const yaw = c.prevYaw + dYaw * alpha;

      const wx = x - cols / 2 + 0.5;
      const wz = y - rows / 2 + 0.5;
      // Feet settle from the store floor down to the sidewalk past the door.
      const outside = Math.min(1, Math.max(0, (y - (rows - 0.55)) / 0.9));
      const baseY = FLOOR_Y * (1 - outside);

      const moving = c.stride - c.prevStride > 1e-4;
      const seated = c.mode === "sit";
      const bobAmp = c.angry ? BOB_AMP * 1.8 : BOB_AMP;
      const bob = moving ? Math.abs(Math.sin(stride * BOB_FREQ)) * bobAmp : 0;
      const sink = seated ? SEAT_SINK : 0;

      this.quat.setFromAxisAngle(this.axisY, yaw);
      if (c.angry && moving) {
        // Storming out: a forward lean on top of the walk bob.
        this.tilt.setFromAxisAngle(this.axisX, 0.16);
        this.quat.multiply(this.tilt);
      }

      // Body
      this.pos.set(wx, baseY + BODY_Y + bob - sink, wz);
      this.scale.set(1, 1, 1);
      this.m.compose(this.pos, this.quat, this.scale);
      this.bodies.setMatrixAt(n, this.m);
      this.bodies.setColorAt(n, this.color.set(OUTFITS[Math.floor(c.seedA * OUTFITS.length)]!));

      // Head
      this.pos.set(wx, baseY + HEAD_Y + bob - sink, wz);
      this.m.compose(this.pos, this.quat, this.scale);
      this.heads.setMatrixAt(n, this.m);
      this.heads.setColorAt(n, this.color.set(SKINS[Math.floor(c.seedB * SKINS.length)]!));

      // Archetype accent band on the torso
      this.pos.set(wx, baseY + ACCENT_Y + bob - sink, wz);
      this.scale.set(0.43, 0.15, 0.43);
      this.m.compose(this.pos, this.quat, this.scale);
      this.boxes.setMatrixAt(nb, this.m);
      this.boxes.setColorAt(nb, this.color.set(ACCENTS[c.archetype]!));
      nb++;

      // Carried bag after checkout, held at the right side
      if (c.hasBag) {
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        this.pos.set(wx + cos * 0.3 + sin * 0.06, baseY + 0.48 + bob, wz - sin * 0.3 + cos * 0.06);
        this.scale.set(0.22, 0.3, 0.17);
        this.m.compose(this.pos, this.quat, this.scale);
        this.boxes.setMatrixAt(nb, this.m);
        this.boxes.setColorAt(nb, this.color.set(BAG_COLOR));
        nb++;
      }

      // Patience ring while waiting (§27: shrinking overhead arc)
      if (showsPatienceRing(c)) {
        this.pos.set(wx, baseY + RING_Y - sink, wz);
        this.m.makeTranslation(this.pos.x, this.pos.y, this.pos.z);
        this.rings.setMatrixAt(nr, this.m);
        this.ringProgress.setX(nr, Math.max(0, c.patience / c.maxPatience));
        nr++;
      }

      n++;
    }

    this.bodies.count = n;
    this.heads.count = n;
    this.boxes.count = nb;
    this.rings.count = nr;
    this.rings.visible = nr > 0;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.boxes.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.ringProgress.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;

    this.updateOwner(state.workingStationId);
  }

  /** Show the white-coat owner behind the station they're working. */
  private updateOwner(stationId: string | null): void {
    if (!stationId) {
      this.owner.visible = false;
      return;
    }
    const item = this.sim.snapshot.store.furniture.find((f) => f.id === stationId);
    if (!item) {
      this.owner.visible = false;
      return;
    }
    const def = furnitureDef(item.defId);
    const rect = footprintRect(def.cells, item.cellX, item.cellY, item.rot);
    const [cx, cz] = rectCenterWorld(this.cols, this.rows, rect);
    const [fx, fy] = FACING[item.rot]!;
    this.owner.position.set(cx - fx, FLOOR_Y, cz - fy);
    this.owner.rotation.y = Math.atan2(fx, fy);
    this.owner.visible = true;
  }
}
