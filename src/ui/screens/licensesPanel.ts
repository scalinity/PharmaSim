// Licenses panel (SPEC §12, §28): the office wall itself — the one screen
// whose ground is walnut wainscot rather than paper, because certificates
// need something to hang on. Each license is one of two paper artifacts: an
// owned license is an engraved certificate in a walnut frame with the board's
// seal and an amber ISSUED stamp (the receipt's rubber-stamp voice); a locked
// one is still a State Board application form, dashed and pinned, whose
// checklist is the exact set of requirements between here and the frame.

import type { EventBus } from "../../core/bus";
import type { SimEvent } from "../../sim/events";
import { licenseGates, ownsLicense, LICENSE_DEFS, type LicenseDef } from "../../sim/licenses";
import type { Sim } from "../../sim/sim";
import { h } from "../dom";
import { money } from "../format";

export interface LicensesPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

interface Card {
  def: LicenseDef;
  root: HTMLElement;
  owned: boolean;
  /** Gate line refs, form cards only — updated in place so live values
   *  (stars, till) tick without rebuilding the card under the pointer. */
  gates: { line: HTMLElement; glyph: HTMLElement; text: HTMLElement }[];
  buyButton: HTMLButtonElement | null;
}

export function createLicensesPanel(sim: Sim, bus: EventBus<SimEvent>): LicensesPanelHandle {
  const cards = new Map<string, Card>();
  let visible = false;
  let pending = false;

  const grid = h("div", { cls: "lic__grid" });

  const wall = h("div", { cls: "lic__wall" }, [
    h("div", { cls: "lic__head" }, [
      h("span", { cls: "lic__plaque", text: "Licenses" }),
      h("p", { cls: "lic__eyebrow", text: "State Board of Pharmacy · the office wall" }),
    ]),
    grid,
  ]);

  const root = h("section", { cls: "lic", attrs: { "aria-label": "Licenses" } }, [wall]);
  root.hidden = true;

  /** The framed certificate: what hangs once a license is owned. */
  function buildCertificate(card: Card): void {
    const def = card.def;
    const issuedDay = sim.snapshot.stats[`license.${def.id}`];
    const children = [
      h("p", { cls: "cert__eyebrow", text: "State Board of Pharmacy" }),
      h("h3", { cls: "cert__name", text: def.name }),
      h("p", { cls: "cert__grant", text: `${def.unlocks}.` }),
    ];
    if (def.note) children.push(h("p", { cls: "cert__note", text: def.note }));
    children.push(
      h("div", { cls: "cert__foot" }, [
        h("span", { cls: "cert__seal", attrs: { "aria-hidden": "true" }, text: "℞" }),
        h("span", {
          cls: "cert__stamp",
          text: issuedDay === undefined ? "Issued" : `Issued · day ${issuedDay}`,
        }),
      ]),
    );
    card.root.className = "cert cert--owned";
    card.root.replaceChildren(h("div", { cls: "cert__paper" }, children));
    card.owned = true;
    card.gates = [];
    card.buyButton = null;
  }

  /** The application form: the same wall spot while requirements are open. */
  function buildForm(card: Card): void {
    const def = card.def;
    const children = [
      h("p", { cls: "cert__eyebrow", text: `Application · form PB-${def.id.slice(1)}` }),
      h("h3", { cls: "cert__name", text: def.name }),
      h("p", { cls: "cert__grant", text: `${def.unlocks}.` }),
    ];
    if (def.note) children.push(h("p", { cls: "cert__note", text: def.note }));

    card.gates = [];
    const gates = licenseGates(sim.snapshot, def);
    const gateList = h("div", { cls: "cert__gates" });
    for (const gate of gates) {
      const glyph = h("span", {
        cls: "cert__glyph",
        attrs: { "aria-hidden": "true" },
        text: gate.met ? "✓" : "◻",
      });
      const text = h("span", { text: gate.text });
      const line = h("p", { cls: gate.met ? "cert__gate cert__gate--met" : "cert__gate" }, [
        glyph,
        text,
      ]);
      gateList.append(line);
      card.gates.push({ line, glyph, text });
    }
    children.push(gateList);

    const buy = h("button", {
      cls: "pill pill--primary pill--small cert__buy",
      text: `Buy for ${money(def.cost)}`,
      attrs: { type: "button" },
    });
    buy.disabled = !gates.every((gate) => gate.met);
    buy.addEventListener("pointerdown", (e) => e.preventDefault());
    buy.addEventListener("click", () => sim.dispatch({ type: "license.buy", id: def.id }));
    card.buyButton = buy;
    children.push(buy);

    card.root.className = "cert cert--form";
    card.root.replaceChildren(h("div", { cls: "cert__paper" }, children));
    card.owned = false;
  }

  for (const def of LICENSE_DEFS) {
    const card: Card = {
      def,
      root: h("article", { cls: "cert" }),
      owned: false,
      gates: [],
      buyButton: null,
    };
    cards.set(def.id, card);
    grid.append(card.root);
  }

  function refreshCard(card: Card): void {
    const state = sim.snapshot;
    const owned = ownsLicense(state, card.def.id);
    if (owned !== card.owned || card.root.childElementCount === 0) {
      if (owned) buildCertificate(card);
      else buildForm(card);
      return;
    }
    if (owned) return;
    const gates = licenseGates(state, card.def);
    // The pairing below is by index; if a def ever grows a conditional gate,
    // re-laying the form beats mispairing glyphs against labels.
    if (gates.length !== card.gates.length) {
      buildForm(card);
      return;
    }
    card.gates.forEach((ref, i) => {
      const gate = gates[i]!;
      ref.line.classList.toggle("cert__gate--met", gate.met);
      ref.glyph.textContent = gate.met ? "✓" : "◻";
      if (ref.text.textContent !== gate.text) ref.text.textContent = gate.text;
    });
    // Buyable = every gate ticked — derived from the array already in hand
    // rather than a second licenseGates pass.
    if (card.buyButton) card.buyButton.disabled = !gates.every((gate) => gate.met);
  }

  function refreshAll(): void {
    for (const card of cards.values()) refreshCard(card);
  }

  /** Coalesce cash-tick churn into one repaint per frame (orders-panel style). */
  function invalidate(): void {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (visible) refreshAll();
    });
  }

  bus.on("cash.changed", invalidate);
  bus.on("rep.changed", invalidate);
  bus.on("license.bought", invalidate);

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refreshAll();
    },
  };
}
