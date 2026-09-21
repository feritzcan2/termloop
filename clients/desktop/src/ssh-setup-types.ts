import type { ConnectionProfileConnectResult } from "./connection-profile-types.js";

export type SshSetupInput = { address: string; name?: string; user?: string; sshPort?: number };
export type SshSetupLogin = { id: string; fingerprint: string; password?: string; passphrase?: string };
export type SshSetupState = {
  id: string;
  name: string;
  host: string;
  user: string;
  sshPort: number;
  fingerprint: string;
  phase: "checking" | "identity" | "login" | "review" | "installing" | "ready" | "error";
  message: string;
  steps: string[];
  busy?: boolean;
  installed?: boolean;
  needsAdmin?: boolean;
  version?: string;
};

export type SshSetupActions = {
  current(): Promise<SshSetupState | null>;
  start(input: SshSetupInput): Promise<SshSetupState>;
  login(input: SshSetupLogin): Promise<SshSetupState>;
  install(id: string): Promise<SshSetupState>;
  status(id: string): Promise<SshSetupState>;
  connect(id: string): Promise<ConnectionProfileConnectResult>;
  cancel(id: string): Promise<void>;
  choosePackage(id: string): Promise<SshSetupState>;
};

export function isSshHost(host: string): boolean {
  return host.length <= 255 && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|[0-9a-fA-F]*:[0-9a-fA-F:]+)$/.test(host);
}

// Deliberately accepts addresses and the small, familiar SSH command form only.
// SSH flags, shell syntax and URLs containing passwords never become commands.
export function parseSshSetupAddress(input: SshSetupInput): { host: string; user?: string; port?: number; name: string } {
  if (!input || typeof input.address !== "string" || input.address.length > 512) throw new Error("Enter a server address or an SSH command.");
  let address = input.address.trim();
  let port = input.sshPort;
  let user = input.user?.trim() || undefined;
  if (address.startsWith("ssh ")) {
    const match = /^ssh\s+(?:-p\s+(\d+)\s+)?([^\s]+)$/.exec(address);
    if (!match) throw new Error("Use ssh user@host or ssh -p 2222 user@host. Additional SSH options are not supported here.");
    address = match[2]!;
    if (match[1] && port === undefined) port = Number(match[1]);
  }
  if (address.startsWith("ssh://")) {
    const match = /^ssh:\/\/(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d+))?\/?$/.exec(address);
    if (!match) throw new Error("Enter an SSH address without a password, path or query.");
    user ??= match[1];
    address = match[2]!;
    if (port === undefined && match[3]) port = Number(match[3]);
  } else if (address.includes("@")) {
    const parts = address.split("@");
    if (parts.length !== 2) throw new Error("Enter a valid user@host address.");
    user ??= parts[0];
    address = parts[1]!;
  }
  const host = address.replace(/^\[([0-9a-fA-F:]+)\]$/, "$1");
  if (!isSshHost(host)) throw new Error("Enter a valid hostname or IP address.");
  if (user && (user.length > 64 || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user))) throw new Error("Enter a valid SSH username.");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("SSH port must be between 1 and 65535.");
  const name = input.name?.trim() || host;
  if (name.length > 80) throw new Error("Server name must be no longer than 80 characters.");
  return { host, ...(user ? { user } : {}), ...(port !== undefined ? { port } : {}), name };
}
