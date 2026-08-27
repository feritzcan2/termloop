import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AgentCapabilityDto, QuickActionPreviewResult } from "@termloop/contract/current";
import type { QuickActionImageHandle } from "../../quick-action-image.js";
import type { Project } from "../model.js";
import {
  defaultAgentPermission,
  permissionLabel,
  readQuickActionMemory,
  rememberQuickActionAttachment,
  rememberQuickActionDraft,
  rememberQuickActionRun,
  QUICK_ACTION_AGENT_MODELS,
  QUICK_ACTION_AGENT_PERMISSIONS,
  QUICK_ACTION_AGENT_REASONING,
  type QuickActionAgentId as AgentId,
  type QuickActionPermission as Permission,
  type QuickActionReasoning as Reasoning,
} from "../quick-action-memory.js";
import { requireQuickActionPreview } from "../quick-action-result.js";

export const QUICK_ACTION_MODELS = QUICK_ACTION_AGENT_MODELS;
export const QUICK_ACTION_PERMISSIONS = QUICK_ACTION_AGENT_PERMISSIONS;
export const QUICK_ACTION_REASONING = QUICK_ACTION_AGENT_REASONING;

const modelLabel = (agentId: AgentId, model: string) => agentId === "claude" ? ({
  default: "Default (recommended)",
  "opus[1m]": "Opus (1M context)",
  fable: "Fable",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
}[model] ?? model) : model;

// The legacy panel truncates the run folder in the middle so the project root
// and the leaf directory both stay readable. The budget is the widest path the
// header keeps on one line at 11px monospaced.
// The tail keeps the leaf directory whole; the head takes whatever the budget
// has left once the ellipsis is paid for, so the result always fits the budget.
const PATH_BUDGET = 38;
const PATH_TAIL = 15;
const middleTruncate = (path: string) => path.length <= PATH_BUDGET
  ? path
  : `${path.slice(0, PATH_BUDGET - PATH_TAIL - 1)}…${path.slice(-PATH_TAIL)}`;

const ChevronDown = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>;
const FolderGlyph = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.9 4.3c0-.6.4-1 1-1h3l1.3 1.5h5c.5 0 1 .4 1 1v6c0 .6-.5 1-1 1H2.9c-.6 0-1-.4-1-1V4.3Z" /></svg>;
const PuzzleGlyph = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.1 2.7a1.7 1.7 0 0 1 3.4 0v1h2.3c.4 0 .7.3.7.7v2.3h1a1.7 1.7 0 0 1 0 3.4h-1v2.3c0 .4-.3.7-.7.7H9.5v-1a1.7 1.7 0 0 0-3.4 0v1H3.8a.7.7 0 0 1-.7-.7V4.4c0-.4.3-.7.7-.7h2.3v-1Z" /></svg>;

