// Stroke icons drawn on a 16-unit grid, matching the TermLoop sidebar set.
import type { ReactElement } from "react";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PATHS = {
  down: <path d="M4 6l4 4 4-4" />,
  right: <path d="M6 4l4 4-4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  gear: <><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  agent: <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" />,
  flag: <path d="M3 2v12M3 2h8l-2 3 2 3H3" />,
  warn: <><path d="M8 2l6.5 11h-13z" /><path d="M8 6.5v3M8 11.5v.2" /></>,
  more: <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth={2.4} />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>{PATHS[name]}</svg>;
}
