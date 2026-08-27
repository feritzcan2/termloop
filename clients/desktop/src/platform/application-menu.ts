import type { MenuItemConstructorOptions } from "electron";

// The application menu is per-OS: macOS keeps a small native menu because
// Cmd-based editing shortcuts only work through menu roles there, and the
// menu bar lives outside the window. On Windows and Linux the default menu's
// accelerators (Ctrl+C/V/W/R, Ctrl+Shift+I) fire before renderer key events
// and would shadow terminal control bytes — Ctrl+C would never reach the PTY
// as SIGINT — while Chromium already handles clipboard editing in ordinary
// inputs without menu roles. So the menu must be removed off macOS.
export function shouldRemoveApplicationMenu(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "darwin";
}

// Keep macOS's native editing shortcuts, but do not include Electron's default
// Reload item. That item claims Cmd+R before the renderer can use the shortcut.
export function applicationMenuTemplate(
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  if (platform !== "darwin") return [];
  return [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];
}
