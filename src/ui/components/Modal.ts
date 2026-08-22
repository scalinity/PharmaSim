// Modal: a paper sheet over the glass scrim (SPEC §28). Used for the one
// decision the game refuses to take on its own — writing over a save.

import { h } from "../dom";
import { PillButton } from "./PillButton";

export interface ModalProps {
  title: string;
  /** One paragraph per string; the first line carries the consequence. */
  body: string[];
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

export interface ModalHandle {
  root: HTMLElement;
  /** Focus the safe choice, so a stray Return can't overwrite anything. */
  focus(): void;
}

export function Modal(props: ModalProps): ModalHandle {
  const cancel = PillButton(props.cancelLabel, props.onCancel, { variant: "secondary" });
  const confirm = PillButton(props.confirmLabel, props.onConfirm, { cls: "pill--warn" });

  const sheet = h(
    "div",
    { cls: "modal__sheet", attrs: { role: "dialog", "aria-modal": "true" } },
    [
      h("h2", { cls: "modal__title", text: props.title }),
      ...props.body.map((text) => h("p", { cls: "modal__text", text })),
      h("div", { cls: "modal__actions" }, [cancel, confirm]),
    ],
  );

  const root = h("div", { cls: "screen modal" }, [sheet]);
  root.addEventListener("pointerdown", (event) => {
    if (event.target === root) props.onCancel();
  });

  return { root, focus: () => cancel.focus() };
}
