// HUD layout root: top bar (day chip, clock tape, cash, stars, speed), the
// bottom dock (Build), the build palette + move/sell context card, toasts,
// and the morning/close phase panels. Reads sim state via snapshot, mutates
// only through sim.dispatch, updates via cached refs on bus events.

import type { EventBus } from "../core/bus";
import { dayProgress, formatClock, seasonForDay } from "../core/clock";
import { furnitureDef } from "../data/furniture";
import type { SimEvent } from "../sim/events";
import type { Sim } from "../sim/sim";
import type { DayPhase, GameSpeed } from "../sim/state";
import { Panel } from "./components/Panel";
import { PillButton } from "./components/PillButton";
import { createToastHost, type ToastTone } from "./components/Toast";
import { h } from "./dom";
import { createBuildPalette } from "./screens/buildPalette";

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
  const starsChip = h(
    "div",
    { cls: "chip stars", attrs: { "aria-label": `Reputation ${state.repStars} of 5 stars` } },
    [
      h("span", { cls: "stars__glyphs", attrs: { "aria-hidden": "true" } }, [
        h("span", { text: STAR_GLYPHS }),
        starsFill,
      ]),
      h("span", { cls: "stars__num", text: state.repStars.toFixed(1) }),
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

  const closeStage = h("div", { cls: "scrim" }, [
    Panel({ title: "Day complete" }, [
      h("p", {
        cls: "panel__text",
        text: "Doors are locked and the register is counted.",
      }),
      PillButton("Next day", () => sim.dispatch({ type: "day.advance" })),
    ]),
  ]);

  root.append(topbar, palette.root, contextCard, morningStage, closeStage, dock);
  const toast = createToastHost(root);

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
  bus.on("build.changed", (e) => setBuildMode(e.active));
  bus.on("furniture.placed", () => palette.refresh());
  bus.on("furniture.sold", () => palette.refresh());

  // --- Keys: Space pause toggle, 1 / 2 speeds ---

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
  };
}
