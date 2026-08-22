// Toast: a label sticker that slaps in (SPEC §28), auto-peels after a moment.

import { h } from "../dom";

export type ToastTone = "info" | "error";

export function createToastHost(root: HTMLElement): (message: string, tone?: ToastTone) => void {
  const host = h("div", { cls: "toasts", attrs: { role: "status", "aria-live": "polite" } });
  root.append(host);

  return (message, tone = "info") => {
    const toast = h("div", { cls: `toast toast--${tone}`, text: message });
    host.append(toast);
    while (host.children.length > 3) host.firstElementChild?.remove();
    window.setTimeout(() => {
      toast.classList.add("toast--out");
      window.setTimeout(() => toast.remove(), 220);
    }, 2600);
  };
}
