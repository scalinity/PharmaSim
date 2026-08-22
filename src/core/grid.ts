// Grid math (SPEC §6): 1 cell = 1 m. Cell (0,0) is the north-west corner;
// cellX grows east, cellY grows south (toward the door). The store group sits
// at the world origin, so world x/z are cell coordinates re-centered.
//
// Rotation convention: rot 0 faces south (+cellY, toward the door); each step
// turns 90° counter-clockwise seen from above (mesh rotation.y = rot·π/2), so
// rot 1 faces east, rot 2 north, rot 3 west. Odd rotations swap a footprint's
// width and height.

export type Rot = 0 | 1 | 2 | 3;

/** Inclusive-min, exclusive-max rectangle of cells. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Unit facing vector per rotation, in cell coordinates (+y = south). */
export const FACING: readonly [dx: number, dy: number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

/** Footprint size after rotation: odd rotations swap width and height. */
export function rotatedSize(cells: [w: number, h: number], rot: Rot): [w: number, h: number] {
  return rot % 2 === 0 ? [cells[0], cells[1]] : [cells[1], cells[0]];
}

/** Footprint rect for a def placed with its min cell at (x, y). */
export function footprintRect(
  cells: [w: number, h: number],
  x: number,
  y: number,
  rot: Rot,
): CellRect {
  const [w, h] = rotatedSize(cells, rot);
  return { x, y, w, h };
}

export function rectContains(rect: CellRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

export function rectInBounds(rect: CellRect, cols: number, rows: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= cols && rect.y + rect.h <= rows;
}

export function cellIndex(cols: number, x: number, y: number): number {
  return y * cols + x;
}

/** World x/z of a cell's center (store centered on the origin). */
export function cellToWorld(cols: number, rows: number, x: number, y: number): [number, number] {
  return [x - cols / 2 + 0.5, y - rows / 2 + 0.5];
}

/** Cell under a world x/z point, or null outside the interior. */
export function worldToCell(
  cols: number,
  rows: number,
  wx: number,
  wz: number,
): [number, number] | null {
  const x = Math.floor(wx + cols / 2);
  const y = Math.floor(wz + rows / 2);
  if (x < 0 || x >= cols || y < 0 || y >= rows) return null;
  return [x, y];
}

/** World x/z of a footprint rect's center. */
export function rectCenterWorld(cols: number, rows: number, rect: CellRect): [number, number] {
  return [rect.x + rect.w / 2 - cols / 2, rect.y + rect.h / 2 - rows / 2];
}

/** Door cells: centered on the south wall (two cells while cols is even). */
export function doorCells(cols: number, rows: number): [number, number][] {
  const y = rows - 1;
  const mid = cols / 2;
  if (cols % 2 === 0) {
    return [
      [mid - 1, y],
      [mid, y],
    ];
  }
  return [[Math.floor(mid), y]];
}

/**
 * Backroom zone (SPEC §6): every cell strictly behind the service counter's
 * line — the half of the store the counter's back faces. Null when the rect
 * would be empty (counter flush against its wall) or there is no counter.
 */
export function deriveBackroom(
  counter: CellRect,
  counterRot: Rot,
  cols: number,
  rows: number,
): CellRect | null {
  let zone: CellRect;
  switch (counterRot) {
    case 0: // faces south → backroom is everything north of the counter
      zone = { x: 0, y: 0, w: cols, h: counter.y };
      break;
    case 2: // faces north
      zone = { x: 0, y: counter.y + counter.h, w: cols, h: rows - counter.y - counter.h };
      break;
    case 1: // faces east
      zone = { x: 0, y: 0, w: counter.x, h: rows };
      break;
    case 3: // faces west
      zone = { x: counter.x + counter.w, y: 0, w: cols - counter.x - counter.w, h: rows };
      break;
  }
  return zone.w > 0 && zone.h > 0 ? zone : null;
}

/**
 * Wall a wall-mounted item hangs on: the cell edge behind the item (opposite
 * its facing). Returns the outward direction in cell coordinates.
 */
export function wallDir(rot: Rot): [dx: number, dy: number] {
  const [fx, fy] = FACING[rot]!;
  return [-fx, -fy];
}
