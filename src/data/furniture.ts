// Furniture catalog (SPEC §6 table, §24 FurnitureDef shape). Future-gated
// items carry `requires`; the palette and sim both enforce the gates.

export interface FurnitureDef {
  id: string;
  name: string;
  cost: number;
  cells: [w: number, h: number];
  zone: "public" | "backroom" | "any";
  capability: string;
  requires?: { license?: string; era?: number; furniture?: string[] };
  powered?: boolean; // adds $6/day utilities (§26; billed from milestone 05)
  /** Decor that never blocks pathing (rug lies flat, poster hangs on a wall). */
  walkable?: boolean;
  /** Flood-fill rule: must keep a walkable neighbor connected to the door. */
  needsAccess?: boolean;
  /** One per store. */
  unique?: boolean;
  /** Must hang on a wall: the cell edge behind it needs a wall segment. */
  wallMounted?: boolean;
}

export const FURNITURE_DEFS: readonly FurnitureDef[] = [
  {
    id: "counter_service",
    name: "Service counter",
    cost: 900,
    cells: [2, 1],
    zone: "any",
    capability: "Rx drop-off + pickup lanes (1 of each). One per store.",
    needsAccess: true,
    unique: true,
  },
  {
    id: "counter_register",
    name: "Register counter",
    cost: 500,
    cells: [1, 1],
    zone: "public",
    capability: "one checkout lane (OTC + copays)",
    needsAccess: true,
  },
  {
    id: "otc_shelf",
    name: "OTC shelf",
    cost: 400,
    cells: [2, 1],
    zone: "public",
    capability: "stocks 4 OTC SKUs × 24 units, browsable",
    needsAccess: true,
  },
  {
    id: "rx_shelf",
    name: "Rx shelf",
    cost: 600,
    cells: [2, 1],
    zone: "backroom",
    capability: "12 Rx SKU bins (backroom)",
    needsAccess: true,
  },
  {
    id: "fill_bench",
    name: "Fill bench",
    cost: 700,
    cells: [1, 1],
    zone: "backroom",
    capability: "one filling station",
    needsAccess: true,
  },
  {
    id: "verify_desk",
    name: "Verify desk",
    cost: 800,
    cells: [1, 1],
    zone: "backroom",
    capability: "one verification station",
    needsAccess: true,
  },
  {
    id: "chair_waiting",
    name: "Waiting chair",
    cost: 120,
    cells: [1, 1],
    zone: "public",
    capability: "seated waiters' patience drains at half rate",
    needsAccess: true,
  },
  {
    id: "fridge_medical",
    name: "Medical fridge",
    cost: 3500,
    cells: [1, 1],
    zone: "backroom",
    capability: "enables refrigerated SKUs (§14)",
    powered: true,
    needsAccess: true,
  },
  {
    id: "cabinet_controlled",
    name: "Controlled cabinet",
    cost: 4500,
    cells: [1, 1],
    zone: "backroom",
    capability: "enables Tier-3 controlled SKUs",
    requires: { license: "L3" },
    needsAccess: true,
  },
  {
    id: "vaccine_station",
    name: "Vaccine station",
    cost: 2500,
    cells: [2, 1],
    zone: "public",
    capability: "enables vaccination service",
    requires: { license: "L4", furniture: ["fridge_medical"] },
    needsAccess: true,
  },
  {
    id: "generator_backup",
    name: "Backup generator",
    cost: 5000,
    cells: [1, 1],
    zone: "any",
    capability: "refrigerated stock survives outages (§16)",
    powered: true,
  },
  {
    id: "dispenser_robotic",
    name: "Robotic dispenser",
    cost: 25_000,
    cells: [2, 2],
    zone: "backroom",
    capability: "auto-fills Tier-1/2 scripts, no tech needed",
    requires: { era: 4 },
    powered: true,
    needsAccess: true,
  },
  {
    id: "decor_plant",
    name: "Potted plant",
    cost: 80,
    cells: [1, 1],
    zone: "any",
    capability: "cosmetic; counts toward renovation flavor",
  },
  {
    id: "decor_rug",
    name: "Rug",
    cost: 150,
    cells: [2, 1],
    zone: "any",
    capability: "cosmetic; counts toward renovation flavor",
    walkable: true,
  },
  {
    id: "decor_poster",
    name: "Poster",
    cost: 60,
    cells: [1, 1],
    zone: "any",
    capability: "cosmetic; counts toward renovation flavor",
    walkable: true,
    wallMounted: true,
  },
];

const DEF_BY_ID = new Map(FURNITURE_DEFS.map((def) => [def.id, def]));

export function furnitureDef(id: string): FurnitureDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown furniture def: ${id}`);
  return def;
}

/** Palette copy for license gates (§12 names). */
export const LICENSE_NAMES: Record<string, string> = {
  L2: "Expanded Formulary",
  L3: "Controlled Substances",
  L4: "Immunization Certification",
  L5: "Multi-Branch Operation",
  L6: "Distribution Operations",
};

/** Floor expansions (§6, §26). Purchasing arrives with licenses in milestone 08. */
export const EXPANSIONS: readonly { cols: number; rows: number; cost: number }[] = [
  { cols: 13, rows: 7, cost: 4000 },
  { cols: 13, rows: 10, cost: 7000 },
  { cols: 16, rows: 10, cost: 12_000 },
  { cols: 16, rows: 12, cost: 16_000 },
];
