import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  filterShellCommands,
  shortcutLabel,
  type KeyboardPlatform,
  type ShellCommand,
  type ShellShortcutId,
} from "../command-surface.js";
import { Icon } from "./Icon.js";

export function CommandPalette({ commands, platform, close }: {
  commands: readonly ShellCommand[];
  platform: KeyboardPlatform;
  close(): void;
}) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterShellCommands(commands, query), [commands, query]);
  const enabled = filtered.filter((command) => !command.disabled);
  const active = enabled.find((command) => command.id === activeId) ?? enabled[0];

  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  useEffect(() => { setActiveId((current) => enabled.some((command) => command.id === current) ? current : enabled[0]?.id); }, [query, commands]);

  const run = (command: ShellCommand) => {
    if (command.disabled) return;
    close();
    void command.perform();
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Enter" && active) { event.preventDefault(); run(active); return; }
    if (!(["ArrowDown", "ArrowUp", "Home", "End"] as string[]).includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const index = Math.max(0, enabled.findIndex((command) => command.id === active?.id));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? enabled.length - 1
        : event.key === "ArrowDown" ? (index + 1) % enabled.length
          : (index - 1 + enabled.length) % enabled.length;
    setActiveId(enabled[next]?.id);
  };

  return (
    <div className="command-layer" onKeyDown={keyDown}>
      <button className="command-backdrop" type="button" aria-label="Close command palette" onClick={close} />
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <header className="command-search">
          <Icon name="search" />
          <label id="command-palette-title" htmlFor="command-query">Command palette</label>
          <input
            ref={inputRef}
            id="command-query"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={active ? `command-${active.id}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command, Project, or Session…"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </header>
        <div id="command-results" className="command-results" role="listbox" aria-label="Available commands">
          {filtered.length === 0 ? <p className="command-empty">No matching command.</p> : filtered.map((command, index) => {
            const showGroup = index === 0 || filtered[index - 1]?.group !== command.group;
            return (
              <div className="command-result" key={command.id}>
                {showGroup ? <h2>{command.group}</h2> : null}
                <button
                  id={`command-${command.id}`}
                  type="button"
                  role="option"
                  aria-selected={active?.id === command.id}
                  disabled={command.disabled}
                  className={command.danger ? "danger" : undefined}
                  onPointerMove={() => { if (!command.disabled) setActiveId(command.id); }}
                  onClick={() => run(command)}
                >
                  <span><strong>{command.title}</strong><small>{command.detail}</small></span>
                  {command.shortcutId
                    ? <kbd>{shortcutLabel(command.shortcutId, platform)}</kbd>
                    : command.shortcutHint ? <kbd>{command.shortcutHint}</kbd> : null}
                </button>
              </div>
            );
          })}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Run</span><span>Shift Shift opens Quick Action</span></footer>
      </section>
    </div>
  );
}

const SHORTCUT_ROWS: readonly { id: ShellShortcutId; label: string; detail: string }[] = [
  { id: "commandPalette", label: "Command palette", detail: "Captured anywhere in the TermLoop window." },
  { id: "newTerminal", label: "New terminal", detail: "Creates a Session in the selected Project." },
  { id: "focusPreviousPane", label: "Focus previous pane", detail: "Cycles without changing Session lifecycle." },
  { id: "focusNextPane", label: "Focus next pane", detail: "Cycles without changing Session lifecycle." },
];

export function KeyboardShortcutsDialog({ platform, close }: { platform: KeyboardPlatform; close(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { requestAnimationFrame(() => closeRef.current?.focus()); }, []);
  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <button className="dialog-backdrop" aria-label="Close keyboard settings" onClick={close} />
      <section className="dialog-card shortcut-settings" role="dialog" aria-modal="true" aria-labelledby="shortcut-settings-title">
        <header className="dialog-header"><div><span className="dialog-eyebrow">Settings</span><h2 id="shortcut-settings-title">Keyboard shortcuts</h2></div><button ref={closeRef} className="icon-button quiet" aria-label="Close keyboard settings" onClick={close}><Icon name="close" /></button></header>
        <div className="shortcut-settings-list">
          {SHORTCUT_ROWS.map((row) => <div key={row.id}><span><strong>{row.label}</strong><small>{row.detail}</small></span><kbd>{shortcutLabel(row.id, platform)}</kbd></div>)}
          <div><span><strong>Open Quick Action</strong><small>Modifier-only chord is observed, never consumed.</small></span><kbd>Shift Shift</kbd></div>
        </div>
        <footer className="dialog-actions"><button className="primary-button" onClick={close}>Done</button></footer>
      </section>
    </div>
  );
}
