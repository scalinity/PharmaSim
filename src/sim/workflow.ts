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
import { hasFridge } from "./coldchain";
import { STORE_DISTRICT_ID } from "./economy";
import type { SimEvent } from "./events";
import { binFixtureFor, returnShelved, takeShelved } from "./inventory";
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
/** §6 robotic dispenser: brisker than any pair of hands, and it never
 *  mis-picks — its fills route through verification like everyone else's. */
export const DISPENSER_FILL_IGM = 4;

/** What the machine will touch (§6): Tier 1/2 only, never controlled stock
 *  and never the cold chain — those still go to a bench. */
function autoFillable(drugId: string): boolean {
  const def = drugDef(drugId);
  return def.tier !== 3 && def.refrigerated !== true;
}
export const BIN_ROWS = 4; // shelf bin face (render/meshes/furniture.ts)
export const BIN_COLS = 3;

/** Per-fixture bin-face shape — the one contract the sim's bin generation
 *  and the render layer's label board both read (§8, §25), so the drug
 *  behind a bin and the label drawn on it can never disagree: the shelf's
 *  4×3 spread, the cabinet's 3×3 of Tier-3 lockboxes, and the fridge's 2×2
 *  of cold bins (the refrigerated catalog is exactly four SKUs, so every
 *  one is always in reach). */
export const BIN_FACES: Record<
  ReturnType<typeof binFixtureFor>,
  { rows: number; cols: number }
> = {
  rx_shelf: { rows: BIN_ROWS, cols: BIN_COLS },
  cabinet_controlled: { rows: 3, cols: BIN_COLS },
  fridge_medical: { rows: 2, cols: 2 },
};

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
 *
 * The pool is memoized on license coverage (licenses owned + a cabinet or
 * fridge on the floor), so per-spawn work is one key build instead of
 * re-deriving 49 demand slices — while a mid-shift license purchase still
 * lands on the very next spawn.
 */
let drawPoolKey = "";
let drawPool: DrugDef[] = [];
let drawWeights: number[] = [];
let drawTotal = 0;

function drawScriptDrug(state: GameState): DrugDef {
  const cabinet = state.store.furniture.some((f) => f.defId === "cabinet_controlled");
  const key =
    state.licenses.join(",") + (cabinet ? "|cabinet" : "") + (hasFridge(state) ? "|fridge" : "");
  if (key !== drawPoolKey) {
    const district = districtById(STORE_DISTRICT_ID);
    drawPoolKey = key;
    drawPool = fillableDrugs(state);
    drawWeights = drawPool.map((def) => drugDailyDemand(district, def));
    drawTotal = drawWeights.reduce((sum, w) => sum + w, 0);
  }
  let u = Math.random() * drawTotal;
  for (let i = 0; i < drawPool.length; i++) {
    u -= drawWeights[i]!;
    if (u <= 0) return drawPool[i]!;
  }
  return drawPool[0]!;
}

/** Look-alike ids for a drug: §25 `confusableWith` both ways, padded up to 3
 *  with the bins a hand actually reaches past — same-category shelf
 *  neighbors, or, for a cold-chain drug, the fridge's other pens and vials
 *  (glargine sits a hand's width from lispro). Shelf decoys never advertise
 *  refrigerated SKUs: those live in the fridge, not on the shelf. */
export function confusableNeighbors(correctId: string): string[] {
  const correct = drugDef(correctId);
  const confusables: string[] = [...(correct.confusableWith ?? [])];
  for (const def of DRUG_DEFS) {
    if (def.confusableWith?.includes(correct.id) && !confusables.includes(def.id)) {
      confusables.push(def.id);
    }
  }
  const sameFixture = shuffle(
    DRUG_DEFS.filter(
      (def) =>
        def.id !== correct.id &&
        !confusables.includes(def.id) &&
        (correct.refrigerated
          ? def.refrigerated === true
          : def.category === correct.category && !def.refrigerated),
    ).map((def) => def.id),
  );
  return [...confusables, ...sameFixture].slice(0, 3);
}

/**
 * Bin layout for one fill: drug ids over the fixture's face, row-major. A
 * shelf fill spreads 4×3 across the store's licensed formulary; a controlled
 * fill is the cabinet's 3×3 of Tier-3 lockboxes; a cold fill is the fridge's
 * 2×2 of pens and vials. Either way the correct bin's confusables are always
 * placed orthogonally adjacent, shuffled each script — a tramadol fill keeps
 * trazodone within a hand's reach of the right bin even though trazodone
 * shelves outside the cabinet (§8, §25).
 */
