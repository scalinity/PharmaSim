// End-of-day receipt (SPEC §28, the signature element): a strip of perforated
// register paper that *prints* — lines appear top-down with a dot-matrix
// stagger over ~1.2 s, click the sheet to skip, reduced-motion is instant —
// closing with a rubber-stamp PROFIT / LOSS verdict.

import { seasonForDay } from "../../core/clock";
import { REP_REASONS } from "../../sim/customers";
import type { Sim } from "../../sim/sim";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";

const PRINT_MS = 1200;

function money(n: number): string {
  const sign = n < 0 ? "\u2212" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function signed(n: number, digits: number): string {
  return `${n < 0 ? "\u2212" : "+"}${Math.abs(n).toFixed(digits)}`;
}

export function buildReceipt(sim: Sim, onNextDay: () => void): HTMLElement {
  const state = sim.snapshot;
  const stats = state.dayStats;
  const net =
    stats.rxReimbursement + stats.copayRevenue + stats.otcRevenue - stats.refunds;

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

  // --- Register (§10 revenue lines) ---
  section("register");
  line(`Rx reimbursements ×${stats.fills}`, money(stats.rxReimbursement));
  line(`Copays ×${stats.fills}`, money(stats.copayRevenue));
  line(`OTC sales ×${stats.otcSales}`, money(stats.otcRevenue));
  if (stats.refunds > 0) line(`Refunds ×${stats.errors}`, money(-stats.refunds), "rcpt__line--rose");
  line("Total", money(net), "rcpt__line--total");
  rule();

  // --- The floor ---
  section("the floor");
  line("Visitors", String(stats.visitors));
  line("Scripts filled", String(stats.fills));
  line("Walk-outs", String(stats.walkouts), stats.walkouts > 0 ? "rcpt__line--rose" : "");
  if (stats.errors > 0) line("Dispensing errors", String(stats.errors), "rcpt__line--rose");
  if (stats.refusals > 0) line("Scripts refused", String(stats.refusals), "rcpt__line--rose");
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
  const stamp = item(
    h("div", {
      cls: `rcpt__stamp ${net > 0 ? "rcpt__stamp--profit" : "rcpt__stamp--loss"}`,
      text: net > 0 ? "PROFIT" : "LOSS",
    }),
  );
  item(h("div", { cls: "rcpt__meta rcpt__foot", text: "thank you — come again" }));

  const sheet = h(
    "div",
    { cls: "rcpt", attrs: { role: "status", "aria-label": "End of day receipt" } },
    items,
  );
  const nextButton = PillButton("Next day", onNextDay);
  const nextWrap = h("div", { cls: "rcpt__next rcpt__item" }, [nextButton]);
  const root = h("div", { cls: "rcpt-stage" }, [sheet, nextWrap]);

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
