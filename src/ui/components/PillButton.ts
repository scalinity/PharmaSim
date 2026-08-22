// Capsule button: pine fill / paper text; secondary = paper with ink outline.

import { h } from "../dom";

export interface PillButtonProps {
  variant?: "primary" | "secondary";
  cls?: string;
  ariaLabel?: string;
}

export function PillButton(
  label: string,
  onClick: () => void,
  props: PillButtonProps = {},
): HTMLButtonElement {
  const variant = props.variant ?? "primary";
  let cls = `pill pill--${variant}`;
  if (props.cls) cls += ` ${props.cls}`;

  const attrs: Record<string, string> = { type: "button" };
  if (props.ariaLabel) attrs["aria-label"] = props.ariaLabel;

  const button = h("button", { cls, text: label, attrs });
  button.addEventListener("click", onClick);
  // Keep mouse clicks from parking keyboard focus (and Space) on the button.
  button.addEventListener("pointerdown", (e) => e.preventDefault());
  return button;
}
