import type { SettingsScopeContext } from "../settings-scope.js";

export function SettingsScopeLabel({ context, scope = "computer" }: {
  context?: SettingsScopeContext | undefined;
  scope?: "app" | "computer" | "project";
}) {
  if (!context) return null;
  return <span className="settings-scope-label">{scope === "app"
    ? "This app · This computer"
    : scope === "project" && context.projectName
      ? `Project: ${context.projectName} · ${context.computerName}`
      : `Computer: ${context.computerName}`}</span>;
}
