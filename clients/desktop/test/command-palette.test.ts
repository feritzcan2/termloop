import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShellCommand } from "../src/renderer/command-surface.js";
import { CommandPalette, KeyboardShortcutsDialog } from "../src/renderer/ui/CommandPalette.js";

const commands: ShellCommand[] = [
  {
    id: "launch.terminal",
    title: "New Terminal",
    detail: "Launch in the selected Project.",
    group: "Launch",
    shortcutId: "newTerminal",
    perform: vi.fn(),
  },
  {
    id: "session.dismiss",
    title: "Terminate Selected Session",
    detail: "End its process explicitly.",
    group: "Session",
    danger: true,
    disabled: true,
    perform: vi.fn(),
  },
];

describe("command palette presentation", () => {
  it("renders a labelled modal listbox with visible platform shortcut hints", () => {
    const markup = renderToStaticMarkup(createElement(CommandPalette, { commands, platform: "mac", close: vi.fn() }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("⌘T");
    expect(markup).toContain("Shift Shift opens Quick Action");
    expect(markup).toContain('class="danger"');
    expect(markup).toContain("disabled");
  });

  it("exposes keyboard settings as a real accessible surface", () => {
    const markup = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, { platform: "windows", close: vi.fn() }));
    expect(markup).toContain("Keyboard shortcuts");
    expect(markup).toContain("Ctrl+Shift+P");
    expect(markup).toContain("Ctrl+Alt+←");
    expect(markup).toContain('aria-label="Close keyboard settings"');
  });
});
