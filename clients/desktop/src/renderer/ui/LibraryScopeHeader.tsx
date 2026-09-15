import type { SettingsScopeContext } from "../settings-scope.js";
import { SettingsScopeLabel } from "./SettingsScopeLabel.js";

const titles = {
  agents: "Agent library",
  mcp: "MCP tools",
  prompts: "Prompts",
  skills: "Skills",
  context: "Context",
};

/** State ownership before the user opens an editor, including mixed libraries. */
export function LibraryScopeHeader({ section, context }: {
  section: keyof typeof titles | "workspace";
  context?: SettingsScopeContext | undefined;
}) {
  if (!context || section === "workspace") return null;
  return <header className="library-scope-header" aria-label={`${titles[section]} scope`}>
    <strong>{titles[section]}</strong>
    {section === "prompts" ? <>
      <span>Built-in prompts: This app · This computer</span>
      {context.projectName ? <span>Project prompts: {context.projectName} · {context.computerName}</span> : null}
    </> : section === "skills" ? <>
      <span>Personal &amp; provider skills: {context.computerName}</span>
      {context.projectName ? <span>Project skills: {context.projectName} · {context.computerName}</span> : null}
    </> : section === "context" && !context.projectName ? <span>No project selected</span> : (
      <SettingsScopeLabel context={context} scope={section === "context" ? "project" : "computer"} />
    )}
  </header>;
}
