// Paper card: 1.5 px ink border, cut-corner notch, 6 px shadow (SPEC §28).

import { h, type Child } from "../dom";

export interface PanelProps {
  title?: string;
  cls?: string;
}

export function Panel(props: PanelProps, children: Child[]): HTMLDivElement {
  const inner: Child[] = [];
  if (props.title) inner.push(h("h2", { cls: "panel__title", text: props.title }));
  inner.push(...children);

  return h("div", { cls: props.cls ? `panel ${props.cls}` : "panel" }, [
    h("div", { cls: "panel__inner" }, inner),
  ]);
}
