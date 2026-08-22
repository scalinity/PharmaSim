// Prescription workflow (SPEC §8, §24, §26): RxScript cards moving
// dropoff → fillQueue → filling → verifyQueue → verifying → ready → done.
// Solo era: the player fills at the bench by picking the right bin among
// confusable neighbors; with no verify desk, verification is implicit at
// handoff with a 90% catch. Pure sim — no DOM, no three.js.

import { IGM_PER_TICK } from "../core/clock";
import { DRUG_DEFS, TIER1_DRUGS, drugDef, type DrugDef } from "../data/drugs";
import type { SimEvent } from "./events";
import type { GameState } from "./state";

export type RxStage =
  | "dropoff"
  | "fillQueue"
  | "filling"
  | "verifyQueue"
  | "verifying"
  | "ready"
  | "done";

export interface RxScript {
  id: number;
  customerId: number;
  patientName: string;
  drugId: string;
  quantity: number;
  stage: RxStage;
  /** ≠ drugId ⇒ latent error travelling with the script (§8). */
  filledWithDrugId: string | null;
}

type Emit = (event: SimEvent) => void;

const FILL_IGM = 6; // §26 task durations
const SOLO_CATCH_RATE = 0.9; // §26 solo-owner implicit catch
export const BIN_ROWS = 4; // shelf bin face (render/meshes/furniture.ts)
export const BIN_COLS = 3;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Weighted Tier-1 draw — the demand generator's whole world until M08. */
function drawTier1Drug(): DrugDef {
  const total = TIER1_DRUGS.reduce((sum, def) => sum + def.demandWeight, 0);
  let u = Math.random() * total;
  for (const def of TIER1_DRUGS) {
    u -= def.demandWeight;
    if (u <= 0) return def;
  }
  return TIER1_DRUGS[TIER1_DRUGS.length - 1]!;
}

/**
 * Bin layout for one fill: 12 drug ids over the shelf's 4×3 face. The correct
 * bin's confusables (both directions of §25 `confusableWith`, padded with
 * same-category look-alikes up to 3) are always placed orthogonally adjacent,
 * shuffled each script; the rest is a Tier-1 spread.
 */
export function generateBins(correctId: string): string[] {
  const correct = drugDef(correctId);

  const confusables: string[] = [...(correct.confusableWith ?? [])];
  for (const def of DRUG_DEFS) {
    if (def.confusableWith?.includes(correct.id) && !confusables.includes(def.id)) {
      confusables.push(def.id);
    }
  }
  const sameCategory = shuffle(
    DRUG_DEFS.filter(
      (def) =>
        def.category === correct.category &&
        def.id !== correct.id &&
        !confusables.includes(def.id),
    ).map((def) => def.id),
  );
  const neighbors = [...confusables, ...sameCategory].slice(0, 3);

  // Cells with enough orthogonal room for every required neighbor.
  const cellCount = BIN_ROWS * BIN_COLS;
  const adjacentOf = (cell: number): number[] => {
    const row = Math.floor(cell / BIN_COLS);
    const col = cell % BIN_COLS;
    const out: number[] = [];
    if (row > 0) out.push(cell - BIN_COLS);
    if (row < BIN_ROWS - 1) out.push(cell + BIN_COLS);
    if (col > 0) out.push(cell - 1);
    if (col < BIN_COLS - 1) out.push(cell + 1);
    return out;
  };
  const candidates: number[] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    if (adjacentOf(cell).length >= neighbors.length) candidates.push(cell);
  }
  const correctCell = candidates[Math.floor(Math.random() * candidates.length)]!;

  const bins = new Array<string>(cellCount).fill("");
  bins[correctCell] = correct.id;
  const slots = shuffle(adjacentOf(correctCell));
  neighbors.forEach((id, i) => {
    bins[slots[i]!] = id;
  });

  const used = new Set(bins.filter((id) => id !== ""));
  const filler = shuffle(TIER1_DRUGS.filter((def) => !used.has(def.id)).map((def) => def.id));
  for (let cell = 0; cell < cellCount; cell++) {
    if (bins[cell] === "") bins[cell] = filler.pop()!;
  }
  return bins;
}

export class RxWorkflow {
  private scripts = new Map<number, RxScript>();
  private fillQueue: number[] = [];
  private fillingId: number | null = null;
  /** <0 = waiting on a bin pick; ≥0 = igm left on the fill animation. */
  private fillLeft = -1;
  private nextScriptId = 1;

  /** Scripts waiting for (or on) the bench — the bench's stage stack. */
  get fillDepth(): number {
    return this.fillQueue.length + (this.fillingId !== null ? 1 : 0);
  }

  get readyCount(): number {
    let n = 0;
    for (const script of this.scripts.values()) if (script.stage === "ready") n++;
    return n;
  }

  script(id: number): RxScript | undefined {
    return this.scripts.get(id);
  }

  /** New script written for an arriving Rx patient (stage: dropoff). */
  createScript(customerId: number, patientName: string): RxScript {
    const drug = drawTier1Drug();
    const script: RxScript = {
      id: this.nextScriptId++,
      customerId,
      patientName,
      drugId: drug.id,
      // Quantity is card flavor; inhalers dispense as one unit.
      quantity: drug.id === "albuterolHFA" ? 1 : [30, 60, 90][Math.floor(Math.random() * 3)]!,
      stage: "dropoff",
      filledWithDrugId: null,
    };
    this.scripts.set(script.id, script);
    return script;
  }

