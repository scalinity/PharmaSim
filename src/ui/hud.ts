// HUD layout root: top bar (day chip, clock tape, cash, stars, speed), the
// bottom dock (Build), the build palette + move/sell context card, toasts,
// the RxCard during fills, stage-queue mini-card stacks, and the morning /
// end-of-day (printing receipt) phase screens. Reads sim state via snapshot,
// mutates only through sim.dispatch, updates via cached refs on bus events.

import type { EventBus } from "../core/bus";
import { dayProgress, formatClock, seasonForDay } from "../core/clock";
import { drugDef } from "../data/drugs";
import { furnitureDef } from "../data/furniture";
import { otcDef } from "../data/otc";
import { fridgeCapacity, refrigeratedHeld, refrigeratedInbound } from "../sim/coldchain";
import type { SimEvent } from "../sim/events";
import { binFixtureFor, SHELF_SLOT_UNITS, shelvedUnits, stockOf } from "../sim/inventory";
import type { Sim } from "../sim/sim";
import { ROLE_LABELS } from "../sim/staff";
import type { DayPhase, GameSpeed } from "../sim/state";
import { fridgePips } from "./components/Meter";
import { Panel } from "./components/Panel";
import { PillButton } from "./components/PillButton";
import { PriceTag } from "./components/PriceTag";
import { createRxCard } from "./components/RxCard";
import { createToastHost, type ToastTone } from "./components/Toast";
import { h } from "./dom";
import { money } from "./format";
import { createBuildPalette } from "./screens/buildPalette";
import { createLicensesPanel } from "./screens/licensesPanel";
import { createOrdersPanel } from "./screens/ordersPanel";
import { buildReceipt } from "./screens/receipt";
import { createStaffPanel } from "./screens/staffPanel";

const STAR_GLYPHS = "★★★★★";

export interface BuildSelectionInfo {
  id: string;
  defId: string;
}

export interface BuildControls {
  selectDef(defId: string | null): void;
  beginMove(): void;
}

export interface HudHandle {
  toast(message: string, tone?: ToastTone): void;
  /** Coming back from the title: repaint the phase so the end-of-day receipt
   *  prints when the player can actually see it (§23 boot → title → play). */
  enterPlay(): void;
  /** Escape: put away whatever sheet is open. True when it consumed the key,
   *  which is how the shell knows not to pause on top of it. */
  dismiss(): boolean;
  /** Ghost picked up / put down: highlight the palette row. */
  paletteChanged(defId: string | null): void;
  /** Placed furniture selected for move/sell. */
  selectionChanged(selection: BuildSelectionInfo | null): void;
  /** Late-bound because the picking controller is created after the HUD. */
  bindBuild(controls: BuildControls): void;
  /** Register hover hint (null clears; a worked station overrides it). */
  stationHint(text: string | null): void;
  /** OTC shelf under the pointer: its price tags + restock card (§11). */
  shelfHover(shelfId: string | null, clientX: number, clientY: number): void;
  /** Medical fridge under the pointer: the §14 capacity meter card. */
  fridgeHover(fridgeId: string | null, clientX: number, clientY: number): void;
  /** Position/update the "restock" nudge chip over a shelf that needs it. */
  updateStockChip(id: string, screenX: number, screenY: number, units: number, empty: boolean): void;
  hideStockChip(id: string): void;
  /** Position/update the amber over-register queue chip (shown at ≥4). */
  updateQueueChip(id: string, screenX: number, screenY: number, count: number): void;
  hideQueueChip(id: string): void;
  /** Position/update a stage-queue mini-card stack (§8) over a station. */
  updateStageStack(key: string, screenX: number, screenY: number, count: number, label: string): void;
  hideStageStack(key: string): void;
  /** Small role glyph over a staffed station (§27: $ · ℞ · ✓). */
  updateRoleGlyph(id: string, screenX: number, screenY: number, glyph: string): void;
  hideRoleGlyph(id: string): void;
}

function formatCash(cash: number): string {
  return `$${cash.toLocaleString("en-US")}`;
}

