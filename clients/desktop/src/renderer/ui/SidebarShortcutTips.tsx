import { projectShortcutLabel, PROJECT_SHORTCUT_LIMIT, shortcutLabel, type KeyboardPlatform } from "../command-surface.js";

/// Below this many Agent and Terminal rows the Agents view leaves the lower
/// sidebar empty, so that space teaches the shell shortcuts instead.
export const SIDEBAR_SHORTCUT_TIPS_ROW_LIMIT = 8;

export function sidebarShortcutTipsVisible(rowCount: number): boolean {
  return rowCount < SIDEBAR_SHORTCUT_TIPS_ROW_LIMIT;
}

export type SidebarShortcutTip = { label: string; keys: string };

export function sidebarShortcutTips(platform: KeyboardPlatform): SidebarShortcutTip[] {
  return [
    { label: "Fork agent", keys: shortcutLabel("forkSession", platform) },
    { label: "Switch Project", keys: `${projectShortcutLabel(0, platform)!}–${PROJECT_SHORTCUT_LIMIT}` },
    { label: "New terminal", keys: shortcutLabel("newTerminal", platform) },
    { label: "Quick Action", keys: "Shift Shift" },
    { label: "Rename session", keys: shortcutLabel("renameSession", platform) },
    { label: "Command palette", keys: shortcutLabel("commandPalette", platform) },
  ];
}

/// Purely presentational: the shortcuts themselves are handled by Shell.
export function SidebarShortcutTips({ platform }: { platform: KeyboardPlatform }) {
  return (
    <section className="sidebar-shortcut-tips" aria-label="Keyboard shortcuts">
      <header>Shortcuts</header>
      <dl>{sidebarShortcutTips(platform).map((tip) => <div key={tip.label}>
        <dt>{tip.label}</dt>
        <dd><kbd>{tip.keys}</kbd></dd>
      </div>)}</dl>
    </section>
  );
}
