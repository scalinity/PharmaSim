// The sim's one tiny seeded PRNG. Every deterministic stream — the §16
// event planner, the §9 hiring draws, the §21 forecast noise, the dev
// harness — draws through here, one stream per (seed, purpose). A leaf on
// purpose: this file imports nothing, so any module may reach it without
// a cycle. (The first step's `| 0` makes the init equivalent for any
// 32-bit seed pattern, signed or unsigned.)

/** mulberry32 — small, seedable, plenty for game streams. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
