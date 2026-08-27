import { useMemo, useState } from "react";

import { promptImproveTarget, promptKind, type PromptAsset } from "../prompt-settings.js";
import { Icon } from "./Icon.js";
import { RailGroup, RailRow } from "./RailGroup.js";
import { useRailGroups } from "./rail-groups.js";

/// Sidebar list of every prompt TermLoop delivers, grouped by the catalog
/// category it belongs to. Selecting one opens it in the stage editor.
export function PromptsRail({ prompts, error, loading, selectedId, openPrompt, improvePrompt, reload }: {
  prompts: readonly PromptAsset[] | undefined;
  error: string | undefined;
  loading: boolean;
  selectedId: string | undefined;
  openPrompt(id: string): void;
  /// Absent while no Project is open: the improver runs in a checkout.
  improvePrompt?: ((prompt: PromptAsset) => void) | undefined;
  reload(): void;
}) {
  const [query, setQuery] = useState("");
  const groups = useRailGroups();

  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const categories = useMemo(() => {
    const visible = (prompts ?? []).filter((prompt) => !normalizedQuery
      || [prompt.title, prompt.id, prompt.category].join("\n").toLocaleLowerCase("en-US").includes(normalizedQuery));
    const grouped = new Map<string, PromptAsset[]>();
    for (const prompt of visible) {
      const existing = grouped.get(prompt.category);
      if (existing) existing.push(prompt);
      else grouped.set(prompt.category, [prompt]);
    }
    return [...grouped.entries()];
  }, [normalizedQuery, prompts]);

  return (
    <nav className="settings-rail" aria-label="Built-in prompts">
      <div className="settings-rail-toolbar">
        <label className="rail-search"><Icon name="search" /><input value={query} aria-label="Search prompts" placeholder="Search prompts" onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="icon-button quiet" type="button" title={loading ? "Loading…" : "Reload prompts"} aria-label="Reload prompts" disabled={loading} onClick={reload}><Icon name="restart" /></button>
      </div>
      <p className="settings-rail-note"><Icon name="sparkles" /><span>Every built-in prompt and system instruction TermLoop delivers.</span></p>
      {error ? <p className="settings-rail-error" role="alert">Could not load prompts: {error}</p> : null}

      {categories.map(([category, entries], index) => {
        // The first category carries the catalog's own entry point, so it opens;
        // the rest stay collapsed until asked for.
        const collapsed = !normalizedQuery && groups.collapsed(category, index > 0);
        return <RailGroup
          key={category}
          label={category}
          count={entries.length}
          collapsed={collapsed}
          toggle={() => groups.toggle(category)}
        >
          {entries.map((prompt) => <RailRow
            key={prompt.id}
            label={prompt.title}
            detail={<><em className={`prompt-kind ${promptKind(prompt).className}`}>{promptKind(prompt).label}</em>{prompt.id}</>}
            mark={prompt.customized ? "Customized" : undefined}
            selected={prompt.id === selectedId}
            open={() => openPrompt(prompt.id)}
            improve={improvePrompt && promptImproveTarget(prompt) ? () => improvePrompt(prompt) : undefined}
          />)}
        </RailGroup>;
      })}
      {!prompts && !error ? <span className="settings-rail-empty">Loading prompts…</span> : null}
      {prompts && !categories.length ? <span className="settings-rail-empty">No prompt matches this search.</span> : null}
    </nav>
  );
}