  /**
   * Drop-off handoff: reserve a bin unit and queue the script, or refuse it
   * out of stock (caller applies the −0.08 rep and walk-away, §15).
   */
  tryAccept(state: GameState, script: RxScript, emit: Emit): boolean {
    const units = state.store.rxStock[script.drugId] ?? 0;
    if (units <= 0) {
      this.scripts.delete(script.id);
      return false;
    }
    state.store.rxStock[script.drugId] = units - 1;
    script.stage = "fillQueue";
    this.fillQueue.push(script.id);
    emit({ type: "rx.dropoff", scriptId: script.id, drugId: script.drugId });
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    this.syncStation(state, emit);
    return true;
  }

  /** Reconcile the fill interaction with wherever the player is working. */
  syncStation(state: GameState, emit: Emit): void {
    const station = state.store.furniture.find((f) => f.id === state.workingStationId);
    if (station?.defId === "fill_bench" && !state.buildMode) {
      this.takeNext(state, emit);
    } else if (this.fillingId !== null) {
      this.abortFilling(state, emit);
    }
  }

  /** Player at the bench takes the top script; the RxCard + bins appear. */
  private takeNext(state: GameState, emit: Emit): void {
    if (this.fillingId !== null) return;
    const id = this.fillQueue.shift();
    if (id === undefined) return;
    const script = this.scripts.get(id)!;
    script.stage = "filling";
    this.fillingId = id;
    this.fillLeft = -1;

    // Frame the Rx shelf nearest the worked bench (§8 camera glide).
    const bench = state.store.furniture.find((f) => f.id === state.workingStationId);
    let shelfId: string | null = null;
    let best = Infinity;
    for (const item of state.store.furniture) {
      if (item.defId !== "rx_shelf") continue;
      const dist = bench
        ? Math.abs(item.cellX - bench.cellX) + Math.abs(item.cellY - bench.cellY)
        : 0;
      if (dist < best) {
        best = dist;
        shelfId = item.id;
      }
    }

    emit({
      type: "rx.fillStarted",
      scriptId: script.id,
      drugId: script.drugId,
      patientName: script.patientName,
      quantity: script.quantity,
      bins: generateBins(script.drugId),
      shelfId,
    });
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
  }

  /** Stepping away mid-fill puts the script back on top of the queue. */
  private abortFilling(state: GameState, emit: Emit): void {
    const id = this.fillingId;
    if (id === null) return;
    const script = this.scripts.get(id)!;
    this.fillingId = null;
    this.fillLeft = -1;
    script.filledWithDrugId = null;
    script.stage = "fillQueue";
    this.fillQueue.unshift(id);
    emit({ type: "rx.fillEnded", scriptId: id });
    emit({ type: "rx.stageChanged", scriptId: id, stage: script.stage });
  }

  /** Bin clicked. A wrong label fills the wrong drug silently (§8). */
  pickBin(drugId: string, emit: Emit): void {
    if (this.fillingId === null || this.fillLeft >= 0) return;
    drugDef(drugId); // asserts a real catalog id
    const script = this.scripts.get(this.fillingId)!;
    script.filledWithDrugId = drugId;
    this.fillLeft = FILL_IGM;
    emit({ type: "rx.binPicked", scriptId: script.id });
  }

  /** Advance the fill animation; resolve implicit verification at its end. */
  tick(state: GameState, emit: Emit): void {
    if (this.fillingId === null || this.fillLeft < 0) return;
    this.fillLeft -= IGM_PER_TICK;
    if (this.fillLeft > 0) return;

    const script = this.scripts.get(this.fillingId)!;
    this.fillingId = null;
    this.fillLeft = -1;
    emit({ type: "rx.fillEnded", scriptId: script.id });

    // Solo era: verifyQueue/verifying collapse into an implicit handoff
    // check (§8) — a pharmacist at a desk owns these stages from M07.
    const wrong = script.filledWithDrugId !== script.drugId;
    if (wrong && Math.random() < SOLO_CATCH_RATE) {
      script.filledWithDrugId = null;
      script.stage = "fillQueue";
      this.fillQueue.unshift(script.id);
      emit({ type: "rx.caught", scriptId: script.id });
      emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    } else {
      script.stage = "ready";
      emit({ type: "rx.ready", scriptId: script.id });
      emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    }
    this.syncStation(state, emit);
  }

  /** Script handed over at pickup; the customer system settles the money. */
  finish(script: RxScript, emit: Emit): void {
    script.stage = "done";
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    this.scripts.delete(script.id);
  }

  /** Walk-out or lost counter: pull the script and return the reserved unit. */
  cancel(state: GameState, scriptId: number, emit: Emit): void {
    const script = this.scripts.get(scriptId);
    if (!script) return;
    if (script.stage !== "dropoff") {
      state.store.rxStock[script.drugId] = (state.store.rxStock[script.drugId] ?? 0) + 1;
    }
    const queued = this.fillQueue.indexOf(scriptId);
    if (queued !== -1) this.fillQueue.splice(queued, 1);
    if (this.fillingId === scriptId) {
      this.fillingId = null;
      this.fillLeft = -1;
      emit({ type: "rx.fillEnded", scriptId });
    }
    this.scripts.delete(scriptId);
    emit({ type: "rx.cancelled", scriptId });
    this.syncStation(state, emit);
  }
}
