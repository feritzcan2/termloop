import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { Project } from "../model.js";
import {
  QUICK_ACTION_AGENT_MODELS,
  QUICK_ACTION_AGENT_PERMISSIONS,
  QUICK_ACTION_AGENT_REASONING,
  defaultAgentPermission,
  permissionLabel,
  readQuickActionMemory,
  rememberAgentSetupSelection,
  type QuickActionAgentSelection,
  type QuickActionPermission,
  type QuickActionReasoning,
} from "../quick-action-memory.js";
import { Icon } from "./Icon.js";

export function AgentSetupDialog(props: {
  project: Project;
  title: string;
  capabilities: readonly AgentCapabilityDto[];
  start(selection: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
  close(): void;
}) {
  type AssistantAgentId = QuickActionAgentSelection["agentId"];
  const availableAgents = useMemo(() => props.capabilities
    .filter((capability): capability is AgentCapabilityDto & { agent_id: AssistantAgentId } => capability.available
      && capability.tracked_helpers_supported
      && (capability.agent_id === "claude" || capability.agent_id === "codex"))
    .map((capability) => capability.agent_id), [props.capabilities]);
  const memory = useMemo(readQuickActionMemory, []);
  const rememberedAgent: AssistantAgentId | undefined = memory.lastAgentId === "claude" || memory.lastAgentId === "codex"
    ? memory.lastAgentId : undefined;
  const initialAgent: AssistantAgentId = rememberedAgent && availableAgents.includes(rememberedAgent)
    ? rememberedAgent
    : availableAgents[0] ?? "codex";
  const initialPreset = memory.presets[initialAgent];
  const [agentId, setAgentId] = useState<AssistantAgentId>(initialAgent);
  const [model, setModel] = useState(() => validModel(initialAgent, initialPreset?.model));
  const [permission, setPermission] = useState<QuickActionPermission>(initialPreset?.permission ?? defaultAgentPermission(initialAgent));
  const [reasoning, setReasoning] = useState<QuickActionReasoning>(initialPreset?.reasoning ?? "default");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const priorAgent = useRef(agentId);
  const agentRef = useRef<HTMLSelectElement>(null);

  useEffect(() => { requestAnimationFrame(() => agentRef.current?.focus()); }, []);
  useEffect(() => {
    if (priorAgent.current === agentId) return;
    priorAgent.current = agentId;
    const preset = memory.presets[agentId];
    setModel(validModel(agentId, preset?.model));
    setPermission(preset?.permission ?? defaultAgentPermission(agentId));
    setReasoning(preset?.reasoning ?? "default");
  }, [agentId, memory.presets]);

  const launch = async (fresh: boolean) => {
    if (running || !availableAgents.includes(agentId)) return;
    setRunning(true);
    setError(undefined);
    try {
      const selection = { agentId, model, permission, reasoning };
      // Setup is durable user intent, independent of whether an existing
      // improver resumes or a new launch succeeds. Persist before crossing the
      // async launch boundary so a provider/daemon failure cannot erase the
      // choices the user just configured.
      rememberAgentSetupSelection(props.project.id, agentId, { model, permission, reasoning });
      const failure = fresh ? await props.start(selection, { fresh: true }) : await props.start(selection);
      if (failure) { setError(failure); return; }
      props.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await launch(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.close();
  };

  return <div className="agent-setup-layer" onKeyDown={keyDown}>
    <button type="button" className="agent-setup-backdrop" aria-label="Close agent setup" onClick={props.close} />
    <form className="agent-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-setup-title" onSubmit={(event) => void submit(event)}>
      <header>
        <span className="agent-setup-icon"><Icon name="sparkles" /></span>
        <div><small>Agent setup</small><h2 id="agent-setup-title">{props.title}</h2><p>{props.project.name}</p></div>
        <button type="button" className="icon-button quiet" aria-label="Close agent setup" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="agent-setup-fields">
        <label>Agent<select ref={agentRef} aria-label="Agent" value={agentId} onChange={(event) => setAgentId(event.target.value as AssistantAgentId)}>
          {availableAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
        </select></label>
        <label>Model<select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
          {(QUICK_ACTION_AGENT_MODELS[agentId] ?? ["default"]).map((value) => <option key={value} value={value}>{modelLabel(agentId, value)}</option>)}
        </select></label>
        <label>Permission<select aria-label="Permission" value={permission} onChange={(event) => setPermission(event.target.value as QuickActionPermission)}>
          {QUICK_ACTION_AGENT_PERMISSIONS.map((value) => <option key={value} value={value}>{permissionLabel(agentId, value)}</option>)}
        </select></label>
        <label>Reasoning<select aria-label="Reasoning" value={reasoning} onChange={(event) => setReasoning(event.target.value as QuickActionReasoning)}>
          {QUICK_ACTION_AGENT_REASONING.map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <p className="agent-setup-resume"><Icon name="restart" />TermLoop resumes this improver first. These settings are used only when a new Session is required. Start fresh retires the previous conversation and launches a new one.</p>
      {availableAgents.length === 0 ? <p className="agent-setup-error" role="alert">No supported agent is currently available.</p> : null}
      {error ? <p className="agent-setup-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="secondary-button" disabled={running} onClick={props.close}>Cancel</button>
        <button type="button" className="secondary-button" disabled={running || availableAgents.length === 0}
          title="Retire the previous improver conversation and start a new one with these settings"
          onClick={() => void launch(true)}>Start fresh</button>
        <button type="submit" className="primary-button" disabled={running || availableAgents.length === 0}>{running ? "Opening…" : "Resume or start"}</button>
      </footer>
    </form>
  </div>;
}

function validModel(agentId: QuickActionAgentSelection["agentId"], model: string | undefined): string {
  return model && (QUICK_ACTION_AGENT_MODELS[agentId] ?? ["default"]).includes(model) ? model : "default";
}

function modelLabel(agentId: QuickActionAgentSelection["agentId"], model: string): string {
  if (model !== "default") return model;
  return agentId === "claude" ? "Default (recommended)" : "Default";
}
