// A* over walkable cells, 4-directional (SPEC §6), plus flood-fill
// reachability. A Pathfinder owns preallocated buffers sized to its grid and
// stamps them per search instead of clearing, so re-pathing is allocation-free.

import { cellIndex } from "./grid";

const DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export class Pathfinder {
  private gScore: Float64Array;
  private cameFrom: Int32Array;
  private visitStamp: Uint32Array;
  private closedStamp: Uint32Array;
  private open: Int32Array; // unsorted open list of cell indices
  private stamp = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    const n = cols * rows;
    this.gScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.visitStamp = new Uint32Array(n);
    this.closedStamp = new Uint32Array(n);
    this.open = new Int32Array(n);
  }

  /**
   * Shortest 4-directional path from (sx,sy) to (tx,ty). `walkable` is indexed
   * by cell (y·cols + x); nonzero = passable. Writes cell indices into `out`
   * (start → target inclusive) and returns the path length, or -1 if
   * unreachable. The grid is small, so the open list is scanned linearly.
   */
  findPath(
    walkable: Uint8Array,
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    out: number[],
  ): number {
    out.length = 0;
    const { cols, rows } = this;
    const start = cellIndex(cols, sx, sy);
    const target = cellIndex(cols, tx, ty);
    if (!walkable[start] || !walkable[target]) return -1;
    if (start === target) {
      out.push(start);
      return 1;
    }

    const stamp = ++this.stamp;
    const { gScore, cameFrom, visitStamp, closedStamp, open } = this;

    gScore[start] = 0;
    cameFrom[start] = -1;
    visitStamp[start] = stamp;
    open[0] = start;
    let openCount = 1;

    while (openCount > 0) {
      // Pop the open cell with the lowest f = g + manhattan(cell, target).
      let bestSlot = 0;
      let bestF = Infinity;
      for (let i = 0; i < openCount; i++) {
        const cell = open[i]!;
        const cx = cell % cols;
        const cy = (cell - cx) / cols;
        const f = gScore[cell]! + Math.abs(cx - tx) + Math.abs(cy - ty);
        if (f < bestF) {
          bestF = f;
          bestSlot = i;
        }
      }
      const current = open[bestSlot]!;
      open[bestSlot] = open[--openCount]!;
      closedStamp[current] = stamp;

      if (current === target) {
        for (let cell = target; cell !== -1; cell = cameFrom[cell]!) out.push(cell);
        out.reverse();
        return out.length;
      }

      const cx = current % cols;
      const cy = (current - cx) / cols;
      const g = gScore[current]! + 1;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const next = cellIndex(cols, nx, ny);
        if (!walkable[next] || closedStamp[next] === stamp) continue;
        if (visitStamp[next] === stamp && gScore[next]! <= g) continue;
        gScore[next] = g;
        cameFrom[next] = current;
        if (visitStamp[next] !== stamp) {
          visitStamp[next] = stamp;
          open[openCount++] = next;
        }
      }
    }
    return -1;
  }
}

/**
 * Flood fill from the given seed cells across walkable cells. Returns a
 * Uint8Array (per cell) with 1 for every reachable cell, seeds included.
 * Seeds standing on blocked cells are skipped.
 */
export function floodFill(
  cols: number,
  rows: number,
  walkable: Uint8Array,
  seeds: readonly [number, number][],
): Uint8Array {
  const reached = new Uint8Array(cols * rows);
  const queue: number[] = [];
  for (const [x, y] of seeds) {
    const cell = cellIndex(cols, x, y);
    if (walkable[cell] && !reached[cell]) {
      reached[cell] = 1;
      queue.push(cell);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const cx = current % cols;
    const cy = (current - cx) / cols;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const next = cellIndex(cols, nx, ny);
      if (walkable[next] && !reached[next]) {
        reached[next] = 1;
        queue.push(next);
      }
    }
  }
  return reached;
}
