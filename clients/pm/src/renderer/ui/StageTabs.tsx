import type { PmView } from "./types.js";

export type StageTab = { view: PmView; label: string; title?: string; draft?: boolean };

/** The stage's 30px tab strip: sprint overview, the open ticket, settings. */
export function StageTabs(props: { tabs: StageTab[]; view: PmView; onView(view: PmView): void }) {
  return (
    <nav className="tabs" aria-label="Views" role="tablist">
      {props.tabs.map((tab) => (
        <button
          key={tab.view}
          type="button"
          role="tab"
          aria-selected={tab.view === props.view}
          className={`tab ${tab.view === props.view ? "on" : ""}`}
          title={tab.title ?? tab.label}
          onClick={() => props.onView(tab.view)}
        >
          {tab.draft && <i title="An assistant draft is waiting" />}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
