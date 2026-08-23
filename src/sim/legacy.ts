// Legacy moments (SPEC §22): the once-per-run family milestones. This file
// owns the *once* — a moment lives in state.legacy from the day it fires, so
// a reloaded or replayed save can never fire it again. The words themselves
// live in data/flavor.ts; the receipt and the album read them from there.

import { isLegacyMoment } from "../data/flavor";
import type { SimEvent } from "./events";
import type { GameState } from "./state";

/** Record a §22 moment if this run hasn't lived it yet. */
export function recordMoment(
  state: GameState,
  id: string,
  emit: (event: SimEvent) => void,
): void {
  // Callers sit mid-transaction (a license purchase has already pushed,
  // posted and stamped by the time its moment fires), so an id the catalog
  // doesn't know must cost an album page, not a half-applied command.
  if (!isLegacyMoment(id)) {
    if (import.meta.env.DEV) console.warn(`[legacy] unknown moment id: ${id}`);
    return;
  }
  if (state.legacy.some((moment) => moment.id === id)) return;
  state.legacy.push({ id, day: state.day });
  emit({ type: "legacy.moment", id, day: state.day });
}
