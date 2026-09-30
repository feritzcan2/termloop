import { useEffect, useRef, type ButtonHTMLAttributes } from "react";

/** Short press launches; hold, right-click or Shift+F10 opens settings. */
export function AgentLaunchButton({ configure, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { configure?: (() => void) | undefined }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; origin.current = undefined; };
  useEffect(() => cancel, []);
  useEffect(() => { if (props.disabled) cancel(); }, [props.disabled]);
  return <button {...props}
    onPointerDown={(event) => {
      cancel(); held.current = false;
      if (!configure || event.button !== 0 || props.disabled) return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { held.current = true; cancel(); configure(); }, 550);
    }}
    onPointerMove={(event) => {
      if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) { held.current = true; cancel(); }
    }}
    onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel} onBlur={cancel}
    onClick={(event) => {
      cancel();
      if (held.current) { held.current = false; event.preventDefault(); event.stopPropagation(); return; }
      onClick?.(event);
    }}
    onContextMenu={configure ? (event) => { event.preventDefault(); held.current = true; cancel(); configure(); } : undefined}
    onKeyDown={(event) => {
      if (configure && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
        event.preventDefault(); cancel(); configure();
      } else if (event.key === "Enter" || event.key === " ") held.current = false;
    }}
  />;
}
