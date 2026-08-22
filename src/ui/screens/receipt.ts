// End-of-day receipt (SPEC §28, the signature element): a strip of perforated
// register paper that *prints* — lines appear top-down with a dot-matrix
// stagger over ~1.2 s, click the sheet to skip, reduced-motion is instant —
// closing with a rubber-stamp PROFIT / LOSS verdict. Every line is a ledger
// reason posted during the day (§10), so the paper always adds up to the till.

import { seasonForDay } from "../../core/clock";
import { REP_REASONS } from "../../sim/customers";
import { groupTotal, LEDGER_REASONS, ledgerNet, operatingProfit } from "../../sim/economy";
import type { Sim } from "../../sim/sim";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";
import { money, signed } from "../format";

const PRINT_MS = 1200;

const GROUP_TITLES: Record<string, string> = {
  revenue: "register",
  cost: "paid out",
  financing: "borrowed",
};

export function buildReceipt(sim: Sim, onNextDay: () => void): HTMLElement {
  const state = sim.snapshot;
  const stats = state.dayStats;
  const profit = operatingProfit(stats);

  const items: HTMLElement[] = [];
  const item = (el: HTMLElement): HTMLElement => {
    el.classList.add("rcpt__item");
    items.push(el);
    return el;
  };
  const line = (left: string, right: string, cls = ""): HTMLElement =>
    item(
      h("div", { cls: `rcpt__line${cls ? ` ${cls}` : ""}` }, [
        h("span", { cls: "rcpt__l", text: left }),
        h("span", { cls: "rcpt__r", text: right }),
      ]),
    );
  const rule = (): HTMLElement => item(h("div", { cls: "rcpt__rule" }));
  const section = (label: string): HTMLElement =>
    item(h("div", { cls: "rcpt__section", text: label }));

  // --- Header ---
  item(h("div", { cls: "rcpt__store", text: "OLD TOWN PHARMACY" }));
  item(h("div", { cls: "rcpt__meta", text: `day ${state.day} · ${seasonForDay(state.day)}` }));
  item(h("div", { cls: "rcpt__meta", text: "20:00 · register closed" }));
  rule();

  // --- The ledger, one section per group, in posting order (§10) ---
  for (const group of ["revenue", "cost", "financing"] as const) {
    const posted = LEDGER_REASONS.filter(
      (reason) => reason.group === group && stats.ledger[reason.id],
    );
    if (posted.length === 0) continue;
    section(GROUP_TITLES[group]!);
    for (const reason of posted) {
      const tally = stats.ledger[reason.id]!;
      line(
        `${reason.label} ×${tally.count}`,
        money(tally.amount),
        tally.amount < 0 ? "rcpt__line--rose" : "",
      );
    }
    line(
      group === "revenue" ? "Taken in" : group === "cost" ? "Paid out" : "Net borrowed",
      money(groupTotal(stats, group)),
      "rcpt__line--total",
    );
    rule();
  }

  line("Operating profit", money(profit), "rcpt__line--total");
  line("Till at open", money(stats.cashOpen));
  line("Till now", money(state.cash), "rcpt__line--total");
  rule();

  // --- The floor ---
  section("the floor");
  line("Visitors", String(stats.visitors));
  line("Scripts filled", String(stats.fills));
  line("Walk-outs", String(stats.walkouts), stats.walkouts > 0 ? "rcpt__line--rose" : "");
  if (stats.errors > 0) line("Dispensing errors", String(stats.errors), "rcpt__line--rose");
  if (stats.refusals > 0) line("Scripts refused", String(stats.refusals), "rcpt__line--rose");

  const stockOuts = Object.values(stats.stockOuts).reduce((sum, n) => sum + n, 0);
  const balks = Object.values(stats.balks).reduce((sum, n) => sum + n, 0);
  if (stockOuts > 0) line("Sales lost to empty shelves", String(stockOuts), "rcpt__line--rose");
  if (balks > 0) line("Put back over price", String(balks), "rcpt__line--rose");
  // Everything asked for that we could hand over — scripts and shelves both.
  const rate = state.store.fillRate7d[0];
  if (rate !== undefined) line("Asked and served", `${Math.round(rate * 100)}%`);
  rule();

  // --- Word of mouth (§15 rep delta with reasons) ---
  section("word of mouth");
  for (const reason of Object.values(REP_REASONS)) {
    const tally = stats.repReasons[reason];
    if (!tally) continue;
    line(
      `${reason} ×${tally.count}`,
      signed(tally.delta, 2),
      tally.delta < 0 ? "rcpt__line--rose" : "",
    );
  }
  line("Reputation", `${signed(stats.repDelta, 2)} → ${state.repStars.toFixed(2)} ★`);
  rule();

  // --- Verdict stamp + footer ---
  const stampKind =
    stats.familyLoan > 0 ? "family" : profit > 0 ? "profit" : "loss";
  const stamp = item(
    h("div", {
      cls: `rcpt__stamp rcpt__stamp--${stampKind}`,
      text: stampKind === "family" ? "FAMILY LOAN" : stampKind === "profit" ? "PROFIT" : "LOSS",
    }),
  );
  if (stats.familyLoan > 0) {
    item(
      h("p", {
        cls: "rcpt__note",
        text: `Aunt Rosa covered the till with ${money(stats.familyLoan)}. She'll take 15% of each day's profit until it's square.`,
      }),
    );
  }
  item(h("div", { cls: "rcpt__meta rcpt__foot", text: "thank you — come again" }));

  const sheet = h(
    "div",
    { cls: "rcpt", attrs: { role: "status", "aria-label": "End of day receipt" } },
    items,
  );
  const nextButton = PillButton("Next day", onNextDay);
  const nextWrap = h("div", { cls: "rcpt__next rcpt__item" }, [nextButton]);
  const root = h("div", { cls: "rcpt-stage" }, [sheet, nextWrap]);

  // The paper is the ledger: if these ever diverge, the ledger is missing a post.
  if (import.meta.env.DEV) {
    const drift = Math.abs(stats.cashOpen + ledgerNet(stats) - state.cash);
    if (drift > 0.005) {
      console.error(
        `[receipt] ledger off by ${drift.toFixed(2)}: open ${stats.cashOpen} + net ${ledgerNet(stats)} ≠ ${state.cash}`,
      );
    }
  }

  // --- Print sequence ---
  const all = [...items, nextWrap];
  const timers: number[] = [];
  const finish = (): void => {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    for (const el of all) el.classList.add("rcpt__item--on");
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
  } else {
    const step = PRINT_MS / all.length;
    all.forEach((el, i) => {
      timers.push(window.setTimeout(() => el.classList.add("rcpt__item--on"), step * (i + 1)));
    });
    sheet.addEventListener("click", finish);
  }
  // The stamp lands with a thunk only once revealed.
  stamp.classList.add("rcpt__stamp--anim");

  return root;
}
