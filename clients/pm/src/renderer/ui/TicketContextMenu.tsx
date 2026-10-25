import { useEffect, useRef, type KeyboardEvent } from "react";

export type ContextMenuItem =
  | { kind: "action"; label: string; disabled?: boolean; run(): void }
  | { kind: "separator" };

export type ContextMenuAt = { x: number; y: number };

/** Keeps a menu of about `width` × `height` inside the window. */
export function menuPosition(at: ContextMenuAt, size: { width: number; height: number }, viewport: { width: number; height: number }): ContextMenuAt {
  return {
    x: Math.max(4, Math.min(at.x, viewport.width - size.width - 4)),
    y: Math.max(4, Math.min(at.y, viewport.height - size.height - 4)),
  };
}

/**
 * A ticket's right-click menu at the pointer. It closes on Escape, a pick,
 * a click elsewhere, or a scroll; arrow keys move between items.
 */
export function TicketContextMenu(props: { at: ContextMenuAt; label: string; items: ContextMenuItem[]; onClose(): void }) {
  const menu = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const away = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const height = props.items.reduce((sum, item) => sum + (item.kind === "separator" ? 9 : 27), 8);
  const at = menuPosition(props.at, { width: 240, height }, { width: window.innerWidth, height: window.innerHeight });

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div ref={menu} role="menu" aria-label={props.label} className="pm-menu pm-context-menu" style={{ left: at.x, top: at.y }} onKeyDown={keys} onContextMenu={(event) => event.preventDefault()}>
      {props.items.map((item, index) => item.kind === "separator"
        ? <hr key={index} className="pm-menu-sep" />
        : (
          <button key={index} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.run(); }}>
            {item.label}
          </button>
        ))}
    </div>
  );
}
