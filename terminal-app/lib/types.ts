export interface TerminalTheme {
  id: string;
  name: string;
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    selectionForeground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export interface Connection {
  id: string;
  label: string;
  host: string;
  ssh: { port: number; user: string };
  termloop: { port: number };
  theme: string;
  lastConnected: number | null;
  /** True for rows promoted from the legacy SshConnection/TermLoopConnection
   *  shape. The list view shows them greyed out and blocks connect until
   *  the user opens the edit form and saves. */
  incomplete?: boolean;
}

/** Minimal validation: a Connection is "complete enough to connect" when
 *  host is non-empty and all required port/user fields are present. */
export function isCompleteConnection(c: Connection): boolean {
  if (!c.host.trim()) return false;
  if (!Number.isFinite(c.ssh.port) || c.ssh.port <= 0) return false;
  if (!c.ssh.user.trim()) return false;
  if (!Number.isFinite(c.termloop.port) || c.termloop.port <= 0) return false;
  return !c.incomplete;
}
