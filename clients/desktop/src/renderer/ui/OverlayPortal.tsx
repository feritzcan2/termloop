import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function OverlayPortal(props: { container: Element | undefined; children: ReactNode }) {
  return props.container ? createPortal(props.children, props.container) : props.children;
}
