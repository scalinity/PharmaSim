// File-folder tabs (SPEC §28 kit): trapezoid tab tops on a paper folder.
// The active tab joins the sheet below it; the rest sit tucked behind.

import { h } from "../dom";

export interface TabDef {
  id: string;
  label: string;
}

export interface TabsHandle {
  root: HTMLElement;
  setActive(id: string): void;
  setLabel(id: string, label: string): void;
}

export function Tabs(tabs: TabDef[], onChange: (id: string) => void): TabsHandle {
  const buttons = new Map<string, HTMLButtonElement>();

  const root = h("div", { cls: "tabs", attrs: { role: "tablist" } });
  for (const tab of tabs) {
    const button = h("button", {
      cls: "tabs__tab",
      text: tab.label,
      attrs: { type: "button", role: "tab", "aria-selected": "false" },
    });
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      setActive(tab.id);
      onChange(tab.id);
    });
    buttons.set(tab.id, button);
    root.append(button);
  }

  function setActive(id: string): void {
    for (const [tabId, button] of buttons) {
      const active = tabId === id;
      button.classList.toggle("tabs__tab--active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  return {
    root,
    setActive,
    setLabel(id, label) {
      const button = buttons.get(id);
      if (button) button.textContent = label;
    },
  };
}
