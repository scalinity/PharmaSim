// Rx bin label board (SPEC §8, §25, §27): during a fill, the worked fixture's
// bin face grows generated paper labels — the one allowed canvas texture
// atlas — and the player clicks the right bin. The Rx shelf shows the 4×3
// face; the controlled cabinet swings open into a 3×3 of Tier-3 lockboxes.
// One merged quad mesh (bin = faceIndex/2) plus an amber hover frame.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Raycaster,
} from "three";
import { footprintRect, rectCenterWorld } from "../core/grid";
import { drugDef } from "../data/drugs";
import { furnitureDef } from "../data/furniture";
import type { PlacedFurniture } from "../sim/state";
import { BIN_COLS, BIN_ROWS } from "../sim/workflow";
import { FLOOR_Y } from "./storeScene";

// Bin face geometry from render/meshes/furniture.ts rxShelf(). The cabinet
// keeps the same label metrics (readability first) but sits deeper, so its
// labels hang a little further out to clear the safe's 0.66 m body.
const BIN_X0 = -0.6;
const BIN_DX = 0.6;
const BIN_Y0 = 0.36;
const BIN_DY = 0.42;
const SHELF_LABEL_Z = 0.26; // in front of the bin boxes and their paper strips
const CABINET_LABEL_Z = 0.38;
const LABEL_W = 0.54;
const LABEL_H = 0.37;

const TILE_W = 256;
const TILE_H = 128;
const NAME_PX = 44; // as large as the tallest label line can be set
const NAME_SQUEEZE = 0.8; // how narrow a long name may go before it loses size

/** Split "Metoprolol 50 mg" into the name and the strength line. */
function splitName(name: string): [string, string] {
  const space = name.indexOf(" ");
  return space === -1 ? [name, ""] : [name.slice(0, space), name.slice(space + 1)];
}

function drawAtlas(canvas: HTMLCanvasElement, bins: string[]): void {
  // The atlas stays at the shelf's 4-row size whatever face is shown — a
  // resized canvas would force the GPU texture to reallocate mid-session
  // (GL_INVALID_VALUE on the sub-texture copy). A 3-row face just leaves the
  // bottom atlas row unsampled; the quads' UVs never reach it.
  canvas.width = TILE_W * BIN_COLS;
  canvas.height = TILE_H * BIN_ROWS;
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < bins.length; i++) {
    const x = (i % BIN_COLS) * TILE_W;
    const y = Math.floor(i / BIN_COLS) * TILE_H;

    // Paper label with an ink frame (§28 shelf-label language).
    g.fillStyle = "#fbf4e4";
    g.fillRect(x, y, TILE_W, TILE_H);
    g.strokeStyle = "#20302b";
    g.lineWidth = 6;
    g.strokeRect(x + 5, y + 5, TILE_W - 10, TILE_H - 10);

    const [name, strength] = splitName(drugDef(bins[i]!).name);
    g.fillStyle = "#20302b";
    g.textAlign = "center";
    g.textBaseline = "middle";

    // Long names pay for their length in condensed letterforms before they pay
    // in point size, the way real shelf labels do — "Levothyroxine" set narrow
    // reads from across the room where the same name set small does not.
    g.font = `600 ${NAME_PX}px "IBM Plex Mono", monospace`;
    const fit = Math.min(1, (TILE_W - 24) / g.measureText(name).width);
    const squeeze = Math.max(fit, NAME_SQUEEZE);
    const size = Math.round((NAME_PX * fit) / squeeze);

    g.save();
    g.translate(x + TILE_W / 2, y + (strength ? 46 : TILE_H / 2));
    g.scale(squeeze, 1);
    g.font = `600 ${size}px "IBM Plex Mono", monospace`;
    g.fillText(name, 0, 0);
    g.restore();

    if (strength) {
      g.font = '500 28px "IBM Plex Mono", monospace';
      g.fillStyle = "#2f6b4f";
      g.fillText(strength, x + TILE_W / 2, y + 94);
    }
  }
}

export class RxBinBoard {
  readonly group = new Group();
  /** World centre of the label grid — what the fill glide aims at (§8). */
  readonly focus = new Vector3();

  private labelMesh: Mesh;
  private hoverFrame: Mesh;
  private canvas = document.createElement("canvas");
  private texture: CanvasTexture;
  private bins: string[] | null = null;
  private hoverIndex = -1;
  /** Current face layout — quads rebuild when a fill swaps fixtures. */
  private rows = 4;
  private labelZ = SHELF_LABEL_Z;

