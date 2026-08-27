import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ContextBankCatalogItemDto, ContextBankCatalogResult } from "@termloop/contract/current";
import { Icon, type IconName } from "./Icon.js";
import { ContextBankConflictResolver } from "./ContextBankConflictResolver.js";
import { buildContextBankTree, type ContextBankTreeNode } from "./context-bank-tree.js";
import { useRailGroups } from "./rail-groups.js";

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function fileIcon(file: ContextBankCatalogItemDto): IconName {
  if (file.kind === "agents") return "fileGear";
  if (file.kind === "gemini") return "sparkles";
  return "fileText";
}

export function ContextBankRail({ projectOpen, load, refreshToken = 0, selectedFileId, openFile, resolveConflict }: {
  projectOpen: boolean;
  load(): Promise<ContextBankCatalogResult>;
  refreshToken?: number | undefined;
  selectedFileId: string | undefined;
  openFile(fileId: string): void;
  resolveConflict(conflictId: string, sourceFileId: string): Promise<ContextBankCatalogResult>;
}) {
  const [catalog, setCatalog] = useState<ContextBankCatalogResult>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [activeConflictId, setActiveConflictId] = useState<string>();
  const groups = useRailGroups();

  useEffect(() => {
    if (!projectOpen) {
      setCatalog(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    setActiveConflictId(undefined);
    setCatalog(undefined);
    setLoading(true);
    setError(undefined);
    void load().then((result) => {
      if (active) setCatalog(result);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, projectOpen, refreshToken, reloadToken]);

  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const tree = useMemo(() => {
    const files = (catalog?.files ?? []).filter((file) => !normalizedQuery || [
      file.relativePath,
      file.kind,
      file.symlinkTargetPath ?? "",
    ].join("\n").toLocaleLowerCase("en-US").includes(normalizedQuery));
    const visibleFileIds = new Set(files.map((file) => file.id));
    const conflicts = (catalog?.siblingConflicts ?? []).filter(
      (conflict) => conflict.fileIds.some((fileId) => visibleFileIds.has(fileId)),
    );
    return buildContextBankTree(files, conflicts, catalog?.projectName ?? "Project");
  }, [catalog?.files, catalog?.projectName, catalog?.siblingConflicts, normalizedQuery]);

  const renderNode = (node: ContextBankTreeNode): ReactNode => {
    if (node.kind === "folder") {
      const collapsed = !normalizedQuery && groups.collapsed(node.id, false);
      return <div className="context-tree-folder" key={`folder:${node.id}`}>
        <button
          className={`context-tree-folder-row${node.id === "/" ? " root" : ""}`}
          type="button"
          style={{ paddingInlineStart: 7 + node.depth * 12 }}
          aria-expanded={!collapsed}
          title={node.id === "/" ? catalog?.projectName : node.id}
          onClick={() => groups.toggle(node.id)}
        >
          <i aria-hidden="true" />
          <Icon name="folder" />
          <span>{node.label}</span>
        </button>
        {collapsed ? null : node.children.map(renderNode)}
      </div>;
    }

    if (node.kind === "conflict") {
      const files = node.conflict.fileIds
        .map((fileId) => catalog?.files.find((file) => file.id === fileId))
        .filter((file): file is ContextBankCatalogItemDto => file !== undefined);
      const active = activeConflictId === node.id;
      return <div className="context-tree-conflict" key={node.id}>
        <div className="context-tree-conflict-row" style={{ paddingInlineStart: 21 + node.depth * 12 }}>
          <Icon name="sparkles" />
          <span>Sibling instruction files differ.</span>
          <button type="button" disabled={files.length < 2} onClick={() => setActiveConflictId(active ? undefined : node.id)}>{active ? "Hide" : "Fix…"}</button>
        </div>
        {active ? <ContextBankConflictResolver
          key={node.id}
          conflict={node.conflict}
          files={files}
          resolve={resolveConflict}
          resolved={(nextCatalog) => {
            setCatalog(nextCatalog);
            setActiveConflictId(undefined);
          }}
          close={() => setActiveConflictId(undefined)}
        /> : null}
      </div>;
    }

    const { file } = node;
    const fillRatio = Math.min(file.lineCount / file.lineLimit, 1);
    const capacityTone = file.overLimit ? " over-limit" : fillRatio > 0.85 ? " near-limit" : "";
    return <button
      className={`context-tree-file${file.id === selectedFileId ? " selected" : ""}`}
      type="button"
      style={{ paddingInlineStart: 21 + node.depth * 12 }}
      aria-current={file.id === selectedFileId}
      title={file.relativePath}
      key={file.id}
      onClick={() => openFile(file.id)}
    >
      <Icon className={`context-tree-file-icon ${file.kind}`} name={fileIcon(file)} />
      <strong>{fileName(file.relativePath)}</strong>
      {file.isSymlink && file.symlinkTargetPath ? <span className="context-tree-link"><Icon name="link" />→ {file.symlinkTargetPath}</span> : null}
      {!file.isSymlink ? <span className={`context-tree-capacity${capacityTone}`} title={`${file.lineCount} of ${file.lineLimit} recommended lines`}>
        <span>{file.lineCount}/{file.lineLimit}</span>
        <i aria-hidden="true"><b style={{ width: `${fillRatio * 100}%` }} /></i>
      </span> : null}
    </button>;
  };

  return <nav className="settings-rail context-bank-rail" aria-label="Context Bank">
    <div className="settings-rail-toolbar">
      <label className="rail-search"><Icon name="search" /><input value={query} aria-label="Search Context Bank" placeholder="Search context" onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="icon-button quiet" type="button" title={loading ? "Scanning…" : "Rescan project"} aria-label="Rescan Context Bank" disabled={loading || !projectOpen} onClick={() => setReloadToken((current) => current + 1)}><Icon name="restart" /></button>
    </div>
    <p className="settings-rail-note"><Icon name="folder" /><span>Project instructions for Claude, Codex, and Gemini.</span></p>
    {!projectOpen ? <span className="settings-rail-empty">Open a Project to view its Context Bank.</span> : null}
    {error ? <p className="settings-rail-error" role="alert">Could not scan Context Bank: {error}</p> : null}
    {catalog?.warnings.map((warning) => <p className="context-bank-warning" role="status" key={warning}><Icon name="sparkles" />{warning}</p>)}
    <div className="context-tree">{tree.map(renderNode)}</div>
    {loading && !catalog ? <span className="settings-rail-empty">Scanning Project instructions…</span> : null}
    {catalog && !tree.length ? <span className="settings-rail-empty">{normalizedQuery ? "No context file matches this search." : "No CLAUDE.md, AGENTS.md, or GEMINI.md files found."}</span> : null}
    {catalog?.truncated ? <p className="context-bank-warning" role="status">Scan limited for safety; some files are not shown.</p> : null}
  </nav>;
}
