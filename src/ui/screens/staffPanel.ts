// Team panel (SPEC §9, §28): the pharmacy's personnel folder. Two file-folder
// tabs — the roster on the clock, and the week's applications laid out as
// index cards on the counter (the signature moment: name in Fraunces, stats
// as blister-pack pips, the trait as a stuck-on label, the wage ask in Plex
// Mono with Penny-wise showing the struck rate). Empty states speak §28's
// voice: "No tech — scripts wait for you at the bench."
//
// Multi-branch (§19): the folder carries a branch scope row — the hiring
// pool is shared, but every roster, station and new hire belongs to one
// store. Managers are real cards now: they hold no station and run the
// branch on days you aren't in it.

import type { EventBus } from "../../core/bus";
import { furnitureDef } from "../../data/furniture";
import type { SimEvent } from "../../sim/events";
import type { Sim } from "../../sim/sim";
import {
  HIREABLE_ROLES,
  mondayOf,
  ROLE_LABELS,
  ROLE_STATIONS,
  TRAIT_LABELS,
  TRAIT_NOTES,
  WAGES,
  type StaffCandidate,
  type StaffMember,
  type StaffRole,
} from "../../sim/staff";
import { activeStore, storeById, storeName, type StoreState } from "../../sim/state";
import { BranchScope } from "../components/BranchScope";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { PillButton } from "../components/PillButton";
import { Tabs } from "../components/Tabs";
import { h } from "../dom";
import { money } from "../format";

const ROLE_PLURALS: Record<StaffRole, string> = {
  cashier: "Cashiers",
  tech: "Pharmacy techs",
  pharmacist: "Pharmacists",
  manager: "Managers",
};

/** §28 empty-state copy — what the gap costs you, said plainly. */
const EMPTY_ROSTER: Record<StaffRole, string> = {
  cashier: "No cashier — the till only rings when you work it.",
  tech: "No tech — scripts wait for you at the bench.",
  pharmacist: "No pharmacist — you're the last check on every script.",
  manager: "No manager — an unvisited branch runs at 60%.",
};

const STATION_LABELS: Record<string, string> = {
  counter_register: "Register",
  counter_service: "Service counter",
  fill_bench: "Fill bench",
  verify_desk: "Verify desk",
  vaccine_station: "Vaccine station",
};

interface StationOption {
  id: string;
  label: string;
  takenBy: string | null;
}

export interface StaffPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

