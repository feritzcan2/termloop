import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { devNull } from "node:os";

const MAX_LOCAL_PORT_ATTEMPTS = 3;
let foregroundOptionSupport: Promise<boolean> | undefined;

export type SshTunnelRequest = {
  host: string;
  user?: string;
  remotePort: number;
  sshPort?: number;
  identityFile?: string;
  knownHostsFile?: string;
};

export type SshTunnelProcess = {
  localPort: number;
  onExit(listener: () => void): void;
  stop(): void;
};

export class SshRuntimeError extends Error {
  constructor(
    readonly code: "sshUnavailable" | "sshHostKeyMismatch" | "sshHostKeyUnknown"
      | "sshHostKeyRejected" | "sshAuthenticationFailed" | "sshHostUnresolved"
      | "sshReadinessTimedOut" | "sshForwardFailed",
    message: string,
  ) {
    super(message);
    this.name = "SshRuntimeError";
  }
}

export async function spawnSshTunnel(request: SshTunnelRequest): Promise<SshTunnelProcess> {
  // Validate before starting even the capability probe.
  sshTunnelArgs(request, 1);
  const supportsForegroundOption = await supportsForkAfterAuthentication();
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt += 1) {
    const localPort = await reserveLoopbackPort();
    const child = spawn("ssh", sshTunnelArgs(request, localPort, supportsForegroundOption), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192);
    });
    // Register before exit: Node may deliver the final stderr bytes after exit.
    let closed = false;
    const onClose = () => { closed = true; };
    child.once("close", onClose);
    try {
      await waitForTunnel(child, localPort);
      return runningTunnel(child, localPort);
    } catch (error) {
      child.kill();
      if (!closed) await waitForProcessClose(child);
      const classified = classifySshFailure(error, stderr);
      if (classified) throw classified;
      if (attempt < MAX_LOCAL_PORT_ATTEMPTS && isSshLocalForwardBindFailure(stderr)) continue;
      throw new SshRuntimeError("sshForwardFailed", "SSH port forwarding could not be established");
    } finally {
      child.off("close", onClose);
    }
  }
  throw new SshRuntimeError("sshForwardFailed", "SSH port forwarding could not be established");
}

function supportsForkAfterAuthentication(): Promise<boolean> {
  foregroundOptionSupport ??= new Promise<boolean>((resolve, reject) => {
    // -G does not connect; an empty config also avoids user Match exec commands.
    // The option was added in OpenSSH 8.7. Older clients cannot enable it either.
    execFile("ssh", ["-G", "-F", devNull, "-o", "ForkAfterAuthentication=no", "-N", "probe.invalid"], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) resolve(true);
      else if (/bad configuration option:\s*forkafterauthentication\b/i.test(stderr)) resolve(false);
      else reject(classifySshFailure(error, stderr)
        ?? new SshRuntimeError("sshForwardFailed", "OpenSSH client configuration could not be checked"));
    });
  }).catch((error) => {
    foregroundOptionSupport = undefined;
    throw error;
  });
  return foregroundOptionSupport;
}

function classifySshFailure(error: unknown, stderr: string): SshRuntimeError | undefined {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new SshRuntimeError("sshUnavailable", "OpenSSH client is not installed or is not on PATH");
  }
  if (/remote host identification has changed|offending .* key in/i.test(stderr)) {
    return new SshRuntimeError("sshHostKeyMismatch", "SSH host key changed; verify the server identity before updating its trusted key outside TermLoop");
  }
  if (/no .* host key is known for .*strict checking/i.test(stderr)) {
    return new SshRuntimeError("sshHostKeyUnknown", "SSH host key is not trusted yet; verify and trust this server using OpenSSH outside TermLoop");
  }
  if (/host key verification failed/i.test(stderr)) {
    return new SshRuntimeError("sshHostKeyRejected", "SSH host key could not be verified; check the server identity and trusted keys outside TermLoop");
  }
  if (/permission denied \(|too many authentication failures/i.test(stderr)) {
    return new SshRuntimeError("sshAuthenticationFailed", "SSH authentication failed; check the user and SSH key, and unlock or load the key in your SSH agent");
  }
  if (/could not resolve hostname/i.test(stderr)) {
    return new SshRuntimeError("sshHostUnresolved", "SSH host could not be resolved; check the host name, SSH configuration, and network connection");
  }
  if (error instanceof SshRuntimeError) return error;
  return undefined;
}

