// HUD layout root: top bar (day chip, clock tape, cash, stars, speed), the
// bottom dock (Build), the build palette + move/sell context card, toasts,
// the RxCard during fills, stage-queue mini-card stacks, and the morning /
// end-of-day (printing receipt) phase screens. Reads sim state via snapshot,
// mutates only through sim.dispatch, updates via cached refs on bus events.

import type { EventBus } from "../core/bus";
import { dayProgress, formatClock, seasonForDay } from "../core/clock";
import { drugDef } from "../data/drugs";
import { furnitureDef } from "../data/furniture";
import type { SimEvent } from "../sim/events";
import type { Sim } from "../sim/sim";
import type { DayPhase, GameSpeed } from "../sim/state";
import { Panel } from "./components/Panel";
import { PillButton } from "./components/PillButton";
import { createRxCard } from "./components/RxCard";
import { createToastHost, type ToastTone } from "./components/Toast";
import { h } from "./dom";
import { createBuildPalette } from "./screens/buildPalette";
import { buildReceipt } from "./screens/receipt";

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
  /** Ghost picked up / put down: highlight the palette row. */
  paletteChanged(defId: string | null): void;
  /** Placed furniture selected for move/sell. */
  selectionChanged(selection: BuildSelectionInfo | null): void;
  /** Late-bound because the picking controller is created after the HUD. */
  bindBuild(controls: BuildControls): void;
  /** Register hover hint (null clears; a worked station overrides it). */
  stationHint(text: string | null): void;
  /** Position/update the amber over-register queue chip (shown at ≥4). */
  updateQueueChip(id: string, screenX: number, screenY: number, count: number): void;
  hideQueueChip(id: string): void;
  /** Position/update a stage-queue mini-card stack (§8) over a station. */
  updateStageStack(key: string, screenX: number, screenY: number, count: number, label: string): void;
  hideStageStack(key: string): void;
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
  const dock = h("div", { cls: "dock" }, [buildPill]);

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

  root.append(topbar, palette.root, contextCard, morningStage, closeStage, stationHintEl, dock);
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
    if (phase !== "shift") {
      hoverHint = null;
      refreshStationHint();
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
  });
  const STATION_HINT_NAMES: Record<string, string> = {
    counter_register: "register",
    counter_service: "counter",
    fill_bench: "fill bench",
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

  bus.on("rx.fillStarted", (e) => {
    rxCard.show(e.patientName, drugDef(e.drugId).name, e.quantity, e.shelfId !== null);
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

  bus.on("dev.stress", (e) => toast(e.mult === 1 ? "Stress spawn off" : `Stress spawn ×${e.mult}`));

  // --- Keys: Space pause toggle, 1 / 2 speeds, N dev stress spawn ---

  window.addEventListener("keydown", (e) => {
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
    paletteChanged: (defId) => palette.setSelected(defId),
    selectionChanged: (next) => setSelection(next),
    bindBuild: (controls) => {
      build = controls;
    },
    stationHint: (text) => {
      hoverHint = text;
      refreshStationHint();
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
  };
}