export function createStaffPanel(sim: Sim, bus: EventBus<SimEvent>): StaffPanelHandle {
  let visible = false;

  const payroll = h("span", { cls: "teamp__payroll" });
  const eyebrow = h("p", { cls: "teamp__eyebrow" });
  const rosterView = h("div", { cls: "teamp__view" });
  const appsView = h("div", { cls: "teamp__view" });

  const scope = BranchScope(sim, () => refreshAll());

  // Tabs owns the active state; the panel only mirrors it onto the views.
  const tabs = Tabs(
    [
      { id: "roster", label: "On the clock" },
      { id: "apps", label: "Applications" },
    ],
    (id) => {
      rosterView.hidden = id !== "roster";
      appsView.hidden = id !== "apps";
    },
  );
  tabs.setActive("roster");
  appsView.hidden = true;

  const panel = Panel({ cls: "teamp" }, [
    h("div", { cls: "teamp__top" }, [
      h("div", {}, [eyebrow, h("h2", { cls: "panel__title", text: "Team" })]),
      payroll,
    ]),
    scope.root,
    tabs.root,
    h("div", { cls: "teamp__body" }, [rosterView, appsView]),
  ]);

  const root = h("div", { cls: "team" }, [panel]);
  root.hidden = true;

  /** The branch this folder is open to (§19). */
  function scopedStore(): StoreState {
    return storeById(sim.snapshot, scope.current()) ?? activeStore(sim.snapshot);
  }

  // --- Shared bits ---

  /** Stations this role can hold in the scoped store, numbered on repeats. */
  function stationOptions(store: StoreState, role: StaffRole): StationOption[] {
    const defs = ROLE_STATIONS[role];
    const counts: Record<string, number> = {};
    const totals: Record<string, number> = {};
    for (const item of store.furniture) totals[item.defId] = (totals[item.defId] ?? 0) + 1;
    const options: StationOption[] = [];
    for (const item of store.furniture) {
      if (!defs.includes(item.defId)) continue;
      const n = (counts[item.defId] = (counts[item.defId] ?? 0) + 1);
      const base = STATION_LABELS[item.defId] ?? furnitureDef(item.defId).name;
      const label = (totals[item.defId] ?? 0) > 1 ? `${base} ${n}` : base;
      const holder = store.staff.find((m) => m.assignment?.stationId === item.id);
      options.push({ id: item.id, label, takenBy: holder ? holder.id : null });
    }
    return options;
  }

  function traitChip(member: { trait: StaffMember["trait"] }): HTMLElement {
    return h("span", { cls: `trait trait--${member.trait}` }, [
      h("span", { cls: "trait__name", text: TRAIT_LABELS[member.trait] }),
      h("span", { cls: "trait__note", text: TRAIT_NOTES[member.trait] }),
    ]);
  }

  function meters(person: { speed: number; accuracy: number; warmth: number }): HTMLElement {
    return h("div", { cls: "meters" }, [
      Meter("speed", person.speed),
      Meter("accuracy", person.accuracy),
      Meter("warmth", person.warmth),
    ]);
  }

  // --- Roster tab ---

  function buildRosterRow(store: StoreState, member: StaffMember): HTMLElement {
    // Managers hold no station (§9/§19): the whole branch is their post.
    let assignCell: HTMLElement;
    if (member.role === "manager") {
      assignCell = h("span", { cls: "srow__assign srow__assign--manager", text: "Runs the branch" });
    } else {
      const select = h("select", {
        cls: "srow__assign",
        attrs: { "aria-label": `${member.name} assignment` },
      });
      select.append(h("option", { text: "Off duty", attrs: { value: "" } }));
      for (const option of stationOptions(store, member.role)) {
        const el = h("option", {
          text:
            option.takenBy && option.takenBy !== member.id ? `${option.label} · taken` : option.label,
          attrs: { value: option.id },
        });
        if (option.takenBy && option.takenBy !== member.id) el.disabled = true;
        select.append(el);
      }
      select.value = member.assignment?.stationId ?? "";
      select.addEventListener("change", () => {
        sim.dispatch({
          type: "staff.assign",
          staffId: member.id,
          stationId: select.value === "" ? null : select.value,
          storeId: store.id,
        });
      });
      assignCell = select;
    }

    const fire = PillButton(
      "Let go",
      () => sim.dispatch({ type: "staff.fire", staffId: member.id, storeId: store.id }),
      { variant: "secondary", cls: "pill--small srow__fire" },
    );

    return h("div", { cls: "srow" }, [
      h("div", { cls: "srow__head" }, [
        h("span", { cls: "srow__name", text: member.name }),
        h("span", { cls: "srow__wage", text: `${money(member.dailyWage)} a day` }),
        assignCell,
        fire,
      ]),
      h("div", { cls: "srow__detail" }, [meters(member), traitChip(member)]),
    ]);
  }

  function buildRoster(): void {
    const store = scopedStore();
    rosterView.replaceChildren();
    for (const role of HIREABLE_ROLES) {
      const members = store.staff.filter((m) => m.role === role);
      rosterView.append(
        h("div", { cls: "teamp__section" }, [
          h("h3", { cls: "teamp__sectitle", text: ROLE_PLURALS[role] }),
        ]),
      );
      if (members.length === 0) {
        rosterView.append(h("p", { cls: "teamp__slip", text: EMPTY_ROSTER[role] }));
        if (role === "pharmacist" && !store.furniture.some((f) => f.defId === "verify_desk")) {
          rosterView.append(
            h("p", {
              cls: "teamp__hint",
              text: `No verify desk on the floor either — the Build palette sells one for ${money(furnitureDef("verify_desk").cost)}.`,
            }),
          );
        }
        continue;
      }
      for (const member of members) rosterView.append(buildRosterRow(store, member));
    }

    const total = store.staff.reduce((sum, m) => sum + m.dailyWage, 0);
    if (total > 0) {
      rosterView.append(
        h("div", { cls: "teamp__foot" }, [
          h("span", { text: "Payroll" }),
          h("span", { cls: "teamp__dots" }),
          h("span", { cls: "teamp__footnum", text: `${money(total)} a day, on tonight's receipt` }),
        ]),
      );
    }
  }

  // --- Applications tab ---

  function buildCandidateCard(candidate: StaffCandidate, index: number): HTMLElement {
    const wage = h("div", { cls: "acard__wage" });
    if (candidate.trait === "pennywise") {
      wage.append(
        h("s", { cls: "acard__base", text: money(WAGES[candidate.role]) }),
        h("span", { text: ` asks ${money(candidate.wageAsked)} a day` }),
      );
    } else {
      wage.append(h("span", { text: `asks ${money(candidate.wageAsked)} a day` }));
    }

    const card = h("div", { cls: `acard${index % 2 === 1 ? " acard--tilt" : ""}` }, [
      h("div", { cls: "acard__rule", attrs: { "aria-hidden": "true" } }),
      h("p", { cls: "acard__role", text: ROLE_LABELS[candidate.role] }),
      h("h4", { cls: "acard__name", text: candidate.name }),
      meters(candidate),
      traitChip(candidate),
      wage,
      PillButton(
        "Hire",
        () =>
          sim.dispatch({
            type: "staff.hire",
            candidateId: candidate.id,
            storeId: scopedStore().id,
          }),
        { cls: "pill--small acard__hire" },
      ),
    ]);
    return card;
  }

  function buildApps(): void {
    const state = sim.snapshot;
    const store = scopedStore();
    appsView.replaceChildren();
    const nextMonday = mondayOf(state.day) + 7;
    appsView.append(
      h("p", {
        cls: "teamp__note",
        text:
          `Three applicants a role. A fresh batch lands Monday morning — day ${nextMonday}. ` +
          `Better word of mouth, better hands.` +
          (state.stores.length > 1 ? ` Hires join ${storeName(store)}.` : ""),
      }),
    );
    for (const role of HIREABLE_ROLES) {
      appsView.append(
        h("div", { cls: "teamp__section" }, [
          h("h3", { cls: "teamp__sectitle", text: ROLE_PLURALS[role] }),
        ]),
      );
      if (role === "manager") {
        appsView.append(
          h("p", {
            cls: "teamp__hint",
            text: "Managers run branches you're not standing in — the day holds its pace instead of falling to 60%.",
          }),
        );
      }
      const candidates = state.hiring.candidates.filter((c) => c.role === role);
      const grid = h("div", { cls: "acards" });
      candidates.forEach((candidate, i) => grid.append(buildCandidateCard(candidate, i)));
      for (let i = candidates.length; i < 3; i++) {
        grid.append(
          h("div", { cls: "acard acard--gone" }, [
            h("span", { cls: "acard__gonemark", text: "hired" }),
            h("p", { cls: "acard__gonenote", text: "This card's off the pile." }),
          ]),
        );
      }
      appsView.append(grid);
    }
  }

  function refreshPayroll(): void {
    const total = scopedStore().staff.reduce((sum, m) => sum + m.dailyWage, 0);
    payroll.textContent =
      total > 0
        ? `Payroll ${money(total)} a day`
        : "No payroll yet — the whole shift is yours";
  }

  function refreshAll(): void {
    const store = scopedStore();
    eyebrow.textContent = `${storeName(store)} · personnel`;
    scope.refresh();
    buildRoster();
    buildApps();
    refreshPayroll();
    tabs.setLabel("roster", `On the clock · ${store.staff.length}`);
    tabs.setLabel("apps", `Applications · ${sim.snapshot.hiring.candidates.length}`);
  }

  const refreshIfVisible = (): void => {
    if (visible) refreshAll();
  };
  bus.on("staff.hired", refreshIfVisible);
  bus.on("staff.fired", refreshIfVisible);
  bus.on("staff.assigned", refreshIfVisible);
  bus.on("staff.poolRefreshed", refreshIfVisible);
  bus.on("furniture.placed", refreshIfVisible);
  bus.on("furniture.sold", refreshIfVisible);
  bus.on("day.phaseChanged", refreshIfVisible);
  bus.on("branch.bought", refreshIfVisible);
  bus.on("branch.activeChanged", () => {
    scope.reset();
    refreshIfVisible();
  });

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) {
        scope.reset();
        refreshAll();
      }
    },
  };
}
