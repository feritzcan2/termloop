import { useEffect, useState } from "react";
import type { AgentLaunchPreviewResult, InspectableLaunchManifest } from "@termloop/contract/current";
import type { ReactNode } from "react";

export function AgentLaunchInspector({ title, preview, launch, close }: {
  title: string;
  preview(): Promise<AgentLaunchPreviewResult>;
  launch(launchTicket: string): Promise<string | undefined>;
  close(): void;
}) {
  const [result, setResult] = useState<AgentLaunchPreviewResult>();
  const [tab, setTab] = useState<"preview" | "raw">("preview");
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let live = true;
    void preview()
      .then((value) => {
        if (!value || typeof value.launch_ticket !== "string" || !value.manifest) {
          throw new Error("Launch preview returned an invalid manifest.");
        }
        if (live) setResult(value);
      })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [preview]);

  const confirm = async () => {
    if (!result || running) return;
    setRunning(true);
    try {
      const message = await launch(result.launch_ticket);
      if (message) setError(message); else close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return <div className="quick-action-layer" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && result) { event.preventDefault(); void confirm(); }
  }}>
    <button className="quick-action-backdrop" type="button" aria-label="Dismiss launch inspector" onClick={close} />
    <section className="quick-action advanced-open" role="dialog" aria-modal="true" aria-labelledby="agent-launch-inspector-title">
      <header className="quick-action-header">
        <div className="quick-action-kind-slot"><div className="quick-action-kind"><span aria-hidden="true">◎</span><strong id="agent-launch-inspector-title">{title}</strong></div></div>
      </header>
      <section className="quick-action-preview">
        {error ? <p role="alert">{error}</p> : <>
          <nav className="quick-action-inspector-tabs" aria-label="Launch inspector views">
            <button type="button" className={tab === "preview" ? "active" : undefined} onClick={() => setTab("preview")}>Preview</button>
            <button type="button" className={tab === "raw" ? "active" : undefined} onClick={() => setTab("raw")}>Raw</button>
            {result ? <code>{result.manifest.digest.slice(0, 19)}…</code> : null}
          </nav>
          {result ? <LaunchManifestView manifest={result.manifest} tab={tab} /> : <pre>Resolving exact launch manifest…</pre>}
        </>}
      </section>
      <footer><strong>termloop</strong>{running ? <em>launching…</em> : null}<button type="button" disabled={!result || running} onClick={() => void confirm()}>Launch</button><span><kbd>↵</kbd> launch</span><span><kbd>esc</kbd> dismiss</span></footer>
    </section>
  </div>;
}

function LaunchManifestView({ manifest, tab }: { manifest: InspectableLaunchManifest; tab: "preview" | "raw" }) {
  if (tab === "raw") {
    const command = [manifest.target.executable, ...manifest.arguments.map((argument) => argument.display)].join(" ");
    return <div className="launch-inspector-raw">
      <Block title="Full command"><pre>{command}</pre></Block>
      <Block title="Environment"><pre>{manifest.environment.map((entry) => `${entry.key}=${entry.display_value}`).join("\n") || "(none)"}</pre></Block>
      <Block title="Generated files"><pre>{manifest.generated_files.length ? manifest.generated_files.map((file) => `${file.purpose} · ${file.delivery}\n${file.content}`).join("\n\n") : "(none)"}</pre></Block>
      <Block title="Initial terminal input (escaped)"><pre>{manifest.transport.delivered_content ? JSON.stringify(manifest.transport.delivered_content) : "(none)"}</pre></Block>
    </div>;
  }
  return <div className="launch-inspector-grid">
    <Block title="Launch settings"><dl><dt>Agent</dt><dd>{manifest.target.agent_id}</dd><dt>Model</dt><dd>{manifest.target.model}</dd><dt>Permission</dt><dd>{manifest.target.permission}</dd><dt>Reasoning</dt><dd>{manifest.target.reasoning}</dd><dt>Directory</dt><dd>{manifest.target.cwd}</dd><dt>Conversation</dt><dd>{manifest.target.conversation}</dd></dl></Block>
    <Block title="Provenance"><dl><dt>Template</dt><dd>{manifest.provenance.template_ref}@{manifest.provenance.template_version}</dd><dt>Delivery</dt><dd>{manifest.transport.kind}</dd></dl></Block>
    <Block title={`Sent content · ${manifest.content_parts.length}`}>{manifest.content_parts.length ? manifest.content_parts.map((part) => <article key={part.id}><header><strong>{part.kind}</strong><span>{part.source} · {part.delivery} · {part.byte_length} bytes</span></header><pre>{part.content}</pre></article>) : <p>No TermLoop-authored message or system instruction is delivered.</p>}</Block>
    <Block title={`Arguments · ${manifest.arguments.length}`}>{manifest.arguments.length ? <ol>{manifest.arguments.map((argument) => <li key={argument.position}><code>{argument.display}</code><small>{argument.classification} · {argument.purpose}</small></li>)}</ol> : <p>No agent arguments.</p>}</Block>
    <Block title={`Environment · ${manifest.environment.length}`}><ul>{manifest.environment.map((entry) => <li key={entry.key}><code>{entry.key}={entry.display_value}</code><small>{entry.classification} · {entry.source} · {entry.purpose}</small></li>)}</ul></Block>
    <Block title="Provider visibility"><ul>{manifest.limitations.map((limitation) => <li key={limitation.kind}><strong>{limitation.kind}</strong><span>{limitation.description}</span></li>)}</ul></Block>
  </div>;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="wide"><h3>{title}</h3>{children}</section>;
}
