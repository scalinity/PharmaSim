// rAF render loop with a fixed-timestep sim accumulator (SPEC §4).
// The sim ticks every TICK_MS of *scaled* time; speed 0 (pause) stops
// accumulation entirely while the render loop keeps running.

import { TICK_MS } from "./clock";

export interface LoopHooks {
  /** Current speed multiplier: 0 (pause), 1, or 2. */
  getSpeed(): number;
  /** Advance the sim by one fixed tick. */
  tick(): void;
  /**
   * Render one frame; dtMs is real elapsed time since the last frame and
   * alpha is the 0..1 progress into the next sim tick (NPC interpolation).
   */
  render(dtMs: number, alpha: number): void;
}

const MAX_FRAME_MS = 250; // clamp after tab switches so we never spiral

export function startLoop(hooks: LoopHooks): void {
  let last = performance.now();
  let accumulator = 0;

  function frame(now: number): void {
    const dtMs = Math.min(now - last, MAX_FRAME_MS);
    last = now;

    accumulator += dtMs * hooks.getSpeed();
    while (accumulator >= TICK_MS) {
      hooks.tick();
      accumulator -= TICK_MS;
    }

    hooks.render(dtMs, accumulator / TICK_MS);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
