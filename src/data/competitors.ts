// The four §18 rivals (SPEC §18 table, §24 CompetitorState, §27 accents).
// This file is content: identities, launch stat blocks, map sites and the
// drift headline copy. The *live* stats (price, rep, reliability move with
// §18 drift) persist on GameState.competitors; everything here stays fixed.

import { districtById } from "./districts";

export type CounselLevel = "low" | "mid" | "high";

/** One §18 drift notch: which attribute the rival improved. */
export type DriftMove = "price" | "rep" | "reliability";

export interface CompetitorDef {
  id: string;
  name: string;
  /** §18 style column — card and tooltip flavor. */
  style: string;
  homeDistrictId: string;
  /** §27 accent — marker cross, share bars, map tag dot. */
  accent: number;
  /** Marker site on the home district's plate (city-world x/z), picked
   *  clear of the landmark, lot, parks and the founding store. */
  site: [x: number, z: number];
  /** §18 launch stat block — seeds CompetitorState, then drift owns it. */
  priceIndex: number;
  repStars: number;
  counsel: CounselLevel;
  stockReliability: number;
}

export const COMPETITOR_DEFS: readonly CompetitorDef[] = [
  {
    id: "mediMart",
    name: "MediMart",
    style: "big-box discounter",
    homeDistrictId: "downtown",
    accent: 0x3e6fae,
    site: [16, -19],
    priceIndex: 0.85,
    repStars: 2.0,
    counsel: "low",
    stockReliability: 0.9,
  },
  {
    id: "greenCross",
    name: "GreenCross Drugs",
    style: "steady mid-market",
    homeDistrictId: "riverside",
    accent: 0x74a857,
    site: [-29, -9],
    priceIndex: 1.0,
    repStars: 3.0,
    counsel: "mid",
    stockReliability: 0.85,
  },
  {
    id: "quickScripts",
    name: "QuickScripts",
    style: "speed-focused chain",
    homeDistrictId: "universityHeights",
    accent: 0xd97f35,
    site: [-3, -33],
    priceIndex: 1.05,
    repStars: 3.0,
    counsel: "low",
    stockReliability: 0.8,
  },
  {
    id: "harborApothecary",
    name: "Harbor Apothecary",
    style: "boutique service — the hometown rival",
    homeDistrictId: "oldTown",
    accent: 0x7d5a9e,
    site: [4, 4],
    priceIndex: 1.25,
    repStars: 4.0,
    counsel: "high",
    stockReliability: 0.75,
  },
];

const DEF_BY_ID = new Map(COMPETITOR_DEFS.map((def) => [def.id, def]));

export function competitorDef(id: string): CompetitorDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown competitor: ${id}`);
  return def;
}

export function isCompetitorId(id: string): boolean {
  return DEF_BY_ID.has(id);
}

/** §18 ticker copy for a drift move, in the §28 voice — the rep notch is
 *  the spec's own example ("MediMart renovates its Downtown location"). */
export function driftHeadline(competitorId: string, move: DriftMove): string {
  const def = competitorDef(competitorId);
  switch (move) {
    case "price":
      return `${def.name} cuts prices across the board`;
    case "rep":
      return `${def.name} renovates its ${districtById(def.homeDistrictId).name} location`;
    case "reliability":
      return `${def.name} signs a steadier wholesale contract`;
  }
}
