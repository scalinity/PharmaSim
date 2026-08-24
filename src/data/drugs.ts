// Rx drug catalog (SPEC §25 tables, §24 DrugDef shape). The full 49-SKU
// catalog ships now; license/equipment gating arrives with milestone 08 —
// until then the demand generator draws Tier-1 only (milestone 04 brief).

import type { RxCategory } from "./districts";

export type RxTier = 1 | 2 | 3;

export interface DrugDef {
  id: string;
  name: string;
  category: RxCategory;
  tier: RxTier;
  refrigerated?: boolean;
  /** $ per fill (pre-discount). */
  wholesale: number;
  /** $ fixed, insurer-set; margin = reimbursement − wholesale (§10). */
  reimbursement: number;
  demandWeight: 1 | 2 | 3;
  /** Ids shown as neighbor bins in the fill interaction (§8). */
  confusableWith?: string[];
}

export const DRUG_DEFS: readonly DrugDef[] = [
  // --- Tier 1 — Community Pharmacy license (start) ---
  { id: "lisinopril10", name: "Lisinopril 10 mg", category: "cardiovascular", tier: 1, wholesale: 2, reimbursement: 8, demandWeight: 3 },
  { id: "amlodipine5", name: "Amlodipine 5 mg", category: "cardiovascular", tier: 1, wholesale: 2, reimbursement: 7, demandWeight: 3 },
  { id: "metoprolol50", name: "Metoprolol 50 mg", category: "cardiovascular", tier: 1, wholesale: 3, reimbursement: 9, demandWeight: 3, confusableWith: ["metformin500"] },
  { id: "atorvastatin20", name: "Atorvastatin 20 mg", category: "cardiovascular", tier: 1, wholesale: 3, reimbursement: 10, demandWeight: 3 },
  { id: "hctz25", name: "Hydrochlorothiazide 25 mg", category: "cardiovascular", tier: 1, wholesale: 2, reimbursement: 6, demandWeight: 2 },
  { id: "losartan50", name: "Losartan 50 mg", category: "cardiovascular", tier: 1, wholesale: 3, reimbursement: 9, demandWeight: 2, confusableWith: ["lorazepam1"] },
  { id: "metformin500", name: "Metformin 500 mg", category: "diabetes", tier: 1, wholesale: 2, reimbursement: 8, demandWeight: 3, confusableWith: ["metoprolol50"] },
  { id: "glipizide5", name: "Glipizide 5 mg", category: "diabetes", tier: 1, wholesale: 3, reimbursement: 9, demandWeight: 2, confusableWith: ["glimepiride2"] },
  { id: "levothyroxine50", name: "Levothyroxine 50 mcg", category: "thyroid", tier: 1, wholesale: 2, reimbursement: 8, demandWeight: 3 },
  { id: "omeprazole20", name: "Omeprazole 20 mg", category: "gi", tier: 1, wholesale: 2, reimbursement: 7, demandWeight: 3, confusableWith: ["pantoprazole40"] },
  { id: "amoxicillin500", name: "Amoxicillin 500 mg", category: "antibiotics", tier: 1, wholesale: 3, reimbursement: 10, demandWeight: 3 },
  { id: "cephalexin500", name: "Cephalexin 500 mg", category: "antibiotics", tier: 1, wholesale: 4, reimbursement: 11, demandWeight: 2 },
  { id: "azithromycin250", name: "Azithromycin 250 mg", category: "antibiotics", tier: 1, wholesale: 5, reimbursement: 13, demandWeight: 2 },
  { id: "montelukast10", name: "Montelukast 10 mg", category: "respiratory", tier: 1, wholesale: 3, reimbursement: 9, demandWeight: 2 },
  { id: "albuterolHFA", name: "Albuterol HFA inhaler", category: "respiratory", tier: 1, wholesale: 12, reimbursement: 22, demandWeight: 3 },
  { id: "prednisone10", name: "Prednisone 10 mg", category: "respiratory", tier: 1, wholesale: 2, reimbursement: 7, demandWeight: 2, confusableWith: ["prednisolone15"] },

  // --- Tier 2 — Expanded Formulary (L2) ---
  { id: "sertraline50", name: "Sertraline 50 mg", category: "mentalHealth", tier: 2, wholesale: 3, reimbursement: 11, demandWeight: 3 },
  { id: "escitalopram10", name: "Escitalopram 10 mg", category: "mentalHealth", tier: 2, wholesale: 3, reimbursement: 11, demandWeight: 3 },
  { id: "fluoxetine20", name: "Fluoxetine 20 mg", category: "mentalHealth", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 2 },
  { id: "bupropionXL150", name: "Bupropion XL 150 mg", category: "mentalHealth", tier: 2, wholesale: 5, reimbursement: 14, demandWeight: 2 },
  { id: "trazodone50", name: "Trazodone 50 mg", category: "mentalHealth", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 2, confusableWith: ["tramadol50"] },
  { id: "hydroxyzine25", name: "Hydroxyzine 25 mg", category: "mentalHealth", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 2, confusableWith: ["hydralazine25"] },
  { id: "gabapentin300", name: "Gabapentin 300 mg", category: "pain", tier: 2, wholesale: 3, reimbursement: 11, demandWeight: 3 },
  { id: "hydralazine25", name: "Hydralazine 25 mg", category: "cardiovascular", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 1, confusableWith: ["hydroxyzine25"] },
  { id: "clonidine01", name: "Clonidine 0.1 mg", category: "cardiovascular", tier: 2, wholesale: 2, reimbursement: 9, demandWeight: 1, confusableWith: ["clonazepam05"] },
  { id: "warfarin5", name: "Warfarin 5 mg", category: "anticoagulant", tier: 2, wholesale: 3, reimbursement: 12, demandWeight: 2 },
  { id: "apixaban5", name: "Apixaban 5 mg", category: "anticoagulant", tier: 2, wholesale: 18, reimbursement: 34, demandWeight: 2 },
  { id: "clopidogrel75", name: "Clopidogrel 75 mg", category: "anticoagulant", tier: 2, wholesale: 3, reimbursement: 11, demandWeight: 2 },
  { id: "pantoprazole40", name: "Pantoprazole 40 mg", category: "gi", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 2, confusableWith: ["omeprazole20"] },
  { id: "ondansetron4", name: "Ondansetron 4 mg", category: "gi", tier: 2, wholesale: 4, reimbursement: 12, demandWeight: 2 },
  { id: "doxycycline100", name: "Doxycycline 100 mg", category: "antibiotics", tier: 2, wholesale: 5, reimbursement: 13, demandWeight: 2 },
  { id: "ciprofloxacin500", name: "Ciprofloxacin 500 mg", category: "antibiotics", tier: 2, wholesale: 4, reimbursement: 12, demandWeight: 1 },
  { id: "fluticasoneInh", name: "Fluticasone inhaler", category: "respiratory", tier: 2, wholesale: 14, reimbursement: 26, demandWeight: 2 },
  { id: "prednisolone15", name: "Prednisolone 15 mg/5 mL", category: "pediatric", tier: 2, wholesale: 4, reimbursement: 11, demandWeight: 2, confusableWith: ["prednisone10"] },
  { id: "glimepiride2", name: "Glimepiride 2 mg", category: "diabetes", tier: 2, wholesale: 3, reimbursement: 10, demandWeight: 1, confusableWith: ["glipizide5"] },
  { id: "tretinoinCr", name: "Tretinoin 0.05% cream", category: "dermatology", tier: 2, wholesale: 8, reimbursement: 18, demandWeight: 1 },

  // --- Refrigerated (fridge required; L2 except the vaccine dose, L4) ---
  { id: "glargine", name: "Insulin glargine pen", category: "diabetes", tier: 2, refrigerated: true, wholesale: 28, reimbursement: 52, demandWeight: 2 },
  { id: "lispro", name: "Insulin lispro pen", category: "diabetes", tier: 2, refrigerated: true, wholesale: 24, reimbursement: 45, demandWeight: 2 },
  { id: "semaglutide", name: "Semaglutide pen", category: "diabetes", tier: 2, refrigerated: true, wholesale: 85, reimbursement: 120, demandWeight: 2 },
  { id: "fluVaxDose", name: "Influenza vaccine dose", category: "vaccines", tier: 2, refrigerated: true, wholesale: 8, reimbursement: 30, demandWeight: 3 },

  // --- Tier 3 — Controlled Substances (L3 + cabinet) ---
  { id: "tramadol50", name: "Tramadol 50 mg", category: "pain", tier: 3, wholesale: 4, reimbursement: 15, demandWeight: 2, confusableWith: ["trazodone50"] },
  { id: "hydrocodoneAPAP", name: "Hydrocodone/APAP 5-325", category: "pain", tier: 3, wholesale: 5, reimbursement: 18, demandWeight: 2 },
  { id: "oxycodone5", name: "Oxycodone 5 mg", category: "pain", tier: 3, wholesale: 6, reimbursement: 22, demandWeight: 1 },
  { id: "alprazolam05", name: "Alprazolam 0.5 mg", category: "mentalHealth", tier: 3, wholesale: 3, reimbursement: 14, demandWeight: 2 },
  { id: "clonazepam05", name: "Clonazepam 0.5 mg", category: "mentalHealth", tier: 3, wholesale: 3, reimbursement: 14, demandWeight: 1, confusableWith: ["clonidine01"] },
  { id: "lorazepam1", name: "Lorazepam 1 mg", category: "mentalHealth", tier: 3, wholesale: 3, reimbursement: 14, demandWeight: 1, confusableWith: ["losartan50"] },
  { id: "zolpidem10", name: "Zolpidem 10 mg", category: "mentalHealth", tier: 3, wholesale: 3, reimbursement: 13, demandWeight: 2 },
  { id: "amphetamineXR20", name: "Amphetamine salts XR 20 mg", category: "mentalHealth", tier: 3, wholesale: 7, reimbursement: 24, demandWeight: 2 },
  { id: "methylphenidate10", name: "Methylphenidate 10 mg", category: "mentalHealth", tier: 3, wholesale: 6, reimbursement: 20, demandWeight: 1 },
];

const DEF_BY_ID = new Map(DRUG_DEFS.map((def) => [def.id, def]));

export function drugDef(id: string): DrugDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown drug def: ${id}`);
  return def;
}
