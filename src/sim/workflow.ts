// Prescription workflow (SPEC §8, §24, §26): RxScript cards moving
// dropoff → fillQueue → filling → verifyQueue → verifying → ready → done.
// The player fills at the bench by picking the right bin among confusable
// neighbors; techs fill probabilistically (claimFill/finishStaffFill, §26
// error table). With a manned verify desk the verify stages are real —
// pharmacists (or the player at the desk) check filled scripts and bounce
// caught errors back to the fill queue; with no verifier, verification is
// implicit at handoff with the owner's 90% catch. Pure sim — no DOM.

import { IGM_PER_TICK } from "../core/clock";
import { districtById } from "../data/districts";
import { DRUG_DEFS, drugDef, type DrugDef } from "../data/drugs";
import { STORE_DISTRICT_ID } from "./economy";
import type { SimEvent } from "./events";
import { returnShelved, takeShelved } from "./inventory";
import { drugDailyDemand, fillableDrugs } from "./licenses";
import { OWNER_CATCH_RATE } from "./staff";
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

export const FILL_IGM = 6; // §26 task durations
export const VERIFY_IGM = 8;
export const BIN_ROWS = 4; // shelf bin face (render/meshes/furniture.ts)
export const BIN_COLS = 3;
/** The cabinet's face is a 3×3 of lockbox bins — Tier 3 is nine SKUs (§25). */
export const CABINET_BIN_ROWS = 3;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Weighted draw over what the store is licensed and equipped to fill (§12,
 * §17): each fillable drug pulls with its slice of the district's daily
 * category generation, so an L2 wall writes mental-health scripts and a
 * stocked cabinet brings the controlled ones — never before.
 */
function drawScriptDrug(state: GameState): DrugDef {
  const district = districtById(STORE_DISTRICT_ID);
  const pool = fillableDrugs(state);
  let total = 0;
  for (const def of pool) total += drugDailyDemand(district, def);
  let u = Math.random() * total;
  for (const def of pool) {
    u -= drugDailyDemand(district, def);
    if (u <= 0) return def;
  }
  return pool[0]!;
}

/** Look-alike ids for a drug: §25 `confusableWith` both ways, padded with
 *  same-category neighbors up to 3 — the bins a hand reaches past. */
export function confusableNeighbors(correctId: string): string[] {
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
  return [...confusables, ...sameCategory].slice(0, 3);
}

/**
 * Bin layout for one fill: drug ids over the fixture's face, row-major. A
 * shelf fill spreads 4×3 across the store's licensed formulary; a controlled
 * fill is the cabinet's 3×3 of Tier-3 lockboxes. Either way the correct bin's
 * confusables are always placed orthogonally adjacent, shuffled each script —
 * a tramadol fill keeps trazodone within a hand's reach of the right bin
 * even though trazodone shelves outside the cabinet (§8, §25).
 */
