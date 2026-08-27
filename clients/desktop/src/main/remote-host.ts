import type { AccessStatusDto } from "@termloop/contract/current";
import type {
  RemoteHostStatus,
  RemoteHostTransport,
} from "../connection-profile-types.js";
import {
  configureTailscaleServe,
  disableTermLoopTailscaleServe,
  inspectTailscaleServe,
  type TailscaleServeInspection,
} from "../platform/tailscale-runtime.js";
import { localControlCall } from "./control.js";

type RemoteHostDependencies = {
  status(): Promise<AccessStatusDto>;
  enable(): Promise<AccessStatusDto>;
  disable(): Promise<AccessStatusDto>;
  inspectTailscale(port: number): Promise<TailscaleServeInspection>;
  configureTailscale(port: number): Promise<string>;
  disableTailscale(port: number): Promise<void>;
};

const productionDependencies: RemoteHostDependencies = {
  status: () => localControlCall("access.status"),
  enable: () => localControlCall("access.enable", {}),
  disable: () => localControlCall("access.disable"),
  inspectTailscale: inspectTailscaleServe,
  configureTailscale: configureTailscaleServe,
  disableTailscale: disableTermLoopTailscaleServe,
};

export class RemoteHostManager {
  constructor(private readonly dependencies: RemoteHostDependencies = productionDependencies) {}

  async status(): Promise<RemoteHostStatus> {
    return this.#presentStatus(await this.dependencies.status());
  }

  async enable(transport: RemoteHostTransport): Promise<RemoteHostStatus> {
    let status = await this.dependencies.status();
    if (!status.enabled || !status.listening) status = await this.dependencies.enable();
    if (transport === "tailscale") {
      const baseUrl = await this.dependencies.configureTailscale(listeningPort(status));
      return this.#presentStatus(status, undefined, { state: "ready", baseUrl });
    }
    return this.#presentStatus(status);
  }

  async disable(): Promise<RemoteHostStatus> {
    const before = await this.dependencies.status();
    const disabled = await this.dependencies.disable();
    if (before.port === null) return this.#presentStatus(disabled);
    try {
      await this.dependencies.disableTailscale(before.port);
      return this.#presentStatus(disabled);
    } catch {
      return this.#presentStatus(
        disabled,
        "Remote access is disabled. Its inactive Tailscale Serve route could not be removed automatically.",
      );
    }
  }

  async #presentStatus(
    status: AccessStatusDto,
    warning?: string,
    tailscaleOverride?: TailscaleServeInspection,
  ): Promise<RemoteHostStatus> {
    const tailscale = tailscaleOverride ?? (status.listening && status.port !== null
      ? await this.dependencies.inspectTailscale(status.port)
      : { state: "idle" as const });
    return {
      enabled: status.enabled,
      listening: status.listening,
      port: status.port,
      serverFingerprint: status.server_fingerprint,
      tailscale,
      ...(warning ? { warning } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  }
}

function listeningPort(status: AccessStatusDto): number {
  if (!status.enabled || !status.listening || status.port === null) {
    throw new Error(status.error ?? "Remote access could not be enabled on this computer");
  }
  return status.port;
}
