import type { SettingsScopeContext } from "../settings-scope.js";
import { SettingsScopeLabel } from "./SettingsScopeLabel.js";

const titles = {
  agents: "Agent library",
  skills: "Skills",
  context: "Context",
};

/** State ownership before the user opens an editor, including mixed libraries. */
export function LibraryScopeHeader({ section, context }: {
  section: keyof typeof titles;
  context?: SettingsScopeContext | undefined;
}) {
  if (!context) return null;
  return <header className="library-scope-header" aria-label={`${titles[section]} scope`}>
    <strong>{titles[section]}</strong>
    {section === "skills" ? <>
      <span>Personal &amp; provider skills: {context.computerName}</span>
      {context.projectName ? <span>Project skills: {context.projectName} · {context.computerName}</span> : null}
    </> : section === "context" && !context.projectName ? <span>No project selected</span> : (
      <SettingsScopeLabel context={context} scope={section === "context" ? "project" : "computer"} />
    )}
  </header>;
}
