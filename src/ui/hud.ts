// HUD layout root: top bar (day chip, clock tape, cash, stars, speed) plus
// the morning and close phase panels. Reads sim state via snapshot, mutates
// only through sim.dispatch, updates via cached refs on bus events.

import type { EventBus } from "../core/bus";
import { dayProgress, formatClock, seasonForDay } from "../core/clock";
import type { SimEvent } from "../sim/events";
import type { Sim } from "../sim/sim";
import type { DayPhase, GameSpeed } from "../sim/state";
import { Panel } from "./components/Panel";
import { PillButton } from "./components/PillButton";
import { h } from "./dom";

const STAR_GLYPHS = "★★★★★";

function formatCash(cash: number): string {
  return `$${cash.toLocaleString("en-US")}`;
}

export function createHud(root: HTMLElement, sim: Sim, bus: EventBus<SimEvent>): void {
  const state = sim.snapshot;
  let lastRunSpeed: GameSpeed = state.speed === 0 ? 1 : state.speed;

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

  root.append(topbar, morningStage, closeStage);

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

  bus.on("clock.minute", (e) => setClock(e.igm));
  bus.on("day.phaseChanged", (e) => {
    setDay(e.day);
    setPhase(e.phase);
  });
  bus.on("speed.changed", (e) => setSpeed(e.speed));

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
}
