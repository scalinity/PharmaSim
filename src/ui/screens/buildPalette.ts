// Build palette (SPEC §6, §28): a shopfitter's order sheet on paper. Each row
// leads with a footprint pictograph in the floor grid's own language — cells
// filled ink for backroom items, pine for the shop floor, outlined for
// anywhere — then name, spec line, and the price in mono. Unaffordable and
// gated rows stay listed with the reason in place of the spec line. The
// sheet's last section is the floor itself: the next §6 expansion, bought
// like any other line item (morning only — walls can't move mid-shift).

import { rotatedSize } from "../../core/grid";
import { EXPANSIONS, FURNITURE_DEFS, type FurnitureDef } from "../../data/furniture";
import type { Sim } from "../../sim/sim";
import { Panel } from "../components/Panel";
import { h } from "../dom";

const GROUPS: string[][] = [
  // Fixtures — the selling floor
  ["counter_service", "counter_register", "otc_shelf", "chair_waiting"],
  // Dispensary — behind the counter line
  ["rx_shelf", "fill_bench", "verify_desk", "fridge_medical", "cabinet_controlled"],
  // Equipment & services
  ["vaccine_station", "generator_backup", "dispenser_robotic"],
  // Decor
  ["decor_plant", "decor_rug", "decor_poster"],
];

export interface BuildPaletteHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
  setSelected(defId: string | null): void;
  /** Re-evaluate affordability/gates for every row. */
  refresh(): void;
}

function zoneLabel(def: FurnitureDef): string {
  if (def.wallMounted) return "wall";
  if (def.zone === "backroom") return "backroom";
  if (def.zone === "public") return "shop floor";
  return "anywhere";
}

function specLine(def: FurnitureDef): string {
  const [w, hgt] = rotatedSize(def.cells, 0);
  return `${w}\u00d7${hgt} \u00b7 ${zoneLabel(def)}`;
}

function pictograph(def: FurnitureDef): HTMLElement {
  const [w, hgt] = rotatedSize(def.cells, 0);
  const zone = def.wallMounted ? "wall" : def.zone;
  return cellPrint(w, hgt, zone);
}

function cellPrint(w: number, hgt: number, zone: string): HTMLElement {
  const grid = h("span", { cls: `prow__print prow__print--${zone}`, attrs: { "aria-hidden": "true" } });
  grid.style.gridTemplateColumns = `repeat(${w}, 9px)`;
  for (let i = 0; i < w * hgt; i++) grid.append(h("i", { cls: "prow__cell" }));
  return grid;
}