async function waitForProcessClose(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    child.once("close", finish);
  });
}

function runningTunnel(child: ChildProcess, localPort: number): SshTunnelProcess {
  return {
    localPort,
    onExit(listener) {
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(listener);
        return;
      }
      let notified = false;
      const notify = () => {
        if (notified) return;
        notified = true;
        child.off("exit", notify);
        child.off("error", notify);
        listener();
      };
      child.once("exit", notify);
      // A post-spawn ChildProcess error must not become an unhandled EventEmitter
      // error; the transport manager treats it exactly like tunnel exit.
      child.once("error", notify);
    },
    stop() { if (child.exitCode === null && child.signalCode === null) child.kill(); },
  };
}

export function isSshLocalForwardBindFailure(stderr: string): boolean {
  return /address already in use|cannot listen to port|could not request local forwarding/i.test(stderr);
}

export function sshTunnelArgs(request: SshTunnelRequest, localPort: number, supportsForegroundOption = false): string[] {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error("SSH local port is invalid");
  }
  if (!Number.isSafeInteger(request.remotePort) || request.remotePort < 1_024 || request.remotePort > 65_535) {
    throw new Error("SSH remote port is invalid");
  }
  if (request.host.length > 255
    || !/^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[0-9A-Fa-f:]+\])$/.test(request.host)) {
    throw new Error("SSH host contains unsupported characters");
  }
  if (request.user
    && (request.user.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(request.user))) {
    throw new Error("SSH user contains unsupported characters");
  }
  const target = request.user ? `${request.user}@${request.host}` : request.host;
  if (request.sshPort !== undefined && (!Number.isInteger(request.sshPort) || request.sshPort < 1 || request.sshPort > 65535)) throw new Error("SSH port is invalid");
  return [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
    ...(request.sshPort !== undefined ? ["-p", String(request.sshPort)] : []),
    ...(request.identityFile ? ["-F", devNull, "-i", request.identityFile, "-o", "IdentitiesOnly=yes"] : []),
    ...(request.knownHostsFile ? ["-o", `UserKnownHostsFile="${request.knownHostsFile.replaceAll('"', '\\"')}"`, "-o", `GlobalKnownHostsFile=${devNull}`] : []),
    // Keep the forward owned by this foreground child, even with user multiplexing.
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    ...(supportsForegroundOption ? ["-o", "ForkAfterAuthentication=no"] : []),
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${request.remotePort}`,
    target,
  ];
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("loopback port could not be reserved"));
        return;
      }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForTunnel(child: ChildProcess, localPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: net.Socket | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      socket?.destroy();
      child.off("error", fail);
      child.off("exit", exited);
      error ? reject(error) : resolve();
    };
    const fail = (error: Error) => finish(error);
    const exited = () => finish(new Error("ssh exited before the forward became ready"));
    const deadline = setTimeout(() => finish(new SshRuntimeError(
      "sshReadinessTimedOut",
      "SSH connection timed out before port forwarding was ready; check the server and network connection",
    )), 10_000);
    const probe = () => {
      if (settled) return;
      socket = net.connect({ host: "127.0.0.1", port: localPort });
      socket.once("connect", () => finish());
      socket.once("error", () => {
        socket?.destroy();
        if (settled) return;
        timer = setTimeout(probe, 100);
      });
    };
    child.once("error", fail);
    child.once("exit", exited);
    probe();
  });
}
