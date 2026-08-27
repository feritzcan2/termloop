import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

const MAX_LOCAL_PORT_ATTEMPTS = 3;

export type SshTunnelRequest = {
  host: string;
  user?: string;
  remotePort: number;
};

export type SshTunnelProcess = {
  localPort: number;
  onExit(listener: () => void): void;
  stop(): void;
};

export class SshRuntimeError extends Error {
  constructor(
    readonly code: "sshUnavailable" | "sshHostKeyMismatch" | "sshForwardFailed",
    message: string,
  ) {
    super(message);
    this.name = "SshRuntimeError";
  }
}

export async function spawnSshTunnel(request: SshTunnelRequest): Promise<SshTunnelProcess> {
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt += 1) {
    const localPort = await reserveLoopbackPort();
    const child = spawn("ssh", sshTunnelArgs(request, localPort), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192);
    });
    try {
      await waitForTunnel(child, localPort);
      return runningTunnel(child, localPort);
    } catch (error) {
      child.kill();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SshRuntimeError("sshUnavailable", "OpenSSH client is not installed or is not on PATH");
      }
      if (/host key verification failed|remote host identification has changed/i.test(stderr)) {
        throw new SshRuntimeError("sshHostKeyMismatch", "SSH host key verification failed; verify and update the host key outside TermLoop");
      }
      if (attempt < MAX_LOCAL_PORT_ATTEMPTS && isSshLocalForwardBindFailure(stderr)) continue;
      throw new SshRuntimeError("sshForwardFailed", "SSH port forwarding could not be established");
    }
  }
  throw new SshRuntimeError("sshForwardFailed", "SSH port forwarding could not be established");
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

export function sshTunnelArgs(request: SshTunnelRequest, localPort: number): string[] {
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
  return [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
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
    const deadline = Date.now() + 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("error", fail);
      child.off("exit", exited);
      error ? reject(error) : resolve();
    };
    const fail = (error: Error) => finish(error);
    const exited = () => finish(new Error("ssh exited before the forward became ready"));
    const probe = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(new Error("ssh forward readiness timed out"));
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port: localPort });
      socket.once("connect", () => { socket.destroy(); finish(); });
      socket.once("error", () => {
        socket.destroy();
        if (settled) return;
        timer = setTimeout(probe, 100);
      });
    };
    child.once("error", fail);
    child.once("exit", exited);
    probe();
  });
}
