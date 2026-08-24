// Staff on the floor (SPEC §27): pine-green aprons over plain work shirts,
// one merged mesh per hire — a handful of draw calls for the whole crew,
// well inside the §30 budget. Positions interpolate between sim ticks with
// the same stride bob as the customer crowd; the owner keeps the white coat
// (npcView.ts).

import {
  BoxGeometry,
  CapsuleGeometry,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  type Scene,
} from "three";
import type { Sim } from "../sim/sim";
import { activeStore } from "../sim/state";
import { PartsBuilder } from "./meshes/parts";
import { FLOOR_Y } from "./storeScene";

const PINE = 0x2f6b4f;
const PAPER = 0xfbf8f0;

/** Work-shirt sleeves under the apron — quieter than customer outfits. */
const SHIRTS = [0xd9d4c5, 0xa9b2b0, 0xc9bfa8, 0x8fa3a0, 0xbfb4c4, 0xb5c4b1];
const SKINS = [0xf2d3b3, 0xe0b08c, 0xc08a5f, 0x8d5b3b, 0x6b4630, 0xf7e1c8];

const BODY_Y = 0.5;
const HEAD_Y = 1.22;
const BOB_AMP = 0.045;
const BOB_FREQ = 5.2;

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildStaffMesh(memberId: string, material: MeshLambertMaterial): Mesh {
  const hash = hashString(memberId);
  const shirt = SHIRTS[hash % SHIRTS.length]!;
  const skin = SKINS[(hash >>> 3) % SKINS.length]!;

  const b = new PartsBuilder();
  b.add(new CapsuleGeometry(0.19, 0.62, 3, 10), shirt, 0, BODY_Y, 0);
  b.add(new SphereGeometry(0.16, 10, 8), skin, 0, HEAD_Y, 0);
  // The apron: bib and skirt down the front, strap across the chest.
  b.add(new BoxGeometry(0.34, 0.62, 0.05), PINE, 0, 0.56, 0.185);
  b.add(new BoxGeometry(0.3, 0.05, 0.05), PINE, 0, 0.92, 0.18);
  // Paper name tag clipped to the bib.
  b.add(new BoxGeometry(0.09, 0.06, 0.02), PAPER, 0.1, 0.79, 0.215);

  const mesh = new Mesh(b.build(), material);
  mesh.castShadow = true;
  return mesh;
}

export class StaffView {
  private meshes = new Map<string, Mesh>();
  /** Shared by every staff mesh and deliberately never disposed: the view
   *  lives as long as the scene. Per-hire geometry is what churns, and that
   *  is disposed on removal below. */
  private material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private seen = new Set<string>();

  constructor(
    private sim: Sim,
    private scene: Scene,
  ) {}

  /** Sync meshes to the roster and pose them for the frame. */
  update(alpha: number): void {
    const { cols, rows } = activeStore(this.sim.snapshot).grid;
    this.seen.clear();

    for (const agent of this.sim.staff.agents) {
      const id = agent.member.id;
      this.seen.add(id);
      let mesh = this.meshes.get(id);
      if (!mesh) {
        mesh = buildStaffMesh(id, this.material);
        this.meshes.set(id, mesh);
        this.scene.add(mesh);
      }

      const x = agent.prevX + (agent.x - agent.prevX) * alpha;
      const y = agent.prevY + (agent.y - agent.prevY) * alpha;
      const stride = agent.prevStride + (agent.stride - agent.prevStride) * alpha;
      let dYaw = (agent.yaw - agent.prevYaw) % (Math.PI * 2);
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const yaw = agent.prevYaw + dYaw * alpha;

      const moving = agent.stride - agent.prevStride > 1e-4;
      const bob = moving ? Math.abs(Math.sin(stride * BOB_FREQ)) * BOB_AMP : 0;

      mesh.position.set(x - cols / 2 + 0.5, FLOOR_Y + bob, y - rows / 2 + 0.5);
      mesh.rotation.y = yaw;
    }

    // Fired staff leave the scene with their geometry.
    for (const [id, mesh] of this.meshes) {
      if (this.seen.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(id);
    }
  }
}
