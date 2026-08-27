import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Icon } from "./Icon.js";

export type RailHeaderProps = {
  collapsed: boolean;
  label: string;
  className?: string | undefined;
  children: ReactNode;
  toggle(): void;
};

/// The disclosure button remains the keyboard-accessible control, while the
/// rest of the non-interactive header surface gets the same pointer behavior.
/// Buttons and links inside the header keep their own actions and never bubble
/// into a collapse or expand.
export function RailHeader({ collapsed, label, className, children, toggle }: RailHeaderProps) {
  const toggleFromSurface = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, select, textarea, [role=button], [role=link]")) return;
    toggle();
  };

  return (
    <header className={`rail-header${className ? ` ${className}` : ""}`} onClick={toggleFromSurface}>
      <button
        type="button"
        className="rail-toggle"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
        onClick={toggle}
      ><Icon name="chevronDown" /></button>
      {children}
    </header>
  );
}
