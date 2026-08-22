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
