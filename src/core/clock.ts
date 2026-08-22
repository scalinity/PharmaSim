// In-game time math (SPEC §5, §26).
// Day runs 08:00–20:00 = 720 in-game minutes (igm).
// At 1× speed, 1 real second = 2.4 igm, so a full day ≈ 5 real minutes.

export const DAY_START_IGM = 480; // 08:00
export const DAY_END_IGM = 1200; // 20:00
export const DAY_LENGTH_IGM = DAY_END_IGM - DAY_START_IGM;

export const TICK_MS = 100; // sim tick, in scaled milliseconds
export const IGM_PER_REAL_SECOND = 2.4; // at 1× speed
export const IGM_PER_TICK = IGM_PER_REAL_SECOND * (TICK_MS / 1000);

const SEASONS = ["Spring", "Summer", "Fall", "Winter"] as const;
export type Season = (typeof SEASONS)[number];

export const DAYS_PER_SEASON = 14;

/** Season for a 1-based day number (14-day seasons, 56-day year). */
export function seasonForDay(day: number): Season {
  const dayOfYear = ((day - 1) % (DAYS_PER_SEASON * SEASONS.length)) + 1;
  return SEASONS[Math.floor((dayOfYear - 1) / DAYS_PER_SEASON)]!;
}

/** "HH:MM" for an igm-of-day value (480 → "08:00"). */
export function formatClock(igm: number): string {
  const total = Math.floor(igm);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 0..1 progress through the 08:00–20:00 day. */
export function dayProgress(igm: number): number {
  return Math.min(1, Math.max(0, (igm - DAY_START_IGM) / DAY_LENGTH_IGM));
}
