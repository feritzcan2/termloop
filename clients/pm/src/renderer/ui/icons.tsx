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
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  jira: <><path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z" /><path d="M8 5.6L10.4 8 8 10.4 5.6 8z" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  external: <><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" /><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></>,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  board: <><rect x="2" y="2.5" width="3.2" height="11" rx="1" /><rect x="6.4" y="2.5" width="3.2" height="7.5" rx="1" /><rect x="10.8" y="2.5" width="3.2" height="9.5" rx="1" /></>,
  skill: <><path d="M2.5 4.5l1.5 1.5 3-3" /><path d="M2.5 11l1.5 1.5 3-3" /><path d="M9 4.5h4.5M9 11h4.5" /></>,
  more: <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth={2.4} />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>{PATHS[name]}</svg>;
}
