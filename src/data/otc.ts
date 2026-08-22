// OTC catalog (SPEC §25 front-store table, §24 OtcDef shape). Player pricing
// (0.8–1.5× MSRP) arrives in milestone 05; until then everything sells at ×1.0.

export type OtcCategory = "pain" | "allergy" | "coldflu" | "digestive" | "wellness" | "firstaid";

export interface OtcDef {
  id: string;
  name: string;
  category: OtcCategory;
  msrp: number;
  demandWeight: 1 | 2 | 3;
}

export const OTC_DEFS: readonly OtcDef[] = [
  { id: "acetaminophen", name: "Acetaminophen 500 mg", category: "pain", msrp: 8, demandWeight: 3 },
  { id: "ibuprofen", name: "Ibuprofen 200 mg", category: "pain", msrp: 9, demandWeight: 3 },
  { id: "naproxen", name: "Naproxen 220 mg", category: "pain", msrp: 10, demandWeight: 2 },
  { id: "aspirin81", name: "Aspirin 81 mg", category: "pain", msrp: 7, demandWeight: 2 },
  { id: "diphenhydramine", name: "Diphenhydramine 25 mg", category: "allergy", msrp: 7, demandWeight: 2 },
  { id: "loratadine", name: "Loratadine 10 mg", category: "allergy", msrp: 12, demandWeight: 3 },
  { id: "cetirizine", name: "Cetirizine 10 mg", category: "allergy", msrp: 13, demandWeight: 3 },
  { id: "fluticasoneSpray", name: "Fluticasone nasal spray", category: "allergy", msrp: 16, demandWeight: 2 },
  { id: "dextromethorphan", name: "Cough syrup (DM)", category: "coldflu", msrp: 9, demandWeight: 3 },
  { id: "guaifenesin", name: "Guaifenesin 400 mg", category: "coldflu", msrp: 11, demandWeight: 2 },
  { id: "pseudoephedrine", name: "Pseudoephedrine 30 mg", category: "coldflu", msrp: 12, demandWeight: 2 },
  { id: "lozenges", name: "Throat lozenges", category: "coldflu", msrp: 5, demandWeight: 2 },
  { id: "tissues", name: "Facial tissues", category: "coldflu", msrp: 4, demandWeight: 2 },
  { id: "omeprazoleOTC", name: "Omeprazole OTC 20 mg", category: "digestive", msrp: 14, demandWeight: 2 },
  { id: "famotidine", name: "Famotidine 20 mg", category: "digestive", msrp: 10, demandWeight: 2 },
  { id: "loperamide", name: "Loperamide 2 mg", category: "digestive", msrp: 9, demandWeight: 1 },
  { id: "multivitamin", name: "Daily multivitamin", category: "wellness", msrp: 12, demandWeight: 2 },
  { id: "vitaminD3", name: "Vitamin D3 2000 IU", category: "wellness", msrp: 10, demandWeight: 2 },
  { id: "melatonin", name: "Melatonin 5 mg", category: "wellness", msrp: 11, demandWeight: 2 },
  { id: "sanitizer", name: "Hand sanitizer", category: "wellness", msrp: 5, demandWeight: 1 },
  { id: "bandages", name: "Adhesive bandages", category: "firstaid", msrp: 6, demandWeight: 2 },
  { id: "firstAidKit", name: "First-aid kit", category: "firstaid", msrp: 18, demandWeight: 1 },
  { id: "thermometer", name: "Digital thermometer", category: "firstaid", msrp: 15, demandWeight: 1 },
];

const DEF_BY_ID = new Map(OTC_DEFS.map((def) => [def.id, def]));

export function otcDef(id: string): OtcDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown OTC def: ${id}`);
  return def;
}