export function QuickActionComposer({ projects, selectedProject, capabilities, initialAgent, pasteImage, restoreImage, discardImage, preview, launch, close }: {
  projects: readonly Project[];
  selectedProject: Project | undefined;
  capabilities: readonly AgentCapabilityDto[];
  initialAgent?: AgentId;
  pasteImage(projectId: string): Promise<QuickActionImageHandle>;
  restoreImage(attachmentId: string): Promise<QuickActionImageHandle>;
  discardImage(attachmentId: string): Promise<void>;
  preview(projectId: string, agentId: AgentId, model: string, permission: Permission, reasoning: Reasoning, prompt: string, attachmentIds: string[]): Promise<QuickActionPreviewResult>;
  launch(projectId: string, agentId: AgentId, model: string, permission: Permission, reasoning: Reasoning, prompt: string, attachmentIds: string[], launchTicket: string): Promise<string | undefined>;
  close(): void;
}) {
  const availableCapabilities = useMemo(() => capabilities
    .filter((capability) => capability.available && capability.quick_action_supported), [capabilities]);
  const availableAgents = useMemo(() => availableCapabilities
    .map((capability) => capability.agent_id as AgentId), [availableCapabilities]);
  const capabilityByAgent = useMemo(() => new Map(availableCapabilities
    .map((capability) => [capability.agent_id, capability] as const)), [availableCapabilities]);
  const memory = useMemo(readQuickActionMemory, []);
  const restoredAgent = initialAgent && availableAgents.includes(initialAgent) ? initialAgent
    : memory.lastAgentId && availableAgents.includes(memory.lastAgentId) ? memory.lastAgentId : undefined;
  const initialAgentId = restoredAgent ?? availableAgents[0] ?? "codex";
  const initialPreset = memory.presets[initialAgentId];
  const initialCapability = capabilityByAgent.get(initialAgentId);
  // Quick Action opens against the Project the user is looking at. The last-run
  // Project is only a fallback for the no-selection case; letting it win sent
  // prompts typed in one Project to whichever Project ran last.
  const [projectId, setProjectId] = useState(() => selectedProject?.id
    ?? (projects.some((project) => project.id === memory.projectId) ? memory.projectId : undefined)
    ?? projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState<AgentId>(initialAgentId);
  const [model, setModel] = useState(() => initialPreset?.model && initialCapability?.models.includes(initialPreset.model)
    ? initialPreset.model : "default");
  const [permission, setPermission] = useState<Permission>(initialPreset?.permission
    && initialCapability?.permissions.includes(initialPreset.permission)
    ? initialPreset.permission : defaultAgentPermission(initialAgentId));
  const [reasoning, setReasoning] = useState<Reasoning>(initialPreset?.reasoning
    && initialCapability?.reasoning.includes(initialPreset.reasoning)
    ? initialPreset.reasoning : "default");
  const [prompt, setPrompt] = useState(() => memory.draft ?? "");
  const [attachment, setAttachment] = useState<QuickActionImageHandle | undefined>(() => memory.draftAttachment);
  const [attachmentReady, setAttachmentReady] = useState(() => !memory.draftAttachment);
  const [previewResult, setPreviewResult] = useState<QuickActionPreviewResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"preview" | "raw">("preview");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const attachmentRef = useRef<QuickActionImageHandle | undefined>(memory.draftAttachment);
  const priorAgentRef = useRef(agentId);
  const selectedCapability = capabilityByAgent.get(agentId);
  const models = selectedCapability?.models ?? ["default"];
  const permissions = selectedCapability?.permissions ?? ["default"];
  const reasoningOptions = selectedCapability?.reasoning ?? ["default"];
  const attachmentIds = useMemo(() => attachment ? [attachment.id] : [], [attachment]);

  useEffect(() => { requestAnimationFrame(() => promptRef.current?.focus()); }, []);
  useEffect(() => { rememberQuickActionDraft(prompt); }, [prompt]);
  useEffect(() => {
    const saved = memory.draftAttachment;
    if (!saved) return;
    let live = true;
    void restoreImage(saved.id)
      .then((restored) => {
        if (!live || attachmentRef.current?.id !== saved.id) return;
        attachmentRef.current = restored;
        setAttachment(restored);
        setAttachmentReady(true);
        rememberQuickActionAttachment(restored);
      })
      .catch((cause) => {
        if (!live || attachmentRef.current?.id !== saved.id) return;
        attachmentRef.current = undefined;
        setAttachment(undefined);
        setAttachmentReady(true);
        rememberQuickActionAttachment(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { live = false; };
  }, [memory.draftAttachment, restoreImage]);
  useEffect(() => {
    if (priorAgentRef.current === agentId) return;
    priorAgentRef.current = agentId;
    const preset = memory.presets[agentId];
    const capability = capabilityByAgent.get(agentId);
    setModel(preset?.model && capability?.models.includes(preset.model) ? preset.model : "default");
    setPermission(preset?.permission && capability?.permissions.includes(preset.permission)
      ? preset.permission : defaultAgentPermission(agentId));
    setReasoning(preset?.reasoning && capability?.reasoning.includes(preset.reasoning)
      ? preset.reasoning : "default");
    setPreviewResult(undefined);
  }, [agentId, capabilityByAgent, memory.presets]);
  useEffect(() => {
    if (!projectId || !prompt || !attachmentReady) { setPreviewResult(undefined); if (attachmentReady) setError(undefined); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      void preview(projectId, agentId, model, permission, reasoning, prompt, attachmentIds)
        .then((value) => {
          const result = requireQuickActionPreview(value);
          if (live) { setPreviewResult(result); setError(undefined); }
        })
        .catch((cause) => { if (live) { setPreviewResult(undefined); setError(cause instanceof Error ? cause.message : String(cause)); } });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [agentId, attachmentIds, attachmentReady, model, permission, preview, projectId, prompt, reasoning]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!projectId || !prompt || !attachmentReady || running) return;
    setRunning(true);
    try {
      const inspected = requireQuickActionPreview(await preview(projectId, agentId, model, permission, reasoning, prompt, attachmentIds));
      setPreviewResult(inspected);
      const message = await launch(projectId, agentId, model, permission, reasoning, prompt, attachmentIds, inspected.launch_ticket);
      if (message) setError(message); else {
        rememberQuickActionRun(projectId, agentId, { model, permission, reasoning });
        close();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setAdvancedOpen((open) => !open); }
  };
  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.getData("text/plain")) return;
    if (![...event.clipboardData.items].some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
    event.preventDefault();
    if (attachmentRef.current) {
      setError("Quick Action currently supports one image attachment.");
      return;
    }
    try {
      const staged = await pasteImage(projectId);
      attachmentRef.current = staged;
      setAttachment(staged);
      setAttachmentReady(true);
      rememberQuickActionAttachment(staged);
      setPrompt((current) => current || "Inspect the attached image.");
      setPreviewResult(undefined);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const removeAttachment = async () => {
    const current = attachmentRef.current;
    if (!current) return;
    attachmentRef.current = undefined;
    setAttachment(undefined);
    setAttachmentReady(true);
    rememberQuickActionAttachment(undefined);
    setPreviewResult(undefined);
    await discardImage(current.id);
  };

  return (
    <div className="quick-action-layer" onKeyDown={keyDown}>
      <button className="quick-action-backdrop" type="button" aria-label="Dismiss Quick Action" onClick={close} />
      <form className={`quick-action${advancedOpen || error ? " advanced-open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="quick-action-title" onSubmit={submit}>
        <header className="quick-action-header">
          <div className="quick-action-kind-slot">
            <div className="quick-action-kind"><span aria-hidden="true">✎</span><strong id="quick-action-title">Free prompt</strong><i /><small>default</small><b><ChevronDown /></b></div>
          </div>
          <label>Run in:
            <select aria-label="Run in Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.connectionProfileName ? ` · ${project.connectionProfileName}` : ""}</option>)}
            </select>
            <b><ChevronDown /></b>
            <span>·</span><code><FolderGlyph />{middleTruncate(projects.find((project) => project.id === projectId)?.folder_path ?? "")}</code>
          </label>
        </header>
        <div className="quick-action-target">
          <div className="quick-action-segmented">
            <button type="button" className="active">Run</button>
            <button type="button" disabled title="Task worktree targeting follows in a separate packet">Worktree</button>
          </div>
        </div>
        <main className="quick-action-body">
          <label htmlFor="quick-action-prompt">Prompt</label>
          <textarea ref={promptRef} id="quick-action-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={(event) => { void paste(event); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void submit(); } }} placeholder="What would you like to run? Paste an image with ⌘V." spellCheck={false} />
          {attachment ? <div className="quick-action-attachment">
            <img src={attachment.previewDataUrl} alt="Pasted Quick Action attachment" />
            <span><strong>Image</strong><small>{attachment.width}×{attachment.height} · {formatBytes(attachment.byteLength)}</small></span>
            <button type="button" aria-label="Remove pasted image" onClick={() => { void removeAttachment(); }}>×</button>
          </div> : null}
        </main>
        <div className="quick-action-options">
          <label className="agent"><span>AGENT</span><em aria-hidden="true">{agentId}</em><select aria-label="Agent" value={agentId} onChange={(event) => setAgentId(event.target.value as AgentId)}>{availableAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select></label>
          <label className={permission === "bypassPermissions" ? "danger" : permission === "plan" ? "plan" : permission === "acceptEdits" ? "accept" : undefined}><span>PERM</span><em aria-hidden="true">{permissionLabel(agentId, permission)}</em><select aria-label="Permission" value={permission} onChange={(event) => setPermission(event.target.value as Permission)}>{permissions.map((value) => <option key={value} value={value}>{permissionLabel(agentId, value as Permission)}</option>)}</select></label>
          <label><span>MODEL</span><em aria-hidden="true">{modelLabel(agentId, model)}</em><select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>{models.map((value) => <option key={value} value={value}>{modelLabel(agentId, value)}</option>)}</select></label>
          <label><span>REASON</span><em aria-hidden="true">{reasoning}</em><select aria-label="Reasoning" value={reasoning} onChange={(event) => setReasoning(event.target.value as Reasoning)}>{reasoningOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          {memory.presets[agentId] ? <small>restored from last run</small> : null}
        </div>
        <button className="quick-action-advanced-row" type="button" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}><span aria-hidden="true"><PuzzleGlyph /></span><strong>Advanced {attachment ? 1 : 0}</strong><small>· project</small><i /> <em>{attachment ? "1 image attachment ·" : "No project rules ·"}</em><b>Advanced</b></button>
        {advancedOpen || error ? <section className="quick-action-preview">
          {error ? <p role="alert">{error}</p> : <>
            <nav className="quick-action-inspector-tabs" aria-label="Launch inspector views">
              <button type="button" className={inspectorTab === "preview" ? "active" : undefined} onClick={() => setInspectorTab("preview")}>Preview</button>
              <button type="button" className={inspectorTab === "raw" ? "active" : undefined} onClick={() => setInspectorTab("raw")}>Raw</button>
              {previewResult ? <code>{previewResult.manifest.digest.slice(0, 19)}…</code> : null}
            </nav>
            {previewResult
              ? inspectorTab === "preview" ? <LaunchPreview result={previewResult} /> : <LaunchRaw result={previewResult} />
              : <pre>Enter a prompt to inspect the exact launch manifest.</pre>}
          </>}
        </section> : null}
        <footer><strong>termloop</strong>{running ? <em>launching…</em> : null}<span><kbd>↵</kbd> run</span><span><kbd>⌘K</kbd> template</span><span><kbd>⌘↵</kbd> advanced</span><span><kbd>esc</kbd> dismiss</span></footer>
      </form>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LaunchPreview({ result }: { result: QuickActionPreviewResult }) {
  const manifest = result.manifest;
  return <div className="launch-inspector-grid">
    <InspectorBlock title="Launch settings"><dl>
      <dt>Agent</dt><dd>{manifest.target.agent_id}</dd><dt>Model</dt><dd>{manifest.target.model}</dd>
      <dt>Permission</dt><dd>{manifest.target.permission}</dd><dt>Reasoning</dt><dd>{manifest.target.reasoning}</dd>
      <dt>Directory</dt><dd>{manifest.target.cwd}</dd><dt>Conversation</dt><dd>{manifest.target.conversation}</dd>
    </dl></InspectorBlock>
    <InspectorBlock title="Provenance"><dl>
      <dt>Template</dt><dd>{manifest.provenance.template_ref}@{manifest.provenance.template_version}</dd>
      <dt>Delivery</dt><dd>{manifest.transport.kind}</dd><dt>Bytes</dt><dd>{manifest.transport.byte_length}</dd>
    </dl></InspectorBlock>
    <InspectorBlock title={`Sent content · ${manifest.content_parts.length}`} wide>{manifest.content_parts.length
      ? manifest.content_parts.map((part) => <article key={part.id}><header><strong>{part.kind}</strong><span>{part.source} · {part.delivery} · {part.byte_length} bytes</span></header><pre>{part.content}</pre></article>)
      : <p>No TermLoop-authored message or system instruction is delivered.</p>}</InspectorBlock>
    <InspectorBlock title={`Arguments · ${manifest.arguments.length}`}>{manifest.arguments.length
      ? <ol>{manifest.arguments.map((argument) => <li key={argument.position}><code>{argument.display}</code><small>{argument.classification} · {argument.purpose}</small></li>)}</ol>
      : <p>No agent arguments.</p>}</InspectorBlock>
    <InspectorBlock title={`Environment · ${manifest.environment.length}`}><ul>{manifest.environment.map((entry) => <li key={entry.key}><code>{entry.key}={entry.display_value}</code><small>{entry.classification} · {entry.source} · {entry.purpose}</small></li>)}</ul></InspectorBlock>
    <InspectorBlock title="Provider visibility" wide><ul>{manifest.limitations.map((limitation) => <li key={limitation.kind}><strong>{limitation.kind}</strong><span>{limitation.description}</span></li>)}</ul></InspectorBlock>
  </div>;
}

function LaunchRaw({ result }: { result: QuickActionPreviewResult }) {
  const manifest = result.manifest;
  const command = [manifest.target.executable, ...manifest.arguments.map((argument) => argument.display)].join(" ");
  return <div className="launch-inspector-raw">
    <InspectorBlock title="Full command" wide><pre>{command}</pre></InspectorBlock>
    <InspectorBlock title="Environment" wide><pre>{manifest.environment.map((entry) => `${entry.key}=${entry.display_value}`).join("\n") || "(none)"}</pre></InspectorBlock>
    <InspectorBlock title="Generated files" wide><pre>{manifest.generated_files.length ? manifest.generated_files.map((file) => `${file.purpose} · ${file.delivery}\n${file.content}`).join("\n\n") : "(none)"}</pre></InspectorBlock>
    <InspectorBlock title="Initial terminal input (escaped)" wide><pre>{manifest.transport.delivered_content ? JSON.stringify(manifest.transport.delivered_content) : "(none)"}</pre></InspectorBlock>
  </div>;
}

function InspectorBlock({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return <section className={wide ? "wide" : undefined}><h3>{title}</h3>{children}</section>;
}