export function createBuildPalette(
  sim: Sim,
  onPick: (defId: string) => void,
): BuildPaletteHandle {
  const defsById = new Map(FURNITURE_DEFS.map((def) => [def.id, def]));
  const rows = new Map<string, { button: HTMLButtonElement; meta: HTMLElement }>();

  const list = h("div", { cls: "palette__list" });
  GROUPS.forEach((group, index) => {
    if (index > 0) list.append(h("div", { cls: "palette__rule", attrs: { "aria-hidden": "true" } }));
    for (const defId of group) {
      const def = defsById.get(defId)!;
      const meta = h("span", { cls: "prow__meta", text: specLine(def) });
      const button = h(
        "button",
        { cls: "prow", attrs: { type: "button" } },
        [
          pictograph(def),
          h("span", { cls: "prow__body" }, [
            h("span", { cls: "prow__name", text: def.name }),
            meta,
          ]),
          h("span", { cls: "prow__cost", text: `$${def.cost.toLocaleString("en-US")}` }),
        ],
      );
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") !== "true") onPick(defId);
      });
      button.addEventListener("pointerdown", (e) => e.preventDefault());
      rows.set(defId, { button, meta });
      list.append(button);
    }
  });

  // --- The floor itself: the next \u00a76 expansion as the sheet's last line ---

  const floorMeta = h("span", { cls: "prow__meta" });
  const floorName = h("span", { cls: "prow__name" });
  const floorCost = h("span", { cls: "prow__cost" });
  let floorPrint = cellPrint(1, 1, "any");
  const floorRow = h("button", { cls: "prow", attrs: { type: "button" } }, [
    floorPrint,
    h("span", { cls: "prow__body" }, [floorName, floorMeta]),
    floorCost,
  ]);
  floorRow.addEventListener("pointerdown", (e) => e.preventDefault());
  floorRow.addEventListener("click", () => {
    if (floorRow.getAttribute("aria-disabled") !== "true") {
      sim.dispatch({ type: "expansion.buy" });
    }
  });
  list.append(h("div", { cls: "palette__rule", attrs: { "aria-hidden": "true" } }), floorRow);

  /** Why the next expansion can't be bought right now, or null. */
  function floorLock(): string | null {
    const state = sim.snapshot;
    const next = EXPANSIONS[state.store.grid.expansions];
    if (!next) return null;
    if (state.phase !== "morning") return "Morning work only";
    if (state.cash < next.cost) {
      return `Short $${(next.cost - state.cash).toLocaleString("en-US")}`;
    }
    return null;
  }

  function setFloorPrint(next: HTMLElement): void {
    floorPrint.replaceWith(next);
    floorPrint = next;
  }

  function refreshFloorRow(): void {
    const state = sim.snapshot;
    const { cols, rows: gridRows, expansions } = state.store.grid;
    const next = EXPANSIONS[expansions];
    if (!next) {
      setFloorPrint(cellPrint(2, 2, "any"));
      floorName.textContent = "Floor at full size";
      floorMeta.textContent = `${cols}\u00d7${gridRows}`;
      floorMeta.classList.remove("prow__meta--money");
      floorCost.textContent = "";
      floorRow.classList.add("prow--off");
      floorRow.setAttribute("aria-disabled", "true");
      return;
    }
    // The pictograph is the growth itself: a strip of new columns or rows.
    const dCols = next.cols - cols;
    const dRows = next.rows - gridRows;
    setFloorPrint(dCols > 0 ? cellPrint(dCols, 1, "any") : cellPrint(1, dRows, "any"));
    floorName.textContent = `Expansion ${expansions + 1} \u2014 ${next.cols}\u00d7${next.rows}`;
    floorCost.textContent = `$${next.cost.toLocaleString("en-US")}`;
    const lock = floorLock();
    floorMeta.textContent =
      lock ?? (dCols > 0 ? `+${dCols} columns \u00b7 walls move now` : `+${dRows} rows \u00b7 walls move now`);
    floorMeta.classList.toggle("prow__meta--money", lock?.startsWith("Short") ?? false);
    floorRow.classList.toggle("prow--off", lock !== null);
    floorRow.setAttribute("aria-disabled", String(lock !== null));
  }

  const panel = Panel({ cls: "palette" }, [
    h("p", { cls: "palette__eyebrow", text: "Shopfitter's catalog" }),
    h("h2", { cls: "panel__title", text: "Build" }),
    list,
    h("p", { cls: "palette__hint", text: "Click to place \u00b7 R rotates \u00b7 Esc puts it down" }),
  ]);
  panel.hidden = true;

  function refresh(): void {
    for (const [defId, row] of rows) {
      const def = defsById.get(defId)!;
      const check = sim.itemAvailability(defId);
      const off = !check.ok;
      row.button.classList.toggle("prow--off", off);
      row.button.setAttribute("aria-disabled", String(off));
      if (off) {
        row.meta.textContent = check.ok ? "" : check.reason;
        row.meta.classList.toggle("prow__meta--money", !check.ok && check.reason.startsWith("Short"));
      } else {
        row.meta.textContent = specLine(def);
        row.meta.classList.remove("prow__meta--money");
      }
    }
    refreshFloorRow();
  }

  return {
    root: panel,
    setVisible(on) {
      panel.hidden = !on;
      if (on) refresh();
    },
    setSelected(defId) {
      for (const [id, row] of rows) {
        row.button.classList.toggle("prow--active", id === defId);
      }
    },
    refresh,
  };
}
