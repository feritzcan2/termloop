import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders into a detached jsdom container; returns it with an unmount. */
export function render(element: ReactElement): { container: HTMLElement; root: Root; unmount(): void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

export function rerender(root: Root, element: ReactElement): void {
  act(() => root.render(element));
}

/** Sets a controlled input's value the way React observes typing. */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
