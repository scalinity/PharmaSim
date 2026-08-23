// Era material palettes (SPEC §13, §27): the four generations as color
// systems. Furniture factories and the store shell both read these — the
// silhouettes never change between eras, only the materials (§13). The
// Renovate sheet's paint chips read the same values, so the proposal the
// player buys is the store they get. Plain numbers, no three.js imports.

export interface EraShell {
  /** Checkerboard floor tiles. */
  floorA: number;
  floorB: number;
  wainscot: number;
  wallUpper: number;
  /** Gen 4's upper walls are glass: < 1 renders them see-through (§27). */
  wallUpperOpacity: number;
  /** Wall cap — Gen 3 reads as the drop ceiling's fascia, so it widens. */
  cap: number;
  capWide: boolean;
  /** Gen 2 only: a fluorescent strip glows under the cap. */
  fluorescent: number | null;
  threshold: number;
}

export interface EraPalette {
  era: 1 | 2 | 3 | 4;
  /** Structural casework: shelving uprights, counter bodies, chair frames. */
  wood: number;
  /** Boards and lighter panels of the same casework. */
  woodLight: number;
  /** Hardware and edging: brass → chrome → satin steel → brushed steel. */
  metal: number;
  /** Worktops and seats: cream → linoleum → white laminate → warm white. */
  surface: number;
  shell: EraShell;
}

/** §13/§27: walnut, brass, checkerboard cream/moss. */
const GEN1: EraPalette = {
  era: 1,
  wood: 0x6b4a32,
  woodLight: 0x85603f,
  metal: 0xc9a86a,
  surface: 0xf1ead8,
  shell: {
    floorA: 0xf1ead8,
    floorB: 0x96a57f,
    wainscot: 0x6b4a32,
    wallUpper: 0xf1ead8,
    wallUpperOpacity: 1,
    cap: 0x6b4a32,
    capWide: false,
    fluorescent: null,
    threshold: 0xc9a86a,
  },
};

/** §13/§27: teal linoleum, chrome edges, fluorescent strips. */
const GEN2: EraPalette = {
  era: 2,
  wood: 0x3e8c84,
  woodLight: 0x58a198,
  metal: 0xc8cfd2,
  surface: 0xd9d4c5,
  shell: {
    floorA: 0xd9d4c5,
    floorB: 0x3e8c84,
    wainscot: 0x3e8c84,
    wallUpper: 0xe9e5d8,
    wallUpperOpacity: 1,
    cap: 0xc8cfd2,
    capWide: false,
    fluorescent: 0xf6f8f0,
    threshold: 0xc8cfd2,
  },
};

/** §13/§27: gray-blue steel, white gondolas, drop ceiling. */
const GEN3: EraPalette = {
  era: 3,
  wood: 0x7d93a3,
  woodLight: 0xe8eaec,
  metal: 0x55606a,
  surface: 0xe8eaec,
  shell: {
    floorA: 0xd4d7da,
    floorB: 0xc6cbcf,
    wainscot: 0x7d93a3,
    wallUpper: 0xedeef0,
    wallUpperOpacity: 1,
    cap: 0xf4f5f6,
    capWide: true,
    fluorescent: null,
    threshold: 0x9aa5ad,
  },
};

/** §13/§27: mint + white + glass, light oak. */
const GEN4: EraPalette = {
  era: 4,
  wood: 0xc5a470,
  woodLight: 0xd8bc8e,
  metal: 0xb8bfc2,
  surface: 0xfafaf7,
  shell: {
    floorA: 0xf4f3ee,
    floorB: 0xe4eee8,
    wainscot: 0xc5a470,
    wallUpper: 0xdff0e7,
    wallUpperOpacity: 0.4,
    cap: 0xfafaf7,
    capWide: false,
    fluorescent: null,
    threshold: 0xb8bfc2,
  },
};

const PALETTES: Record<number, EraPalette> = { 1: GEN1, 2: GEN2, 3: GEN3, 4: GEN4 };

export function eraPalette(era: number): EraPalette {
  const palette = PALETTES[era];
  if (!palette) throw new Error(`Unknown era: ${era}`);
  return palette;
}

/** The paint chips a renovation actually applies — for the Renovate sheet. */
export function eraSwatches(era: number): string[] {
  const p = eraPalette(era);
  const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
  return [p.wood, p.metal, p.surface, p.shell.floorA, p.shell.floorB].map(hex);
}
