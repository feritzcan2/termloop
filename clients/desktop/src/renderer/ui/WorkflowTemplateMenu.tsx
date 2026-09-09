import { useLayoutEffect, useRef, useState } from "react";
import type { WorkflowConfigurationDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import { workflowSummary } from "./workflow-presentation.js";

/** An on-demand menu; saved templates never take up space in the Task row. */
export function WorkflowTemplateMenu(props: {
  anchor: HTMLButtonElement;
  taskTitle: string;
  configurations: readonly WorkflowConfigurationDto[];
  unavailableReason: string | undefined;
  currentWorkflow?: { name: string; status: string; open(): void } | undefined;
  close(): void;
  run(configuration: WorkflowConfigurationDto): void;
  edit(configuration: WorkflowConfigurationDto | undefined): void;
}) {
  const menu = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = props.anchor.getBoundingClientRect();
      const panel = menu.current?.getBoundingClientRect();
      if (!panel) return;
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - panel.height - 8)),
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [props.anchor, props.configurations.length, props.unavailableReason]);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && !focused.disabled && menu.current?.contains(focused)) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [props.configurations, props.unavailableReason]);

  return <div className="context-menu-layer" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); props.close(); return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key === "Tab") { props.close(); return; }
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation(); items[next]?.focus();
  }}>
    <button type="button" tabIndex={-1} className="context-menu-backdrop" aria-label="Close workflow menu" onClick={props.close} />
    <section ref={menu} className="context-menu workflow-template-menu" role="menu" aria-label="Workflow templates" style={position}>
      {props.currentWorkflow ? <>
        <button type="button" role="menuitem" aria-label="Open current workflow" onClick={props.currentWorkflow.open}>
          <Icon name="branch" /><span><strong>{props.currentWorkflow.name}</strong><small>{props.currentWorkflow.status} · View workflow</small></span>
        </button>
        <div className="context-menu-divider" role="separator" />
      </> : null}
      {props.unavailableReason ? <p className="workflow-menu-notice">{props.unavailableReason}</p> : null}
      <div className="workflow-template-menu-list" role="none">
        {props.configurations.map((configuration) => <div className="workflow-template-menu-row" role="none" key={configuration.id}>
          <button type="button" role="menuitem" disabled={Boolean(props.unavailableReason)}
            title={props.unavailableReason ?? workflowSummary(configuration)}
            aria-label={`Run workflow ${configuration.name} in ${props.taskTitle}`}
            onClick={() => props.run(configuration)}>
            <Icon name="play" /><span><strong>{configuration.name}</strong><small>{workflowSummary(configuration)}</small></span>
          </button>
          <button type="button" role="menuitem" className="workflow-template-menu-edit"
            title={`Edit template ${configuration.name}`} aria-label={`Edit template ${configuration.name}`}
            onClick={() => props.edit(configuration)}><Icon name="edit" /></button>
        </div>)}
      </div>
      {props.configurations.length ? <div className="context-menu-divider" role="separator" /> : null}
      <button type="button" role="menuitem" aria-label="New workflow template" disabled={props.configurations.length >= 16}
        title={props.configurations.length >= 16 ? "This project has reached its limit of 16 templates" : "Create a reusable workflow template"}
        onClick={() => props.edit(undefined)}><Icon name="add" /><span><strong>New template</strong></span></button>
    </section>
  </div>;
}