  constructor() {
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // The labels are read at a slant, and a slanted unfiltered atlas crawls as
    // the camera settles. Mips plus anisotropy keep the type still.
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.anisotropy = 8;

    this.labelMesh = new Mesh(
      this.buildQuads(),
      new MeshBasicMaterial({ map: this.texture }),
    );
    this.hoverFrame = new Mesh(
      new PlaneGeometry(LABEL_W + 0.08, LABEL_H + 0.08),
      new MeshBasicMaterial({ color: 0xe7a03c }),
    );
    this.hoverFrame.position.z = this.labelZ - 0.004;
    this.hoverFrame.visible = false;
    this.group.add(this.labelMesh, this.hoverFrame);
    this.group.visible = false;
  }

  get active(): boolean {
    return this.bins !== null;
  }

  /** One quad per bin at its face position; UVs point into the atlas tile. */
  private buildQuads(): BufferGeometry {
    const rows = this.rows;
    const count = rows * BIN_COLS;
    const positions = new Float32Array(count * 6 * 3);
    const uvs = new Float32Array(count * 6 * 2);
    let p = 0;
    let t = 0;
    for (let i = 0; i < count; i++) {
      const col = i % BIN_COLS;
      const visualRow = Math.floor(i / BIN_COLS); // 0 = top row
      const cx = BIN_X0 + col * BIN_DX;
      const cy = BIN_Y0 + (rows - 1 - visualRow) * BIN_DY;
      const x0 = cx - LABEL_W / 2;
      const x1 = cx + LABEL_W / 2;
      const y0 = cy - LABEL_H / 2;
      const y1 = cy + LABEL_H / 2;
      // CanvasTexture flips Y: v = 1 is the canvas top. The atlas is always
      // BIN_ROWS tall (see drawAtlas), whatever face is showing.
      const u0 = col / BIN_COLS;
      const u1 = (col + 1) / BIN_COLS;
      const v1 = 1 - visualRow / BIN_ROWS;
      const v0 = 1 - (visualRow + 1) / BIN_ROWS;
      // Two CCW triangles facing +Z: (bl, br, tr) and (bl, tr, tl).
      const quad: [number, number, number, number][] = [
        [x0, y0, u0, v0],
        [x1, y0, u1, v0],
        [x1, y1, u1, v1],
        [x0, y0, u0, v0],
        [x1, y1, u1, v1],
        [x0, y1, u0, v1],
      ];
      for (const [x, y, u, v] of quad) {
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = this.labelZ;
        uvs[t++] = u;
        uvs[t++] = v;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    return geometry;
  }

  /** Show the labeled bins on this fixture for the fill's drug layout — the
   *  face shape follows the bins array (12 = shelf 4×3, 9 = cabinet 3×3). */
  show(shelf: PlacedFurniture, cols: number, rows: number, bins: string[]): void {
    this.bins = bins;

    const binRows = bins.length / BIN_COLS;
    const labelZ = shelf.defId === "cabinet_controlled" ? CABINET_LABEL_Z : SHELF_LABEL_Z;
    if (binRows !== this.rows || labelZ !== this.labelZ) {
      this.rows = binRows;
      this.labelZ = labelZ;
      this.labelMesh.geometry.dispose();
      this.labelMesh.geometry = this.buildQuads();
      this.hoverFrame.position.z = labelZ - 0.004;
    }
    drawAtlas(this.canvas, bins);
    this.texture.needsUpdate = true;

    const def = furnitureDef(shelf.defId);
    const rect = footprintRect(def.cells, shelf.cellX, shelf.cellY, shelf.rot);
    const [wx, wz] = rectCenterWorld(cols, rows, rect);
    this.group.position.set(wx, FLOOR_Y, wz);
    this.group.rotation.y = shelf.rot * (Math.PI / 2);
    this.focus.set(wx, FLOOR_Y + BIN_Y0 + ((binRows - 1) * BIN_DY) / 2, wz);
    this.setHover(-1);
    this.group.visible = true;
  }

  hide(): void {
    this.bins = null;
    this.setHover(-1);
    this.group.visible = false;
  }

  /** Bin index under the ray, or -1. */
  pick(raycaster: Raycaster): number {
    if (!this.bins) return -1;
    const hit = raycaster.intersectObject(this.labelMesh, false)[0];
    if (!hit || hit.faceIndex === undefined) return -1;
    return Math.floor(hit.faceIndex / 2);
  }

  drugIdAt(index: number): string | null {
    return this.bins?.[index] ?? null;
  }

  setHover(index: number): void {
    if (index === this.hoverIndex) return;
    this.hoverIndex = index;
    if (index === -1 || !this.bins) {
      this.hoverFrame.visible = false;
      return;
    }
    const col = index % BIN_COLS;
    const visualRow = Math.floor(index / BIN_COLS);
    this.hoverFrame.position.x = BIN_X0 + col * BIN_DX;
    this.hoverFrame.position.y = BIN_Y0 + (this.rows - 1 - visualRow) * BIN_DY;
    this.hoverFrame.visible = true;
  }
}
