// The six city districts (SPEC §17 table, §24 District shape). Districts are
// the demand engine from milestone 3 onward; only Old Town is consumed until
// the city map arrives (M12). Prevalence = Rx scripts per 1k pop per day;
// otcIntent = OTC visits per 1k pop per day.

export type RxCategory =
  | "cardiovascular"
  | "diabetes"
  | "thyroid"
  | "gi"
  | "antibiotics"
  | "respiratory"
  | "mentalHealth"
  | "pain"
  | "anticoagulant"
  | "pediatric"
  | "dermatology"
  | "vaccines";

export type FacilityKind =
  | "clinic"
  | "hospital"
  | "nursingHome"
  | "urgentCare"
  | "pediatricOffice"
  | "walkInClinic";

export interface Facility {
  kind: FacilityKind;
  /** Flat bonus scripts per day by category (§17). */
  bonus: Partial<Record<RxCategory, number>>;
}

export interface District {
  id: string;
  name: string;
  population: number;
  dailyRent: number;
  prevalence: Partial<Record<RxCategory, number>>;
  otcIntent: number;
  facilities: Facility[];
  adjacent: string[];
}

export const DISTRICTS: readonly District[] = [
  {
    id: "oldTown",
    name: "Old Town",
    population: 6_800,
    dailyRent: 80,
    // Older mixed: cardiovascular ↑, diabetes →
    prevalence: {
      cardiovascular: 1.1,
      diabetes: 0.6,
      thyroid: 0.25,
      gi: 0.35,
      antibiotics: 0.35,
      respiratory: 0.3,
      mentalHealth: 0.25,
      pain: 0.3,
      anticoagulant: 0.3,
      dermatology: 0.1,
    },
    otcIntent: 9,
    facilities: [{ kind: "clinic", bonus: { antibiotics: 4, respiratory: 3 } }],
    adjacent: ["riverside", "downtown", "medicalDistrict"],
  },
  {
    id: "riverside",
    name: "Riverside",
    population: 9_400,
    dailyRent: 110,
    // Young families: pediatric ↑, allergy ↑
    prevalence: {
      pediatric: 0.8,
      antibiotics: 0.55,
      respiratory: 0.55,
      cardiovascular: 0.35,
      gi: 0.25,
      mentalHealth: 0.25,
      diabetes: 0.2,
      pain: 0.2,
      thyroid: 0.15,
      dermatology: 0.15,
    },
    otcIntent: 8,
    facilities: [{ kind: "pediatricOffice", bonus: { pediatric: 8, antibiotics: 3 } }],
    adjacent: ["oldTown", "universityHeights", "sunsetGlen"],
  },
  {
    id: "universityHeights",
    name: "University Heights",
    population: 11_200,
    dailyRent: 120,
    // Students: acute ↑, mental health →
    prevalence: {
      antibiotics: 0.6,
      mentalHealth: 0.6,
      respiratory: 0.4,
      gi: 0.35,
      pain: 0.35,
      dermatology: 0.25,
      cardiovascular: 0.15,
      diabetes: 0.1,
      thyroid: 0.1,
      pediatric: 0.05,
    },
    otcIntent: 10,
    facilities: [{ kind: "urgentCare", bonus: { antibiotics: 5, pain: 2 } }],
    adjacent: ["riverside", "downtown"],
  },
  {
    id: "sunsetGlen",
    name: "Sunset Glen",
    population: 5_100,
    dailyRent: 95,
    // Retirees: chronic ↑↑ (cardio, diabetes, anticoag)
    prevalence: {
      cardiovascular: 1.6,
      diabetes: 1.0,
      anticoagulant: 0.8,
      pain: 0.5,
      gi: 0.45,
      thyroid: 0.4,
      respiratory: 0.4,
      mentalHealth: 0.3,
      antibiotics: 0.3,
      dermatology: 0.15,
    },
    otcIntent: 6,
    facilities: [
      { kind: "nursingHome", bonus: { cardiovascular: 6, diabetes: 4, anticoagulant: 4 } },
    ],
    adjacent: ["riverside", "medicalDistrict"],
  },
  {
    id: "medicalDistrict",
    name: "Medical District",
    population: 7_600,
    dailyRent: 190,
    // Mixed: specialty ↑, post-hospital scripts ↑
    prevalence: {
      cardiovascular: 0.6,
      anticoagulant: 0.6,
      pain: 0.6,
      gi: 0.5,
      antibiotics: 0.5,
      mentalHealth: 0.4,
      respiratory: 0.4,
      diabetes: 0.4,
      dermatology: 0.3,
      thyroid: 0.25,
    },
    otcIntent: 9,
    facilities: [{ kind: "hospital", bonus: { anticoagulant: 5, pain: 4, gi: 3 } }],
    adjacent: ["oldTown", "sunsetGlen", "downtown"],
  },
  {
    id: "downtown",
    name: "Downtown",
    population: 12_500,
    dailyRent: 240,
    // Working adults: OTC convenience ↑↑, GI/stress →
    prevalence: {
      gi: 0.5,
      mentalHealth: 0.45,
      cardiovascular: 0.4,
      antibiotics: 0.35,
      respiratory: 0.3,
      pain: 0.3,
      diabetes: 0.25,
      thyroid: 0.15,
      dermatology: 0.15,
      pediatric: 0.05,
    },
    otcIntent: 14,
    facilities: [{ kind: "walkInClinic", bonus: { antibiotics: 4, gi: 2 } }],
    adjacent: ["oldTown", "universityHeights", "medicalDistrict"],
  },
];

const DISTRICT_BY_ID = new Map(DISTRICTS.map((d) => [d.id, d]));

