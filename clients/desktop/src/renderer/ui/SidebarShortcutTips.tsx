import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { projectShortcutLabel, PROJECT_SHORTCUT_LIMIT, shortcutLabel, type KeyboardPlatform } from "../command-surface.js";

export type SidebarShortcutTip = { label: string; keys: string };

export function sidebarShortcutTips(platform: KeyboardPlatform): SidebarShortcutTip[] {
  return [
    { label: "Quick Action", keys: "Shift Shift" },
    { label: "Fork agent", keys: shortcutLabel("forkSession", platform) },
    { label: "Rename session", keys: shortcutLabel("renameSession", platform) },
    { label: "Switch Project", keys: `${projectShortcutLabel(0, platform)!}–${PROJECT_SHORTCUT_LIMIT}` },
    { label: "New terminal", keys: shortcutLabel("newTerminal", platform) },
  ];
}

/// The tips only take space the rail above leaves empty. `shownHeight` is the
/// card's height when it is currently rendered, because it then already
/// shrinks the rail's viewport by that amount.
export function sidebarShortcutTipsFit(viewportHeight: number, contentHeight: number, tipsHeight: number, shownHeight: number): boolean {
  return viewportHeight + shownHeight - contentHeight >= tipsHeight;
}

// Used until the card has rendered once and can be measured.
const TIPS_HEIGHT_ESTIMATE = 130;

/// Purely presentational: the shortcuts themselves are handled by Shell. It
/// sits below the rail's scroll area and appears only while the rail's rows
/// leave room for it, so rows always stay above it and never scroll for it.
export function SidebarShortcutTips({ platform, scrollRef }: { platform: KeyboardPlatform; scrollRef: RefObject<HTMLElement | null> }) {
  const tipsRef = useRef<HTMLElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const tips = tipsRef.current;
    if (!scroll || !tips || typeof ResizeObserver === "undefined") return;
    let tipsHeight = TIPS_HEIGHT_ESTIMATE;
    let frame = 0;
    const resize = new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const shown = !tips.hidden;
      if (shown) tipsHeight = outerHeight(tips);
      const children = renderedChildren(scroll);
      for (const child of children) resize.observe(child);
      setFits(sidebarShortcutTipsFit(scroll.clientHeight, contentHeight(scroll, children), tipsHeight, shown ? tipsHeight : 0));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mutations = new MutationObserver(schedule);
    resize.observe(scroll);
    mutations.observe(scroll, { childList: true, subtree: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [scrollRef]);
  return (
    <section ref={tipsRef} className="sidebar-shortcut-tips" aria-label="Keyboard shortcuts" hidden={!fits}>
      <header>Shortcuts</header>
      <dl>{sidebarShortcutTips(platform).map((tip) => <div key={tip.label}>
        <dt>{tip.label}</dt>
        <dd><kbd>{tip.keys}</kbd></dd>
      </div>)}</dl>
    </section>
  );
}

// Workspace rail caches use `display: contents`, so the boxes to measure are
// their children.
function renderedChildren(parent: Element): Element[] {
  return [...parent.children].flatMap((child) => getComputedStyle(child).display === "contents" ? renderedChildren(child) : [child]);
}

function contentHeight(scroll: HTMLElement, children: readonly Element[]): number {
  const top = scroll.getBoundingClientRect().top - scroll.scrollTop;
  let bottom = top;
  for (const child of children) {
    const rect = child.getBoundingClientRect();
    if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom - top;
}

function outerHeight(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
}