export function createHud(root: HTMLElement, sim: Sim, bus: EventBus<SimEvent>): HudHandle {
  const state = sim.snapshot;
  let lastRunSpeed: GameSpeed = state.speed === 0 ? 1 : state.speed;
  let build: BuildControls | null = null;
  let selection: BuildSelectionInfo | null = null;

  // --- Top bar ---

  const dayNum = h("span", { cls: "day__num" });
  const daySeason = h("span", { cls: "day__season" });
  const dayChip = h("div", { cls: "chip chip--day" }, [dayNum, daySeason]);

  const ticks: HTMLElement[] = [];
  for (let hour = 0; hour <= 12; hour++) {
    const tick = h("span", {
      cls: hour % 4 === 0 ? "tape__tick tape__tick--major" : "tape__tick",
      attrs: { "aria-hidden": "true" },
    });
    tick.style.left = `${(hour / 12) * 100}%`;
    ticks.push(tick);
  }
  const tapeFill = h("span", { cls: "tape__fill" });
  const tapeFlag = h("span", { cls: "tape__flag" });
  const tapeMarker = h("span", { cls: "tape__marker" }, [tapeFlag]);
  const tape = h("div", { cls: "chip tape", attrs: { "aria-label": "Shift clock" } }, [
    h("span", { cls: "tape__label", text: "08:00" }),
    h("div", { cls: "tape__track" }, [
      h("span", { cls: "tape__line" }),
      tapeFill,
      ...ticks,
      tapeMarker,
    ]),
    h("span", { cls: "tape__label", text: "20:00" }),
  ]);

  const cashChip = h("div", {
    cls: "chip chip--cash",
    text: formatCash(state.cash),
    attrs: { "aria-label": `Cash ${formatCash(state.cash)}` },
  });

  const starsFill = h("span", { cls: "stars__fill", text: STAR_GLYPHS });
  starsFill.style.width = `${(state.repStars / 5) * 100}%`;
  const starsNum = h("span", { cls: "stars__num", text: state.repStars.toFixed(1) });
  const starsChip = h(
    "div",
    { cls: "chip stars", attrs: { "aria-label": `Reputation ${state.repStars} of 5 stars` } },
    [
      h("span", { cls: "stars__glyphs", attrs: { "aria-hidden": "true" } }, [
        h("span", { text: STAR_GLYPHS }),
        starsFill,
      ]),
      starsNum,
    ],
  );

  const speedButtons = new Map<GameSpeed, HTMLButtonElement>();
  const speedDefs: { speed: GameSpeed; label: string; aria: string }[] = [
    { speed: 0, label: "II", aria: "Pause (Space)" },
    { speed: 1, label: "1×", aria: "Normal speed (1)" },
    { speed: 2, label: "2×", aria: "Double speed (2)" },
  ];
  const speedGroup = h("div", {
    cls: "speed",
    attrs: { role: "group", "aria-label": "Game speed" },
  });
  for (const def of speedDefs) {
    const button = PillButton(
      def.label,
      () => sim.dispatch({ type: "speed.set", speed: def.speed }),
      {
        variant: "secondary",
        cls: def.speed === 0 ? "pill--speed pill--pause" : "pill--speed",
        ariaLabel: def.aria,
      },
    );
    speedButtons.set(def.speed, button);
    speedGroup.append(button);
  }

  const topbar = h("div", { cls: "topbar" }, [dayChip, tape, cashChip, starsChip, speedGroup]);

  // --- Bottom dock ---

  const buildPill = h(
    "button",
    {
      cls: "pill pill--secondary pill--dock",
      attrs: { type: "button", "aria-pressed": "false", "aria-label": "Build (B)" },
    },
    [h("span", { cls: "keycap", attrs: { "aria-hidden": "true" }, text: "B" }), "Build"],
  );
  buildPill.addEventListener("pointerdown", (e) => e.preventDefault());
  buildPill.addEventListener("click", () => {
    sim.dispatch({ type: sim.snapshot.buildMode ? "build.exit" : "build.enter" });
  });

  const ordersPill = h(
    "button",
    {
      cls: "pill pill--secondary pill--dock",
      attrs: { type: "button", "aria-pressed": "false", "aria-label": "Orders (O)" },
    },
    [h("span", { cls: "keycap", attrs: { "aria-hidden": "true" }, text: "O" }), "Orders"],
  );
  ordersPill.addEventListener("pointerdown", (e) => e.preventDefault());
  ordersPill.addEventListener("click", () => toggleOrders());

  const teamPill = h(
    "button",
    {
      cls: "pill pill--secondary pill--dock",
      attrs: { type: "button", "aria-pressed": "false", "aria-label": "Team (T)" },
    },
    [h("span", { cls: "keycap", attrs: { "aria-hidden": "true" }, text: "T" }), "Team"],
  );
  teamPill.addEventListener("pointerdown", (e) => e.preventDefault());
  teamPill.addEventListener("click", () => toggleTeam());

  const licensesPill = h(
    "button",
    {
      cls: "pill pill--secondary pill--dock",
      attrs: { type: "button", "aria-pressed": "false", "aria-label": "Licenses (L)" },
    },
    [h("span", { cls: "keycap", attrs: { "aria-hidden": "true" }, text: "L" }), "Licenses"],
  );
  licensesPill.addEventListener("pointerdown", (e) => e.preventDefault());
  licensesPill.addEventListener("click", () => toggleLicenses());
  const dock = h("div", { cls: "dock" }, [buildPill, ordersPill, teamPill, licensesPill]);

  // --- Build palette + move/sell context card ---

  const palette = createBuildPalette(sim, (defId) => build?.selectDef(defId));

  const contextName = h("span", { cls: "context__name" });
  const moveButton = PillButton("Move", () => build?.beginMove(), { cls: "pill--small" });
  const sellButton = PillButton("Sell", () => {
    if (!selection) return;
    const def = furnitureDef(selection.defId);
    const refund = Math.round(def.cost / 2);
    sim.dispatch({ type: "furniture.sell", id: selection.id });
    toast(`Sold the ${def.name.toLowerCase()} — $${refund.toLocaleString("en-US")} refunded`);
  }, { variant: "secondary", cls: "pill--small" });
  const contextCard = Panel({ cls: "context" }, [
    contextName,
    h("div", { cls: "context__actions" }, [moveButton, sellButton]),
  ]);
  contextCard.hidden = true;

  // --- Phase panels ---

  const morningStage = h("div", { cls: "stage-morning" }, [
    Panel({ title: "Morning" }, [
      h("p", {
        cls: "panel__text",
        text: "Shelves are stocked and the till is counted. Open when you're ready.",
      }),
      PillButton("Open store", () => sim.dispatch({ type: "store.open" })),
    ]),
  ]);

  // End-of-day: the printing receipt (§28 signature), rebuilt each close.
  const closeStage = h("div", { cls: "scrim scrim--receipt" });

  // --- Station hint chip (§28 minor UI) + queue chips over registers ---

  const stationHintEl = h("div", { cls: "stationhint" });
  stationHintEl.hidden = true;
  let hoverHint: string | null = null;
  let workingHint: string | null = null;

  function refreshStationHint(): void {
    const text = workingHint ?? hoverHint;
    stationHintEl.hidden = text === null;
    if (text !== null) stationHintEl.textContent = text;
  }

  const queueChips = new Map<string, { el: HTMLElement; count: number }>();
  const stageStacks = new Map<string, { el: HTMLElement; count: number; label: string }>();
  const stockChips = new Map<string, { el: HTMLElement; label: string }>();
  const roleGlyphs = new Map<string, { el: HTMLElement; glyph: string }>();

  // --- Orders panel + the shelf's own price-tag card (§11) ---

  const orders = createOrdersPanel(sim, bus);
  let ordersOpen = false;
  const team = createStaffPanel(sim, bus);
  let teamOpen = false;
  const licenses = createLicensesPanel(sim, bus);
  let licensesOpen = false;

  function setOrders(open: boolean): void {
    const allowed = sim.snapshot.phase !== "close" && !sim.snapshot.buildMode;
    ordersOpen = open && allowed;
    orders.setVisible(ordersOpen);
    ordersPill.classList.toggle("pill--primary", ordersOpen);
    ordersPill.classList.toggle("pill--secondary", !ordersOpen);
    ordersPill.setAttribute("aria-pressed", String(ordersOpen));
    if (ordersOpen) {
      setTeam(false);
      setLicenses(false);
    }
  }

  function toggleOrders(): void {
    setOrders(!ordersOpen);
  }

  function setTeam(open: boolean): void {
    const allowed = sim.snapshot.phase !== "close" && !sim.snapshot.buildMode;
    teamOpen = open && allowed;
    team.setVisible(teamOpen);
    teamPill.classList.toggle("pill--primary", teamOpen);
    teamPill.classList.toggle("pill--secondary", !teamOpen);
    teamPill.setAttribute("aria-pressed", String(teamOpen));
    if (teamOpen) {
      setOrders(false);
      setLicenses(false);
    }
  }

  function toggleTeam(): void {
    setTeam(!teamOpen);
  }

  function setLicenses(open: boolean): void {
    const allowed = sim.snapshot.phase !== "close" && !sim.snapshot.buildMode;
    licensesOpen = open && allowed;
    licenses.setVisible(licensesOpen);
    licensesPill.classList.toggle("pill--primary", licensesOpen);
    licensesPill.classList.toggle("pill--secondary", !licensesOpen);
    licensesPill.setAttribute("aria-pressed", String(licensesOpen));
    if (licensesOpen) {
      setOrders(false);
      setTeam(false);
    }
  }

  function toggleLicenses(): void {
    setLicenses(!licensesOpen);
  }

  const shelfCard = h("div", { cls: "shelfcard" });
  shelfCard.hidden = true;
  let shelfCardId: string | null = null;

  function buildShelfCard(shelfId: string): void {
    const state = sim.snapshot;
    const slots = state.store.shelfSlots[shelfId] ?? [];
    const rows: HTMLElement[] = [];
    let waiting = 0;
    for (const skuId of slots) {
      const def = otcDef(skuId);
      const stock = stockOf(state.store, skuId);
      waiting += stock.backroom;
      rows.push(
        h("div", { cls: "shelfcard__row" }, [
          h("span", { cls: "shelfcard__name" }, [
            h("span", { text: def.name }),
            h("span", {
              cls: `shelfcard__units${stock.shelved === 0 ? " shelfcard__units--out" : ""}`,
              text:
                stock.shelved === 0
                  ? "empty label"
                  : `${stock.shelved}/${SHELF_SLOT_UNITS} out${stock.backroom > 0 ? ` \u00b7 ${stock.backroom} back` : ""}`,
            }),
          ]),
          PriceTag({
            msrp: def.msrp,
            multiplier: state.store.otcPricing[skuId] ?? 1,
            name: def.name,
            onChange: (multiplier) => sim.dispatch({ type: "otc.setPrice", skuId, multiplier }),
          }).root,
        ]),
      );
    }
    if (rows.length === 0) {
      rows.push(
        h("p", {
          cls: "shelfcard__empty",
          text: "No labels yet. Order front-store stock and click the shelf to lay it out.",
        }),
      );
    }
    const units = sim.restockableUnits(shelfId);
    shelfCard.replaceChildren(
      h("p", { cls: "shelfcard__eyebrow", text: "Shelf labels" }),
      ...rows,
      h("p", {
        cls: "shelfcard__hint",
        text:
          units > 0
            ? `Click the shelf to bring out ${units} ${units === 1 ? "unit" : "units"}`
            : waiting > 0
              ? `Labels are full \u2014 ${waiting} more in the backroom`
              : "Nothing in the backroom for this shelf",
      }),
    );
  }

  function setShelfCard(shelfId: string | null, clientX: number, clientY: number): void {
    if (shelfId === null) {
      shelfCardId = null;
      shelfCard.hidden = true;
      return;
    }
    if (shelfId !== shelfCardId) {
      shelfCardId = shelfId;
      buildShelfCard(shelfId);
    }
    shelfCard.hidden = false;
    // Follow the pointer, kept clear of the right and bottom edges.
    const x = Math.min(clientX + 18, window.innerWidth - shelfCard.offsetWidth - 12);
    const y = Math.min(clientY + 14, window.innerHeight - shelfCard.offsetHeight - 12);
    shelfCard.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }

  // --- The fridge's own card: the §14 blister-pip capacity meter ---

  const fridgeCard = h("div", { cls: "shelfcard" });
  fridgeCard.hidden = true;
  let fridgeCardId: string | null = null;

  function buildFridgeCard(): void {
    const state = sim.snapshot;
    const capacity = fridgeCapacity(state);
    const held = refrigeratedHeld(state.store);
    const inbound = refrigeratedInbound(state.store);
    const boxes = fridgeCardId === null ? 0 : sim.restockableUnits(fridgeCardId);
    // Over-capacity is a legal transient after selling a fridge (§14: no
    // spoilage, ordering blocked) — the count says so instead of lying flat.
    const over = held + inbound - capacity;
    const lines = [
      h("p", { cls: "shelfcard__eyebrow", text: "Medical fridge" }),
      fridgePips(Math.min(held + inbound, capacity), capacity),
      h("p", {
        cls: "shelfcard__cold",
        text:
          over > 0
            ? `${held} of ${capacity} cold units — ${over} over capacity`
            : `${held} of ${capacity} cold units` +
              (inbound > 0 ? ` · ${inbound} arriving at dawn` : ""),
      }),
      h("p", {
        cls: "shelfcard__hint",
        text:
          boxes > 0
            ? `Click to load ${boxes} ${boxes === 1 ? "unit" : "units"} into the fridge`
            : held > 0
              ? "Everything cold is in its bin"
              : "Empty — refrigerated stock is ordered like any other, in Orders",
      }),
    ];
    fridgeCard.replaceChildren(...lines);
  }

  function setFridgeCard(fridgeId: string | null, clientX: number, clientY: number): void {
    if (fridgeId === null) {
      fridgeCardId = null;
      fridgeCard.hidden = true;
      return;
    }
    if (fridgeId !== fridgeCardId) {
      fridgeCardId = fridgeId;
      buildFridgeCard();
    }
    fridgeCard.hidden = false;
    const x = Math.min(clientX + 18, window.innerWidth - fridgeCard.offsetWidth - 12);
    const y = Math.min(clientY + 14, window.innerHeight - fridgeCard.offsetHeight - 12);
    fridgeCard.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }

  root.append(
    topbar,
    palette.root,
    orders.root,
    team.root,
    licenses.root,
    contextCard,
    morningStage,
    closeStage,
    stationHintEl,
    shelfCard,
    fridgeCard,
    dock,
  );
  const toast = createToastHost(root);
  const rxCard = createRxCard(root);

  // --- Updates (cached refs only) ---

  function setClock(igm: number): void {
    const pct = dayProgress(igm) * 100;
    tapeMarker.style.left = `${pct}%`;
    tapeFill.style.width = `${pct}%`;
    tapeFlag.textContent = formatClock(igm);
  }

  function setDay(day: number): void {
    dayNum.textContent = `Day ${day}`;
    daySeason.textContent = `· ${seasonForDay(day)}`;
  }

  function setPhase(phase: DayPhase): void {
    morningStage.hidden = phase !== "morning";
    closeStage.hidden = phase !== "close";
    closeStage.replaceChildren();
    if (phase === "close") {
      closeStage.append(buildReceipt(sim, () => sim.dispatch({ type: "day.advance" })));
    }
    if (phase === "close") {
      setOrders(false);
      setTeam(false);
      setLicenses(false);
    }
    if (phase !== "shift") {
      hoverHint = null;
      refreshStationHint();
      setShelfCard(null, 0, 0);
      setFridgeCard(null, 0, 0);
      rxCard.hide();
      for (const [id, chip] of queueChips) {
        chip.el.remove();
        queueChips.delete(id);
      }
      for (const [key, stack] of stageStacks) {
        stack.el.remove();
        stageStacks.delete(key);
      }
    }
    if (phase === "close") clearStockChips();
  }

  function clearStockChips(): void {
    for (const [id, chip] of stockChips) {
      chip.el.remove();
      stockChips.delete(id);
    }
  }

  function setStars(stars: number): void {
    starsFill.style.width = `${(stars / 5) * 100}%`;
    starsNum.textContent = stars.toFixed(1);
    starsChip.setAttribute("aria-label", `Reputation ${stars.toFixed(1)} of 5 stars`);
  }

  function setSpeed(speed: GameSpeed): void {
    for (const [value, button] of speedButtons) {
      const active = value === speed;
      button.classList.toggle("pill--primary", active);
      button.classList.toggle("pill--secondary", !active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (speed !== 0) lastRunSpeed = speed;
  }

  function setCash(cash: number): void {
    cashChip.textContent = formatCash(cash);
    cashChip.setAttribute("aria-label", `Cash ${formatCash(cash)}`);
  }

  function setBuildMode(active: boolean): void {
    buildPill.classList.toggle("pill--primary", active);
    buildPill.classList.toggle("pill--secondary", !active);
    buildPill.setAttribute("aria-pressed", String(active));
    palette.setVisible(active);
    if (!active) contextCard.hidden = true;
    // One sheet on the counter at a time.
    if (active) {
      setOrders(false);
      setTeam(false);
      setLicenses(false);
      setShelfCard(null, 0, 0);
      setFridgeCard(null, 0, 0);
      clearStockChips();
    }
  }

  function setSelection(next: BuildSelectionInfo | null): void {
    selection = next;
    if (!next) {
      contextCard.hidden = true;
      return;
    }
    const def = furnitureDef(next.defId);
    contextName.textContent = def.name;
    sellButton.textContent = `Sell for $${Math.round(def.cost / 2).toLocaleString("en-US")}`;
    contextCard.hidden = false;
  }

  bus.on("clock.minute", (e) => setClock(e.igm));
  bus.on("day.phaseChanged", (e) => {
    setDay(e.day);
    setPhase(e.phase);
  });
  bus.on("speed.changed", (e) => setSpeed(e.speed));
  bus.on("cash.changed", (e) => {
    setCash(e.cash);
    palette.refresh();
  });
  bus.on("rep.changed", (e) => setStars(e.stars));
  bus.on("build.changed", (e) => setBuildMode(e.active));
  bus.on("furniture.placed", () => palette.refresh());
  bus.on("furniture.sold", (e) => {
    palette.refresh();
    const chip = queueChips.get(e.id);
    if (chip) {
      chip.el.remove();
      queueChips.delete(e.id);
    }
    const stockChip = stockChips.get(e.id);
    if (stockChip) {
      stockChip.el.remove();
      stockChips.delete(e.id);
    }
    if (shelfCardId === e.id) setShelfCard(null, 0, 0);
    if (fridgeCardId === e.id) setFridgeCard(null, 0, 0);
  });
  const STATION_HINT_NAMES: Record<string, string> = {
    counter_register: "register",
    counter_service: "counter",
    fill_bench: "fill bench",
    verify_desk: "verify desk",
    vaccine_station: "vaccine station",
  };
  bus.on("station.changed", (e) => {
    const item = e.stationId
      ? sim.snapshot.store.furniture.find((f) => f.id === e.stationId)
      : undefined;
    const name = item ? (STATION_HINT_NAMES[item.defId] ?? "station") : null;
    workingHint = name ? `Working the ${name} — click anywhere else to step away` : null;
    refreshStationHint();
  });

  // --- Prescription workflow (§8): the RxCard + workflow toasts ---

  /** What the stuck-state copy calls a fill's missing bin fixture (§25). */
  const MISSING_FIXTURE_NAMES = {
    rx_shelf: "Rx shelf",
    cabinet_controlled: "controlled cabinet",
    fridge_medical: "medical fridge",
  } as const;

  bus.on("rx.fillStarted", (e) => {
    // A Tier-3 script fills from the cabinet, a cold one from the fridge
    // (§25); the stuck-state copy must name the fixture actually missing.
    const missing = e.shelfId !== null ? null : MISSING_FIXTURE_NAMES[binFixtureFor(e.drugId)];
    rxCard.show(e.patientName, drugDef(e.drugId).name, e.quantity, missing);
  });
  bus.on("rx.binPicked", () => rxCard.setFilling());
  bus.on("rx.fillEnded", () => rxCard.hide());
  bus.on("rx.caught", () => toast("Caught at verification — refilled"));
  bus.on("rx.errorDispensed", (e) => {
    toast(`Dispensing error caught — $${e.refund} refunded`, "error");
  });
  bus.on("rx.refused", (e) => {
    toast(`${drugDef(e.drugId).name} is out of stock — script refused`, "error");
  });

  // --- Inventory + economy (§10, §11) ---

  bus.on("order.submitted", (e) => {
    toast(`Order placed — ${e.units} units, ${money(e.total)}. The van comes at dawn.`);
    setOrders(false);
  });
  bus.on("order.delivered", (e) => {
    toast(`Delivery unloaded — ${e.units} units across ${e.skus} lines, in the backroom`);
  });
  bus.on("stock.restocked", (e) => {
    if (shelfCardId === e.furnitureId) buildShelfCard(e.furnitureId);
    if (fridgeCardId === e.furnitureId) buildFridgeCard();
    const units = `${e.units} ${e.units === 1 ? "unit" : "units"}`;
    toast(e.by ? `${e.by} brought out ${units}` : `Brought out ${units}`);
  });
  bus.on("reorder.unlocked", () => {
    toast("An empty shelf cost you a sale. Orders now takes min/target levels.", "error");
  });

  // --- Vaccination service (§14) ---

  bus.on("vaccine.given", (e) => {
    toast(`Flu shot given — ${money(e.total)} reimbursed`);
    if (fridgeCardId !== null) buildFridgeCard();
  });
  bus.on("vaccine.noDose", () => {
    toast("Out of vaccine doses — a walk-in left", "error");
  });

  // --- Licenses + expansion (§6, §12) ---

  /** What just opened up — the same words the panel and Orders use (§28). */
  const LICENSE_TOASTS: Record<string, string> = {
    L2: "Expanded Formulary licensed — Tier-2 SKUs open in Orders",
    L3: "Controlled Substances licensed — the cabinet is in the Build palette",
    L4: "Immunization Certification licensed — the station arrives with its equipment",
    L5: "Multi-Branch Operation licensed",
    L6: "Distribution Operations licensed",
  };

  bus.on("license.bought", (e) => {
    toast(LICENSE_TOASTS[e.id] ?? `${e.name} licensed`);
    palette.refresh(); // an L3 wall unlocks the cabinet row
  });
  bus.on("expansion.bought", (e) => {
    toast(`Walls moved — the floor is now ${e.cols}×${e.rows}`);
    palette.refresh();
  });

  // --- Staff (§9) ---

  bus.on("staff.hired", (e) => {
    toast(
      `${e.member.name} joins as ${ROLE_LABELS[e.member.role]} — ${money(e.member.dailyWage)} a day`,
    );
  });
  bus.on("staff.fired", (e) => toast(`${e.name} let go — wages stop tomorrow`));
  bus.on("staff.poolRefreshed", () => {
    if (sim.snapshot.day > 1) toast("Monday — fresh applications on the counter");
  });

  bus.on("dev.stress", (e) => toast(e.mult === 1 ? "Stress spawn off" : `Stress spawn ×${e.mult}`));

  // --- Keys: Space pause toggle, 1 / 2 speeds, N dev stress spawn ---

  window.addEventListener("keydown", (e) => {
    // A focused form control owns the keyboard: order-form digits are
    // quantities, select type-ahead isn't a panel toggle, Space belongs
    // to the control.
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.code === "Space") {
      if (e.target instanceof HTMLElement) {
        const button = e.target.closest("button");
        // Non-speed buttons (Open store, Next day) keep native Space activation;
        // Space over a speed pill still means pause.
        if (button && !button.classList.contains("pill--speed")) return;
      }
      e.preventDefault();
      const current = sim.snapshot.speed;
      sim.dispatch({ type: "speed.set", speed: current === 0 ? lastRunSpeed : 0 });
    } else if (e.key === "1") {
      sim.dispatch({ type: "speed.set", speed: 1 });
    } else if (e.key === "2") {
      sim.dispatch({ type: "speed.set", speed: 2 });
    } else if (e.code === "KeyO" && !e.repeat) {
      toggleOrders();
    } else if (e.code === "KeyT" && !e.repeat) {
      toggleTeam();
    } else if (e.code === "KeyL" && !e.repeat) {
      toggleLicenses();
    } else if (e.code === "KeyN" && !e.repeat) {
      sim.dispatch({ type: "dev.stressToggle" });
    }
  });

  // --- Initial paint ---

  setDay(state.day);
  setPhase(state.phase);
  setClock(state.clockIgm);
  setSpeed(state.speed);
  setCash(state.cash);
  setBuildMode(state.buildMode);

  return {
    toast,
    enterPlay: () => {
      setPhase(sim.snapshot.phase);
    },
    dismiss: () => {
      if (ordersOpen) {
        setOrders(false);
        return true;
      }
      if (teamOpen) {
        setTeam(false);
        return true;
      }
      if (licensesOpen) {
        setLicenses(false);
        return true;
      }
      // Build mode owns Escape for its ghost, selection and its own exit
      // (render/picking.ts) — it consumes the key.
      return sim.snapshot.buildMode;
    },
    paletteChanged: (defId) => palette.setSelected(defId),
    selectionChanged: (next) => setSelection(next),
    bindBuild: (controls) => {
      build = controls;
    },
    stationHint: (text) => {
      hoverHint = text;
      refreshStationHint();
    },
    shelfHover: (shelfId, clientX, clientY) => setShelfCard(shelfId, clientX, clientY),
    fridgeHover: (fridgeId, clientX, clientY) => setFridgeCard(fridgeId, clientX, clientY),
    updateStockChip: (id, screenX, screenY, units, empty) => {
      const label = empty && units === 0 ? "empty" : `restock ${units}`;
      let chip = stockChips.get(id);
      if (!chip) {
        chip = { el: h("div", { cls: "schip" }), label: "" };
        root.append(chip.el);
        stockChips.set(id, chip);
      }
      if (chip.label !== label) {
        chip.label = label;
        chip.el.textContent = label;
        chip.el.classList.toggle("schip--out", label === "empty");
      }
      chip.el.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) translate(-50%, -100%)`;
    },
    hideStockChip: (id) => {
      const chip = stockChips.get(id);
      if (chip) {
        chip.el.remove();
        stockChips.delete(id);
      }
    },
    updateQueueChip: (id, screenX, screenY, count) => {
      let chip = queueChips.get(id);
      if (!chip) {
        chip = { el: h("div", { cls: "qchip" }), count: -1 };
        root.append(chip.el);
        queueChips.set(id, chip);
      }
      if (chip.count !== count) {
        chip.count = count;
        chip.el.textContent = `${count} waiting`;
      }
      chip.el.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) translate(-50%, -100%)`;
    },
    hideQueueChip: (id) => {
      const chip = queueChips.get(id);
      if (chip) {
        chip.el.remove();
        queueChips.delete(id);
      }
    },
    updateStageStack: (key, screenX, screenY, count, label) => {
      let stack = stageStacks.get(key);
      if (!stack) {
        stack = { el: h("div", { cls: "stagestack" }), count: -1, label: "" };
        root.append(stack.el);
        stageStacks.set(key, stack);
      }
      if (stack.count !== count || stack.label !== label) {
        stack.count = count;
        stack.label = label;
        const cards = h("div", { cls: "stagestack__cards", attrs: { "aria-hidden": "true" } });
        for (let i = Math.min(count, 4) - 1; i >= 1; i--) {
          const ghost = h("span", { cls: "stagestack__card" });
          ghost.style.transform = `translate(${i * 3}px, ${-i * 3}px) rotate(${i * 1.6}deg)`;
          cards.append(ghost);
        }
        const top = h("span", { cls: "stagestack__card stagestack__card--top", text: String(count) });
        cards.append(top);
        stack.el.replaceChildren(cards, h("span", { cls: "stagestack__label", text: label }));
      }
      stack.el.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) translate(-50%, -100%)`;
    },
    hideStageStack: (key) => {
      const stack = stageStacks.get(key);
      if (stack) {
        stack.el.remove();
        stageStacks.delete(key);
      }
    },
    updateRoleGlyph: (id, screenX, screenY, glyph) => {
      let chip = roleGlyphs.get(id);
      if (!chip) {
        chip = { el: h("div", { cls: "rglyph" }), glyph: "" };
        root.append(chip.el);
        roleGlyphs.set(id, chip);
      }
      if (chip.glyph !== glyph) {
        chip.glyph = glyph;
        chip.el.textContent = glyph;
      }
      chip.el.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) translate(-50%, -100%)`;
    },
    hideRoleGlyph: (id) => {
      const chip = roleGlyphs.get(id);
      if (chip) {
        chip.el.remove();
        roleGlyphs.delete(id);
      }
    },
  };
}
