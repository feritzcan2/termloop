// The native Ghostty surface the PM mounts agents into on macOS. The view is
// an AppKit child over the web contents, so it always paints above the DOM:
// while a modal dialog is open the surface is swapped for its snapshot.
import { GhosttySurface } from "@termloop/terminal-surface/ghostty";
import type { GhosttyBridge } from "@termloop/terminal-surface/ghostty-bridge";
import type { SurfaceFactory } from "./agent-terminal.js";
import "./ghostty-surface.css";

/** Anything matching this covers the whole window, terminal included. */
const MODAL_SELECTOR = "[role=\"dialog\"], .modal-backdrop";

/** Reports whether a modal covers the window now and on every change. */
export function watchModalOcclusion(root: Document, onChange: (occluded: boolean) => void): () => void {
  let occluded = false;
  const check = () => {
    const next = root.querySelector(MODAL_SELECTOR) !== null;
    if (next === occluded) return;
    occluded = next;
    onChange(next);
  };
  const observer = new MutationObserver(check);
  observer.observe(root.body, { childList: true, subtree: true });
  check();
  return () => observer.disconnect();
}

class PmGhosttySurface extends GhosttySurface {
  #stopOcclusion: (() => void) | undefined;

  override async mount(container: HTMLElement, preferWebgl: boolean): Promise<void> {
    const mounted = super.mount(container, preferWebgl);
    // After super.mount marked the surface visible, so a dialog that is
    // already open hides it before the native view is ever shown.
    this.#stopOcclusion ??= watchModalOcclusion(container.ownerDocument, (occluded) => this.setVisible(!occluded));
    await mounted;
  }

  override dispose(): void {
    this.#stopOcclusion?.();
    this.#stopOcclusion = undefined;
    super.dispose();
  }
}

export function ghosttySurface(bridge: GhosttyBridge): SurfaceFactory {
  return (onInput, onResize) => new PmGhosttySurface(onInput, onResize, bridge);
}