export function generateBins(state: GameState, correctId: string): string[] {
  const correct = drugDef(correctId);
  const neighbors = confusableNeighbors(correctId);
  const rows = correct.tier === 3 ? CABINET_BIN_ROWS : BIN_ROWS;
  const fillerPool =
    correct.tier === 3
      ? DRUG_DEFS.filter((def) => def.tier === 3)
      : fillableDrugs(state).filter((def) => def.tier !== 3);

  // Cells with enough orthogonal room for every required neighbor.
  const cellCount = rows * BIN_COLS;
  const adjacentOf = (cell: number): number[] => {
    const row = Math.floor(cell / BIN_COLS);
    const col = cell % BIN_COLS;
    const out: number[] = [];
    if (row > 0) out.push(cell - BIN_COLS);
    if (row < rows - 1) out.push(cell + BIN_COLS);
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
  bins[correctCell] = correctId;
  const slots = shuffle(adjacentOf(correctCell));
  neighbors.forEach((id, i) => {
    bins[slots[i]!] = id;
  });

  const used = new Set(bins.filter((id) => id !== ""));
  const filler = shuffle(fillerPool.filter((def) => !used.has(def.id)).map((def) => def.id));
  for (let cell = 0; cell < cellCount; cell++) {
    if (bins[cell] === "") bins[cell] = filler.pop()!;
  }
  return bins;
}

export class RxWorkflow {
  private scripts = new Map<number, RxScript>();
  private fillQueue: number[] = [];
  private verifyQueue: number[] = [];
  /** Player's fill in progress at the bench, or null. */
  private fillingId: number | null = null;
  /** <0 = waiting on a bin pick; ≥0 = igm left on the fill animation. */
  private fillLeft = -1;
  /** Player's verify in progress at the desk, or null. */
  private playerVerifyId: number | null = null;
  private playerVerifyLeft = 0;
  /** True while a verifier is on duty (§8): filled scripts route to the desk
   *  instead of the implicit handoff check. Sim keeps this current. */
  private verifierActive = false;
  private nextScriptId = 1;

  /** Scripts a bench worker could claim right now (§9 task AI). */
  get fillQueueLength(): number {
    return this.fillQueue.length;
  }

  /** Scripts a verifier could claim right now (§9 task AI). */
  get verifyQueueLength(): number {
    return this.verifyQueue.length;
  }

  /** Scripts waiting for (or on) a bench — the fill stage stack. */
  get fillDepth(): number {
    let n = this.fillQueue.length;
    for (const script of this.scripts.values()) if (script.stage === "filling") n++;
    return n;
  }

  /** Scripts waiting for (or under) the verify desk's lamp. */
  get verifyDepth(): number {
    let n = this.verifyQueue.length;
    for (const script of this.scripts.values()) if (script.stage === "verifying") n++;
    return n;
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
  createScript(state: GameState, customerId: number, patientName: string): RxScript {
    const drug = drawScriptDrug(state);
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
    if (!takeShelved(state.store, script.drugId)) {
      this.scripts.delete(script.id);
      return false;
    }
    script.stage = "fillQueue";
    this.fillQueue.push(script.id);
    emit({ type: "rx.dropoff", scriptId: script.id, drugId: script.drugId });
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    this.syncStation(state, emit);
    return true;
  }

  // --- Verifier routing (§8: the desk becomes real in the staffed era) ---

  /**
   * A verifier is "on duty" while the player works a desk or a pharmacist is
   * assigned to one — scripts queue for them even mid-walk. When the duty
   * ends, the pile drains through the owner's implicit handoff check.
   */
  setVerifier(state: GameState, active: boolean, emit: Emit): void {
    if (this.verifierActive === active) return;
    this.verifierActive = active;
    if (!active) this.flushVerifyImplicit(state, emit);
  }

  /** Filled script leaves a bench: to the desk, or the implicit check. */
  private routeFilled(state: GameState, script: RxScript, emit: Emit): void {
    if (this.verifierActive) {
      script.stage = "verifyQueue";
      this.verifyQueue.push(script.id);
      emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
      return;
    }
    this.resolveVerdict(state, script, OWNER_CATCH_RATE, emit);
  }

  /** Verification outcome: a caught error bounces to the fill queue (time
   *  cost, no rep loss); everything else is bagged and ready (§8). */
  private resolveVerdict(
    state: GameState,
    script: RxScript,
    catchRate: number,
    emit: Emit,
  ): void {
    const wrong = script.filledWithDrugId !== script.drugId;
    if (wrong && Math.random() < catchRate) {
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

  /** The desk went dark: the owner glances over the pile at handoff (§8). */
  private flushVerifyImplicit(state: GameState, emit: Emit): void {
    if (this.playerVerifyId !== null) this.releaseVerify(this.playerVerifyId, emit);
    const queued = this.verifyQueue.splice(0);
    for (const id of queued) {
      const script = this.scripts.get(id);
      if (script) this.resolveVerdict(state, script, OWNER_CATCH_RATE, emit);
    }
  }

  // --- Staff claims (§9 task AI): techs fill, pharmacists verify ---

  /** A tech at a bench takes the top script. No card, no bins — their hands
   *  are trusted to the §26 error table instead. */
  claimFill(emit: Emit): RxScript | null {
    const id = this.fillQueue.shift();
    if (id === undefined) return null;
    const script = this.scripts.get(id)!;
    script.stage = "filling";
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    return script;
  }

  /** Tech fill done: roll the §26 mis-pick, then route to verification. */
  finishStaffFill(state: GameState, scriptId: number, errorRate: number, emit: Emit): void {
    const script = this.scripts.get(scriptId);
    if (!script || script.stage !== "filling") return;
    let filledId = script.drugId;
    if (Math.random() < errorRate) {
      const neighbors = confusableNeighbors(script.drugId);
      if (neighbors.length > 0) {
        filledId = neighbors[Math.floor(Math.random() * neighbors.length)]!;
      }
    }
    script.filledWithDrugId = filledId;
    this.routeFilled(state, script, emit);
  }

  /** Interrupted mid-fill (player takeover, firing): back on top of the pile. */
  releaseFill(scriptId: number, emit: Emit): void {
    const script = this.scripts.get(scriptId);
    if (!script || script.stage !== "filling" || this.fillingId === scriptId) return;
    script.filledWithDrugId = null;
    script.stage = "fillQueue";
    this.fillQueue.unshift(scriptId);
    emit({ type: "rx.stageChanged", scriptId, stage: script.stage });
  }

  /** A verifier takes the next filled script under the lamp. */
  claimVerify(emit: Emit): RxScript | null {
    const id = this.verifyQueue.shift();
    if (id === undefined) return null;
    const script = this.scripts.get(id)!;
    script.stage = "verifying";
    emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
    return script;
  }

  /** Verification done at the given catch rate (§26 by accuracy; owner 90%). */
  finishVerify(state: GameState, scriptId: number, catchRate: number, emit: Emit): void {
    const script = this.scripts.get(scriptId);
    if (!script || script.stage !== "verifying") return;
    if (this.playerVerifyId === scriptId) this.playerVerifyId = null;
    this.resolveVerdict(state, script, catchRate, emit);
  }

  /** Interrupted mid-verify: back on top of the desk's pile. */
  releaseVerify(scriptId: number, emit: Emit): void {
    const script = this.scripts.get(scriptId);
    if (this.playerVerifyId === scriptId) this.playerVerifyId = null;
    if (!script || script.stage !== "verifying") return;
    script.stage = "verifyQueue";
    this.verifyQueue.unshift(scriptId);
    emit({ type: "rx.stageChanged", scriptId, stage: script.stage });
  }

  // --- The player's own hands (§8) ---

  /** Reconcile the fill/verify interactions with wherever the player works. */
  syncStation(state: GameState, emit: Emit): void {
    const station = state.store.furniture.find((f) => f.id === state.workingStationId);
    if (station?.defId === "fill_bench" && !state.buildMode) {
      this.takeNext(state, emit);
    } else if (this.fillingId !== null) {
      this.abortFilling(state, emit);
    }
    if (!(station?.defId === "verify_desk" && !state.buildMode) && this.playerVerifyId !== null) {
      this.releaseVerify(this.playerVerifyId, emit);
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

    // Frame the bin fixture nearest the worked bench (§8 camera glide):
    // Tier-3 scripts fill from the controlled cabinet, the rest from a shelf.
    const binDef = drugDef(script.drugId).tier === 3 ? "cabinet_controlled" : "rx_shelf";
    const bench = state.store.furniture.find((f) => f.id === state.workingStationId);
    let shelfId: string | null = null;
    let best = Infinity;
    for (const item of state.store.furniture) {
      if (item.defId !== binDef) continue;
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
      bins: generateBins(state, script.drugId),
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

  /** Advance the player's fill animation and desk work. */
  tick(state: GameState, emit: Emit): void {
    this.tickPlayerFill(state, emit);
    this.tickPlayerVerify(state, emit);
  }

  private tickPlayerFill(state: GameState, emit: Emit): void {
    if (this.fillingId === null || this.fillLeft < 0) return;
    this.fillLeft -= IGM_PER_TICK;
    if (this.fillLeft > 0) return;

    const script = this.scripts.get(this.fillingId)!;
    this.fillingId = null;
    this.fillLeft = -1;
    emit({ type: "rx.fillEnded", scriptId: script.id });
    this.routeFilled(state, script, emit);
  }

  /** The owner at the desk checks scripts by hand: 8 igm each, 90% (§26). */
  private tickPlayerVerify(state: GameState, emit: Emit): void {
    const station = state.store.furniture.find((f) => f.id === state.workingStationId);
    if (station?.defId !== "verify_desk" || state.buildMode) return;
    if (this.playerVerifyId === null) {
      const script = this.claimVerify(emit);
      if (!script) return;
      this.playerVerifyId = script.id;
      this.playerVerifyLeft = VERIFY_IGM;
    }
    this.playerVerifyLeft -= IGM_PER_TICK;
    if (this.playerVerifyLeft > 0) return;
    this.finishVerify(state, this.playerVerifyId!, OWNER_CATCH_RATE, emit);
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
    if (script.stage !== "dropoff") returnShelved(state.store, script.drugId);
    const queued = this.fillQueue.indexOf(scriptId);
    if (queued !== -1) this.fillQueue.splice(queued, 1);
    const verifying = this.verifyQueue.indexOf(scriptId);
    if (verifying !== -1) this.verifyQueue.splice(verifying, 1);
    if (this.fillingId === scriptId) {
      this.fillingId = null;
      this.fillLeft = -1;
      emit({ type: "rx.fillEnded", scriptId });
    }
    if (this.playerVerifyId === scriptId) this.playerVerifyId = null;
    // A staff member holding this script notices it is gone on their next
    // tick — `script()` returns undefined and they drop the task.
    this.scripts.delete(scriptId);
    emit({ type: "rx.cancelled", scriptId });
    this.syncStation(state, emit);
  }
}
