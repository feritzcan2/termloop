import { spawnSshTunnel, type SshTunnelProcess, type SshTunnelRequest } from "../../platform/ssh-runtime.js";

type TunnelEntry = {
  signature: string;
  active: boolean;
  tunnel: SshTunnelProcess | undefined;
  connecting: Promise<SshTunnelProcess> | undefined;
  failures: number;
  retryAt: number;
};

export class SshTransportManager {
  #entries = new Map<string, TunnelEntry>();

  async baseUrl(profileId: string, request: SshTunnelRequest): Promise<string> {
    const signature = JSON.stringify(request);
    let entry = this.#entries.get(profileId);
    if (entry?.signature !== signature) {
      if (entry) entry.active = false;
      entry?.tunnel?.stop();
      entry = { signature, active: true, tunnel: undefined, connecting: undefined, failures: 0, retryAt: 0 };
      this.#entries.set(profileId, entry);
    }
    if (entry.tunnel) return `ws://127.0.0.1:${entry.tunnel.localPort}`;
    if (Date.now() < entry.retryAt) throw new Error("SSH tunnel is reconnecting");
    if (!entry.connecting) {
      const target = entry;
      entry.connecting = spawnSshTunnel(request).then((tunnel) => {
        if (!target.active || this.#entries.get(profileId) !== target) {
          tunnel.stop();
          throw new Error("SSH tunnel request was superseded");
        }
        target.tunnel = tunnel;
        target.connecting = undefined;
        target.failures = 0;
        target.retryAt = 0;
        tunnel.onExit(() => {
          if (!target.active || this.#entries.get(profileId) !== target || target.tunnel !== tunnel) return;
          target.tunnel = undefined;
          target.failures += 1;
          target.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(target.failures, 6));
        });
        return tunnel;
      }).catch((error) => {
        target.connecting = undefined;
        if (target.active && this.#entries.get(profileId) === target) {
          target.failures += 1;
          target.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(target.failures, 6));
        }
        throw error;
      });
    }
    const tunnel = await entry.connecting;
    return `ws://127.0.0.1:${tunnel.localPort}`;
  }

  remove(profileId: string): void {
    const entry = this.#entries.get(profileId);
    if (entry) entry.active = false;
    entry?.tunnel?.stop();
    this.#entries.delete(profileId);
  }

  stop(): void {
    for (const entry of this.#entries.values()) {
      entry.active = false;
      entry.tunnel?.stop();
    }
    this.#entries.clear();
  }
}
