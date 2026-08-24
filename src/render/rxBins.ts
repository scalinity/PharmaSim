// Rx bin label board (SPEC §8, §14, §25, §27): during a fill, the worked
// fixture's bin face grows generated paper labels — the one allowed canvas
// texture atlas — and the player clicks the right bin. The Rx shelf shows
// the 4×3 face; the controlled cabinet swings open into a 3×3 of Tier-3
// lockboxes; the medical fridge opens on a 2×2 of cold bins. One merged
// quad mesh (bin = faceIndex/2) plus an amber hover frame.

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
import { BIN_COLS, BIN_FACES, BIN_ROWS } from "../sim/workflow";
import { FLOOR_Y } from "./storeScene";

// Per-fixture face metrics. The shelf's numbers come from its mesh's bin
// face (render/meshes/furniture.ts rxShelf); the cabinet's are the same face
// scaled to span exactly its 1 m cell — the 0.82 m safe plus a hand's width
// of swung-open door rack — and centered on the body's height, in front of
// its deeper 0.66 m carcass. The fridge's 2×2 rides its two door halves,
// split at the mesh's y 0.62 door line, clear of the handle. The face's
// row/column *shape* is not declared here — it comes from the sim's
// BIN_FACES contract, so the label drawn on a bin and the drug behind it
// can never disagree. `view` is how much tighter the §8 fill glide frames
// the smaller face so a label keeps its on-screen size (main.ts).
interface FaceLayout {
  x0: number; // first column's center
  dx: number; // column pitch
  y0: number; // bottom row's center
  dy: number; // row pitch
  w: number; // label quad width
  h: number; // label quad height
  z: number; // label plane, in front of the fixture body
  view: number; // fill-glide view-height multiplier
}

const SHELF_FACE: FaceLayout = {
  x0: -0.6,
  dx: 0.6,
  y0: 0.36,
  dy: 0.42,
  w: 0.54,
  h: 0.37,
  z: 0.26,
  view: 1,
};

const CABINET_FACE: FaceLayout = {
  x0: -0.345,
  dx: 0.345,
  y0: 0.52,
  dy: 0.242,
  w: 0.31,
  h: 0.213,
  z: 0.38,
  view: 0.575,
};

const FRIDGE_FACE: FaceLayout = {
  x0: -0.19,
  dx: 0.38,
  y0: 0.55,
  dy: 0.6,
  w: 0.34,
  h: 0.235,
  z: 0.42,
  view: 0.62,
};

const TILE_W = 256;
const TILE_H = 128;
const NAME_PX = 44; // as large as the tallest label line can be set
const NAME_SQUEEZE = 0.8; // how narrow a long name may go before it loses size

/** Split "Metoprolol 50 mg" into the name and the strength line. */
function splitName(name: string): [string, string] {
  const space = name.indexOf(" ");
  return space === -1 ? [name, ""] : [name.slice(0, space), name.slice(space + 1)];
}

function drawAtlas(canvas: HTMLCanvasElement, bins: string[], cols: number): void {
  // The atlas stays at the shelf's 4×3 size whatever face is shown — a
  // resized canvas would force the GPU texture to reallocate mid-session
  // (GL_INVALID_VALUE on the sub-texture copy). A smaller face just leaves
  // trailing atlas tiles unsampled; the quads' UVs never reach them.
  canvas.width = TILE_W * BIN_COLS;
  canvas.height = TILE_H * BIN_ROWS;
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < bins.length; i++) {
    const x = (i % cols) * TILE_W;
    const y = Math.floor(i / cols) * TILE_H;

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
  /** Current face shape (from BIN_FACES) and metrics — quads rebuild when a
   *  fill swaps fixtures. */
  private rows = BIN_ROWS;
  private cols = BIN_COLS;
  private layout: FaceLayout = SHELF_FACE;

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
      new PlaneGeometry(this.layout.w + 0.08, this.layout.h + 0.08),
      new MeshBasicMaterial({ color: 0xe7a03c }),
    );
    this.hoverFrame.position.z = this.layout.z - 0.004;
    this.hoverFrame.visible = false;
    this.group.add(this.labelMesh, this.hoverFrame);
    this.group.visible = false;
  }

  get active(): boolean {
    return this.bins !== null;
  }

  /** One quad per bin at its face position; UVs point into the atlas tile. */
  private buildQuads(): BufferGeometry {
    const { rows, cols, layout } = this;
    const count = rows * cols;
    const positions = new Float32Array(count * 6 * 3);
    const uvs = new Float32Array(count * 6 * 2);
    let p = 0;
    let t = 0;
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const visualRow = Math.floor(i / cols); // 0 = top row
      const cx = layout.x0 + col * layout.dx;
      const cy = layout.y0 + (rows - 1 - visualRow) * layout.dy;
      const x0 = cx - layout.w / 2;
      const x1 = cx + layout.w / 2;
      const y0 = cy - layout.h / 2;
      const y1 = cy + layout.h / 2;
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
        positions[p++] = layout.z;
        uvs[t++] = u;
        uvs[t++] = v;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
    return geometry;
  }

  /** How much tighter the fill glide should frame the current face (§8). */
  get viewScale(): number {
    return this.layout.view;
  }

  /** Show the labeled bins on this fixture for the fill's drug layout — the
   *  face shape comes from the sim's BIN_FACES contract for the fixture. */
  show(shelf: PlacedFurniture, cols: number, rows: number, bins: string[]): void {
    this.bins = bins;

    const face = BIN_FACES[shelf.defId as keyof typeof BIN_FACES] ?? BIN_FACES.rx_shelf;
    const layout =
      shelf.defId === "cabinet_controlled"
        ? CABINET_FACE
        : shelf.defId === "fridge_medical"
          ? FRIDGE_FACE
          : SHELF_FACE;
    if (face.rows !== this.rows || face.cols !== this.cols || layout !== this.layout) {
      this.rows = face.rows;
      this.cols = face.cols;
      this.layout = layout;
      this.labelMesh.geometry.dispose();
      this.labelMesh.geometry = this.buildQuads();
      this.hoverFrame.geometry.dispose();
      this.hoverFrame.geometry = new PlaneGeometry(layout.w + 0.08, layout.h + 0.08);
      this.hoverFrame.position.z = layout.z - 0.004;
    }
    drawAtlas(this.canvas, bins, face.cols);
    this.texture.needsUpdate = true;

    const def = furnitureDef(shelf.defId);
    const rect = footprintRect(def.cells, shelf.cellX, shelf.cellY, shelf.rot);
    const [wx, wz] = rectCenterWorld(cols, rows, rect);
    this.group.position.set(wx, FLOOR_Y, wz);
    this.group.rotation.y = shelf.rot * (Math.PI / 2);
    this.focus.set(wx, FLOOR_Y + layout.y0 + ((face.rows - 1) * layout.dy) / 2, wz);
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
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return -1;
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
    const col = index % this.cols;
    const visualRow = Math.floor(index / this.cols);
    this.hoverFrame.position.x = this.layout.x0 + col * this.layout.dx;
    this.hoverFrame.position.y = this.layout.y0 + (this.rows - 1 - visualRow) * this.layout.dy;
    this.hoverFrame.visible = true;
  }
}
