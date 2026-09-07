import { useEffect, useId, useRef, useState } from "react";
import type { AgentLibraryEntry, AgentProfileDto } from "@termloop/contract/current";

export function AgentProfilePicker({ profiles, entries, value, select, manage }: {
  profiles: readonly AgentProfileDto[];
  entries: readonly AgentLibraryEntry[];
  value: string;
  select(id: string): void;
  manage?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = profiles.find((profile) => profile.id === value) ?? entries.find((profile) => profile.id === value);
  const options = [
    { id: "builtin.quick-action.free-prompt", name: "Free prompt", description: "Start with your own instructions", category: "", group: "" },
    ...profiles.map((profile) => ({ ...profile, group: entries.find((entry) => entry.id === profile.id)?.favorite ? "Favorites" : profile.id.startsWith("custom.") ? "My agents" : "Built-in" })).sort((a, b) => Number(b.group === "Favorites") - Number(a.group === "Favorites")),
  ].filter((option) => `${option.name} ${option.description} ${option.category}`.toLocaleLowerCase("en-US").includes(query.trim().toLocaleLowerCase("en-US")));
  useEffect(() => { if (open) activeOption.current?.scrollIntoView?.({ block: "nearest" }); }, [open, active, query]);
  const dismiss = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (id: string) => { select(id); dismiss(); };
  return <div className="agent-profile-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="quick-action-kind" type="button" aria-label="Agent profile" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} onClick={() => { setOpen(!open); setQuery(""); setActive(0); }}>
      <span aria-hidden="true">{selected ? "◎" : "✎"}</span><strong id="quick-action-title">{selected?.name ?? (value === "builtin.quick-action.free-prompt" ? "Free prompt" : "Unavailable agent")}</strong><i /><small>{selected?.category ?? "default"}</small><b aria-hidden="true">⌄</b>
    </button>
    {open ? <div className="agent-profile-popover" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((index) => options.length ? (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length : 0); }
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); if (options[active]) choose(options[active].id); }
    }}>
      <input autoFocus role="combobox" aria-label="Search agent profiles" aria-expanded="true" aria-controls={listId} aria-activedescendant={options[active] ? `${listId}-${active}` : undefined} placeholder="Search agents…" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
      <div id={listId} role="listbox" aria-label="Agent profiles" className="agent-profile-picker-list">
        {options.map((option, index) => <button ref={index === active ? activeOption : undefined} id={`${listId}-${index}`} key={option.id} role="option" aria-selected={value === option.id} tabIndex={-1} type="button" className={index === active ? "active" : undefined} onMouseMove={() => setActive(index)} onClick={() => choose(option.id)}><span><strong>{option.name}</strong><small>{option.description}</small></span><em>{option.group}</em></button>)}
        {!options.length ? <p>No matching agents.</p> : null}
      </div>
      {manage ? <button className="agent-profile-manage" type="button" onClick={manage}>Manage agents…</button> : null}
    </div> : null}
  </div>;
}