export function districtById(id: string): District {
  const district = DISTRICT_BY_ID.get(id);
  if (!district) throw new Error(`Unknown district: ${id}`);
  return district;
}

// --- City map geometry (M12, SPEC §27) ---
//
// Where each district sits on the low-poly map, and the road ribbons that
// connect adjacent districts — the polylines M15's trucks will drive.
// Coordinates are city-scene world units (x east, z south); this is content
// beside the §24 schema, not part of it. The layout is a ring read off the
// adjacency lists: Old Town at the center touching Riverside, Downtown and
// the Medical District, with University Heights and Sunset Glen out on the
// rim — every ring edge is a real adjacency, and the two rim districts
// stand a road away from Old Town, exactly the 0.5/0.2 proximity story.

export interface DistrictMapDef {
  /** Plate center in city-world x/z. */
  center: [x: number, z: number];
  /** Rough plate radius — hover hit area and building scatter bound. */
  radius: number;
  /** Building tint — the district's silhouette color (§27). */
  tint: number;
  /** Building height range: bungalows to downtown slabs. */
  heights: [min: number, max: number];
  /** Instanced building count, scaled loosely to population. */
  blocks: number;
  /** Facility landmark spot. */
  facility: [x: number, z: number];
  /** The empty branch lot (§19) — renders now, buyable in M14. */
  lot: [x: number, z: number];
  /** Sage park discs: x, z, radius. */
  parks: [x: number, z: number, r: number][];
}

export const DISTRICT_MAPS: Record<string, DistrictMapDef> = {
  oldTown: {
    center: [0, 2],
    radius: 11,
    tint: 0xcdb392, // aged plaster and old brick
    heights: [0.8, 1.8],
    blocks: 22,
    facility: [5, -2],
    lot: [-6, -3],
    parks: [[3, 8, 2.6]],
  },
  riverside: {
    center: [-26, -6],
    radius: 12,
    tint: 0xa7c4bc, // pale porch-paint teal
    heights: [0.7, 1.5],
    blocks: 30,
    facility: [-22, -12],
    lot: [-31, 0],
    parks: [[-20, -1, 3.2]],
  },
  universityHeights: {
    center: [-8, -30],
    radius: 12,
    tint: 0xc69b7b, // collegiate terracotta
    heights: [1.0, 2.2],
    blocks: 32,
    facility: [-4, -26],
    lot: [-14, -35],
    parks: [[-12, -26, 2.8]], // the quad
  },
  sunsetGlen: {
    center: [-14, 26],
    radius: 10,
    tint: 0xd9c29a, // warm bungalow sand
    heights: [0.6, 1.2],
    blocks: 16,
    facility: [-10, 22],
    lot: [-19, 30],
    parks: [[-14, 31, 3.4]],
  },
  medicalDistrict: {
    center: [16, 16],
    radius: 11,
    tint: 0xe3e1d9, // clinical off-white
    heights: [1.4, 3.0],
    blocks: 20,
    facility: [14, 12],
    lot: [22, 21],
    parks: [[10, 20, 2.2]],
  },
  downtown: {
    center: [20, -14],
    radius: 13,
    tint: 0x8fa1ae, // gray-blue slabs
    heights: [2.2, 5.5],
    blocks: 40,
    facility: [13, -8],
    lot: [26, -20],
    parks: [[25, -8, 2.4]],
  },
};

/** Where the founding store stands in Old Town — the pine cross (§17, §27). */
export const STORE_SITE: [x: number, z: number] = [-4, 6];

export interface RoadDef {
  from: string;
  to: string;
  /** Centerline waypoints, endpoint districts' centers included. */
  points: readonly [x: number, z: number][];
}

/** One ribbon per adjacency edge (§17 table ↔ §27 map). */
export const ROADS: readonly RoadDef[] = [
  { from: "oldTown", to: "riverside", points: [[0, 2], [-13, 0], [-26, -6]] },
  { from: "oldTown", to: "downtown", points: [[0, 2], [10, -7], [20, -14]] },
  { from: "oldTown", to: "medicalDistrict", points: [[0, 2], [8, 9], [16, 16]] },
  { from: "riverside", to: "universityHeights", points: [[-26, -6], [-19, -19], [-8, -30]] },
  { from: "riverside", to: "sunsetGlen", points: [[-26, -6], [-22, 11], [-14, 26]] },
  { from: "universityHeights", to: "downtown", points: [[-8, -30], [7, -24], [20, -14]] },
  { from: "sunsetGlen", to: "medicalDistrict", points: [[-14, 26], [1, 23], [16, 16]] },
  { from: "medicalDistrict", to: "downtown", points: [[16, 16], [20, 1], [20, -14]] },
];

// --- The freight depot (M15, §20/§27) ---

/** The depot's id on hover/tag surfaces — beside the district ids, never
 *  one of them (districtById throws on it by design). */
export const DEPOT_ID = "depot";

/** Where the §20 distribution center stands: open ground on the east edge
 *  of town, clear of every district plate, its spur meeting the
 *  medicalDistrict↔downtown road at the [20, 1] waypoint. */
export const DEPOT_SITE: [x: number, z: number] = [30, 2];

/** Rough footprint radius — the map's hover hit area for the depot lot. */
export const DEPOT_RADIUS = 6;

/** The depot's own spur off the road network. Kept beside ROADS rather
 *  than in it: ROADS is one ribbon per §17 adjacency edge, and the depot
 *  is a building, not a district. */
export const DEPOT_SPUR: readonly [x: number, z: number][] = [
  [30, 2],
  [20, 1],
];

/** The river that names Riverside — a flat water ribbon past the west side. */
export const RIVER: readonly [x: number, z: number][] = [
  [-46, -40],
  [-38, -22],
  [-35, -2],
  [-38, 18],
  [-34, 42],
];