export function generateBins(state: GameState, correctId: string): string[] {
  const fixture = binFixtureFor(correctId);
  const { rows, cols } = BIN_FACES[fixture];
  // Trim the neighbor list to what the face can seat orthogonally beside
  // the correct bin — a 2×2 face has two slots at most, derived from the
  // shape so a resized face keeps its layout satisfiable.
  const maxNeighbors = Math.min(3, Math.min(rows - 1, 2) + Math.min(cols - 1, 2));
  const neighbors = confusableNeighbors(correctId).slice(0, maxNeighbors);
  // Each face draws filler through the same storage lens: the cabinet holds
  // the fillable Tier 3, the fridge the whole cold catalog (§25 — four SKUs,
  // licensed or not, because that is what a fridge physically holds), and the
  // shelf everything fillable below Tier 3 that isn't refrigerated.
  const fillerPool =
    fixture === "fridge_medical"
      ? DRUG_DEFS.filter((def) => def.refrigerated)
      : fillableDrugs(state).filter(
          (def) => !def.refrigerated && (def.tier === 3) === (fixture === "cabinet_controlled"),
        );

  // Cells with enough orthogonal room for every required neighbor.
  const cellCount = rows * cols;
  const adjacentOf = (cell: number): number[] => {
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    const out: number[] = [];
    if (row > 0) out.push(cell - cols);
    if (row < rows - 1) out.push(cell + cols);
    if (col > 0) out.push(cell - 1);
    if (col < cols - 1) out.push(cell + 1);
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
  // The pool can run dry — the cabinet face is exactly as big as Tier 3, so
  // one catalog edit would leave holes. Pad from the rest of the catalog
  // rather than ever put a blank (or a crash) in a bin.
  const reserve = shuffle(
    DRUG_DEFS.filter((def) => !used.has(def.id) && !fillerPool.includes(def)).map(
      (def) => def.id,
    ),
  );
  for (let cell = 0; cell < cellCount; cell++) {
    if (bins[cell] === "") bins[cell] = filler.pop() ?? reserve.pop()!;
  }
  return bins;
}

export class RxWorkflow {
  private scripts = new Map<number, RxScript>();
  private fillQueue: number[] = [];
  private verifyQueue: number[] = [];
  /** The robotic dispenser's own fill lane (§6): Tier-1/2 scripts queue here
   *  while a machine stands; stage-wise they are ordinary "fillQueue", and
   *  idle hands (claimFill/takeNext) fall back to this lane so the machine
   *  adds capacity rather than fencing benches off from Tier-1/2 work. */
  private autoQueue: number[] = [];
  /** In-progress machine fills, keyed by dispenser furniture id. */
  private dispenserTasks = new Map<string, { scriptId: number; left: number }>();
  /** True while a dispenser stands on the floor; kept current by
   *  syncDispenserLanes so lane routing never reads stale furniture. */
  private autoLaneOpen = false;
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

  /** Scripts a bench worker could claim right now (§9 task AI): the
   *  benches' own pile plus the machine's backlog — hands fall back to the
   *  auto lane when their own queue is dry, so one dispenser adds capacity
   *  instead of monopolizing every Tier-1/2 script. */
  get fillQueueLength(): number {
    return this.fillQueue.length + this.autoQueue.length;
  }

  /** Scripts a verifier could claim right now (§9 task AI). */
  get verifyQueueLength(): number {
    return this.verifyQueue.length;
  }

  /** Scripts waiting for (or on) a bench — the fill stage stack. Machine
   *  fills live on the dispenser's own stack, not the benches'. */
  get fillDepth(): number {
    let n = this.fillQueue.length;
    for (const script of this.scripts.values()) {
      if (script.stage === "filling" && !this.isDispenserFill(script.id)) n++;
    }
    return n;
  }

  /** Scripts waiting for (or inside) the robotic dispenser (§6). */
  get autoFillDepth(): number {
    return this.autoQueue.length + this.dispenserTasks.size;
  }

  private isDispenserFill(scriptId: number): boolean {
    for (const task of this.dispenserTasks.values()) {
      if (task.scriptId === scriptId) return true;
    }
    return false;
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

  /** Queue a script for filling in the right lane (§6): the dispenser's, when
   *  one stands and the machine will touch the drug, else the benches'. */
  private enqueueFill(script: RxScript, front: boolean): void {
    script.stage = "fillQueue";
    const queue =
      this.autoLaneOpen && autoFillable(script.drugId) ? this.autoQueue : this.fillQueue;
    if (front) queue.unshift(script.id);
    else queue.push(script.id);
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
    this.enqueueFill(script, false);
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
      this.enqueueFill(script, true);
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

  /** A tech at a bench takes the top script — their own pile first, then
   *  the machine's backlog. No card, no bins — their hands are trusted to
   *  the §26 error table instead. */
  claimFill(emit: Emit): RxScript | null {
    const id = this.fillQueue.shift() ?? this.autoQueue.shift();
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
    this.enqueueFill(script, true);
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

  // --- The robotic dispenser (§6, Gen 4): its own fill lane, no hands ---

  /**
   * Keep the machine's lane consistent with the floor: when a dispenser
   * stands, Tier-1/2 scripts wait in its lane; when the last one goes, the
   * lane drains back onto the benches' pile — bench-only flow, restored.
   * A fill in progress inside a sold machine goes back on top of a queue.
   */
  private syncDispenserLanes(state: GameState, emit: Emit): void {
    this.autoLaneOpen = state.store.furniture.some((f) => f.defId === "dispenser_robotic");
    // A closing lane drains before any held task is released, so the fill a
    // sold machine was mid-way through lands back on *top* of the pile it
    // was already ahead of, not behind its own queue.
    if (!this.autoLaneOpen && this.autoQueue.length > 0) {
      this.fillQueue.unshift(...this.autoQueue);
      this.autoQueue.length = 0;
    }
    for (const [dispenserId, task] of this.dispenserTasks) {
      if (state.store.furniture.some((f) => f.id === dispenserId)) continue;
      this.dispenserTasks.delete(dispenserId);
      const script = this.scripts.get(task.scriptId);
      if (script && script.stage === "filling") {
        script.filledWithDrugId = null;
        this.enqueueFill(script, true);
        emit({ type: "rx.stageChanged", scriptId: script.id, stage: script.stage });
      }
    }
    if (!this.autoLaneOpen) return;
    // A machine just arrived (or was always here): its share of the benches'
    // pile walks over. Order within each lane is preserved.
    let kept = 0;
    for (const id of this.fillQueue) {
      const script = this.scripts.get(id);
      if (script && autoFillable(script.drugId)) this.autoQueue.push(id);
      else this.fillQueue[kept++] = id;
    }
    this.fillQueue.length = kept;
  }

  /** Advance every standing dispenser: claim from the lane, fill, route. */
  private tickDispensers(state: GameState, emit: Emit): void {
    if (!this.autoLaneOpen && this.dispenserTasks.size === 0) return;
    // A script can vanish mid-fill (walk-out): the machine just moves on.
    for (const [dispenserId, task] of this.dispenserTasks) {
      const script = this.scripts.get(task.scriptId);
      if (!script || script.stage !== "filling") this.dispenserTasks.delete(dispenserId);
    }
    for (const item of state.store.furniture) {
      if (item.defId !== "dispenser_robotic") continue;
      const task = this.dispenserTasks.get(item.id);
      if (!task) {
        const id = this.autoQueue.shift();
        if (id === undefined) continue;
        const script = this.scripts.get(id)!;
        script.stage = "filling";
        this.dispenserTasks.set(item.id, { scriptId: id, left: DISPENSER_FILL_IGM });
        emit({ type: "rx.stageChanged", scriptId: id, stage: script.stage });
        continue;
      }
      task.left -= IGM_PER_TICK;
      if (task.left > 0) continue;
      this.dispenserTasks.delete(item.id);
      const script = this.scripts.get(task.scriptId)!;
      // The machine never mis-picks: the right drug, every time (§6). Its
      // fills still pass verification like any other (§8).
      script.filledWithDrugId = script.drugId;
      this.routeFilled(state, script, emit);
    }
  }

  // --- The player's own hands (§8) ---

  /** Reconcile the fill/verify interactions with wherever the player works. */
  syncStation(state: GameState, emit: Emit): void {
    this.syncDispenserLanes(state, emit);
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

  /** Player at the bench takes the top script — the benches' pile first,
   *  then the machine's backlog; the RxCard + bins appear. */
  private takeNext(state: GameState, emit: Emit): void {
    if (this.fillingId !== null) return;
    const id = this.fillQueue.shift() ?? this.autoQueue.shift();
    if (id === undefined) return;
    const script = this.scripts.get(id)!;
    script.stage = "filling";
    this.fillingId = id;
    this.fillLeft = -1;

    // Frame the bin fixture nearest the worked bench (§8 camera glide):
    // the cabinet for Tier 3, the fridge for cold chain, else an Rx shelf.
    const binDef = binFixtureFor(script.drugId);
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
    this.enqueueFill(script, true);
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

  /** Advance the player's fill animation, desk work, and the machines. */
  tick(state: GameState, emit: Emit): void {
    // Presence re-checked each tick, so a loaded save's dispenser is live
    // from the first spawn without waiting on a furniture command.
    this.syncDispenserLanes(state, emit);
    this.tickDispensers(state, emit);
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
    const autoQueued = this.autoQueue.indexOf(scriptId);
    if (autoQueued !== -1) this.autoQueue.splice(autoQueued, 1);
    for (const [dispenserId, task] of this.dispenserTasks) {
      if (task.scriptId === scriptId) this.dispenserTasks.delete(dispenserId);
    }
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
