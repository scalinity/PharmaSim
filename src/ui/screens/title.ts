// Title screen (SPEC §28: screens are full paper sheets over the scrim; the
// wordmark is Fraunces, era-tinted).
//
// Design note. The card is the shop's own door card — the thing a corner
// pharmacy tapes inside the glass — hung slightly off-square over the store
// itself, which orbits behind the scrim. Everything on it is quiet except one
// element: **Continue is a line out of the daybook**, the run's day, till and
// stars set in Plex Mono with dot leaders, the way the game writes every
// other number. The first screen speaks the game's own data voice instead of
// wearing a hero card with a big button, and the one loud thing on it is the
// player's own progress. Start / Settings stay deliberately small beneath it.

import type { Sim } from "../../sim/sim";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";
import { money } from "../format";

export interface SaveSummary {
  day: number;
  season: string;
  cash: number;
  repStars: number;
}

export interface TitleProps {
  /** Summary of the save Continue would load, or null when there is none. */
  summary: SaveSummary | null;
  onContinue(): void;
  onNewGame(): void;
  onSettings(): void;
}

/** Print sequence: the card lands, then its lines arrive top-down. */
const STEP_MS = 55;

export interface TitleHandle {
  root: HTMLElement;
  focus(): void;
}

export function createTitleScreen(sim: Sim, props: TitleProps): TitleHandle {
  const steps: HTMLElement[] = [];
  const step = <T extends HTMLElement>(el: T): T => {
    el.classList.add("tcard__step");
    el.style.animationDelay = `${(steps.length + 1) * STEP_MS}ms`;
    steps.push(el);
    return el;
  };

  const lines: HTMLElement[] = [
    step(
      h("p", { cls: "tcard__eyebrow" }, [
        h("span", { cls: "tcard__cross", attrs: { "aria-hidden": "true" } }),
        "Old Town · est. 1954",
      ]),
    ),
    step(h("h1", { cls: "tcard__mark", text: "PharmaSim" })),
    step(h("span", { cls: "tcard__rule", attrs: { "aria-hidden": "true" } })),
    // Set as two lines on purpose: the comma is the beat.
    step(
      h("p", { cls: "tcard__tag" }, [
        "A corner drugstore,",
        h("br"),
        "one prescription at a time.",
      ]),
    ),
  ];

  let continueButton: HTMLElement | null = null;

  if (props.summary) {
    const { day, season, cash, repStars } = props.summary;
    const ledger = h("button", { cls: "tcont", attrs: { type: "button" } }, [
      h("span", { cls: "tcont__label", text: "Continue" }),
      h("span", { cls: "tcont__line" }, [
        h("span", { cls: "tcont__k", text: `day ${day} · ${season.toLowerCase()}` }),
        h("span", { cls: "tcont__dots", attrs: { "aria-hidden": "true" } }),
        h("span", { cls: "tcont__v", text: money(cash) }),
        h("span", { cls: "tcont__stars", text: `★ ${repStars.toFixed(1)}` }),
      ]),
    ]);
    ledger.setAttribute(
      "aria-label",
      `Continue day ${day}, ${money(cash)}, ${repStars.toFixed(1)} stars`,
    );
    ledger.addEventListener("click", props.onContinue);
    lines.push(step(ledger));
    continueButton = ledger;
  }

  const newGame = PillButton("Start a new store", props.onNewGame, {
    variant: props.summary ? "secondary" : "primary",
  });
  const settings = h("button", {
    cls: "tlink",
    text: "Settings",
    attrs: { type: "button" },
  });
  settings.addEventListener("click", props.onSettings);
  lines.push(step(h("div", { cls: "tcard__actions" }, [newGame, settings])));
  const primary = continueButton ?? newGame;

  const card = h("div", { cls: "tcard", attrs: { "data-era": String(sim.snapshot.era) } }, [
    h("div", { cls: "tcard__inner" }, lines),
  ]);

  return {
    root: h("div", { cls: "screen screen--title" }, [card]),
    focus: () => primary.focus(),
  };
}
