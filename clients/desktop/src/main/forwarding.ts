import WebSocket, { type RawData } from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  CONTRACT_IDENTITY,
  type AccessAuthenticated,
  type AccessChallenge,
  type AccessForwardOpened,
  type AccessProtocolError,
} from "@termloop/contract/current";

import { signAccessChallenge } from "../access-auth.js";
import {
  listenLoopbackForward,
  type LoopbackForwardConnection,
  type LoopbackForwardListener,
} from "../platform/loopback-forward-runtime.js";
import type { RemoteConnectionConfig } from "./connection-profiles.js";

const MAX_FORWARD_LISTENERS = 32;
const MAX_FORWARD_MESSAGE_BYTES = 128 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

type ForwardEntry = {
  config: RemoteConnectionConfig;
  remotePort: number;
  localPort: number;
  listener: LoopbackForwardListener;
};

export class ForwardManager {
  readonly #entries = new Map<string, ForwardEntry>();
  readonly #connections = new Map<LoopbackForwardConnection, string>();

  constructor(
    readonly resolveRemoteConfig: (
      profileId: string,
    ) => Promise<RemoteConnectionConfig | undefined>,
    readonly listenForward: typeof listenLoopbackForward = listenLoopbackForward,
  ) {}

  async localUrl(remoteUrl: string, config: RemoteConnectionConfig): Promise<string> {
    const parsed = new URL(remoteUrl);
    const remotePort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      throw new Error("run URL port is invalid");
    }
    const key = `${config.profileId}:${remotePort}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_FORWARD_LISTENERS) throw new Error("too many run forwards are open");
      entry = await this.#listen(config, remotePort);
      this.#entries.set(key, entry);
    } else {
      entry.config = config;
    }
    parsed.hostname = "localhost";
    parsed.port = String(entry.localPort);
    return parsed.toString();
  }

  stop(): void {
    for (const entry of this.#entries.values()) entry.listener.close();
    this.#entries.clear();
    for (const connection of this.#connections.keys()) connection.destroy();
    this.#connections.clear();
  }

  stopProfile(profileId: string): void {
    for (const [key, entry] of [...this.#entries]) {
      if (entry.config.profileId !== profileId) continue;
      entry.listener.close();
      this.#entries.delete(key);
    }
    for (const [connection, ownerProfileId] of [...this.#connections]) {
      if (ownerProfileId !== profileId) continue;
      connection.destroy();
      this.#connections.delete(connection);
    }
  }

  async #listen(config: RemoteConnectionConfig, remotePort: number): Promise<ForwardEntry> {
    const holder: { entry?: ForwardEntry } = {};
    const listener = await this.listenForward(remotePort, (socket) => {
      this.#connections.set(socket, config.profileId);
      socket.onClose(() => this.#connections.delete(socket));
      if (!holder.entry) {
        socket.destroy();
        return;
      }
      void this.#bridge(socket, holder.entry);
    });
    const entry = { config, remotePort, localPort: listener.port, listener };
    holder.entry = entry;
    return entry;
  }

  async #bridge(local: LoopbackForwardConnection, entry: ForwardEntry): Promise<void> {
    try {
      const config = await this.resolveRemoteConfig(entry.config.profileId);
      if (!config || config.profileId !== entry.config.profileId) {
        local.destroy();
        return;
      }
      entry.config = config;
      await bridgeLocalSocket(local, entry);
    } catch {
      local.destroy();
    }
  }
}

async function bridgeLocalSocket(local: LoopbackForwardConnection, entry: ForwardEntry): Promise<void> {
  if (local.isClosed()) return;
  const remote = new WebSocket(forwardEndpoint(entry.config.controlUrl), {
    maxPayload: MAX_FORWARD_MESSAGE_BYTES,
  });
  try {
    const [, challengeValue] = await Promise.all([
      socketOpen(remote),
      nextJson(remote),
    ]);
    const challenge = challengeValue as AccessChallenge;
    if (challenge.kind !== "challenge"
      || challenge.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
      || challenge.controlProtocolVersion !== CONTRACT_IDENTITY
      || challenge.channel !== "forward"
      || challenge.serverFingerprint !== entry.config.credential.serverFingerprint) {
      throw new Error("remote forward challenge is invalid");
    }
    const authentication = JSON.stringify({
      kind: "authenticate",
      protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      deviceId: entry.config.credential.deviceId,
      signature: signAccessChallenge(
        entry.config.credential.privateKey,
        challenge.serverFingerprint,
        "forward",
        challenge.nonce,
      ),
    });
    const authenticationPromise = nextJson(remote);
    remote.send(authentication);
    const authenticated = await authenticationPromise as AccessAuthenticated | AccessProtocolError;
    if (authenticated.kind === "error") throw new Error(authenticated.message);
    if (authenticated.kind !== "authenticated" || authenticated.protocolVersion !== ACCESS_PROTOCOL_IDENTITY) {
      throw new Error("remote forward authentication response is invalid");
    }
    const openRequest = JSON.stringify({
      kind: "forwardOpen",
      protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      port: entry.remotePort,
    });
    const openedPromise = nextJson(remote);
    remote.send(openRequest);
    const opened = await openedPromise as AccessForwardOpened | AccessProtocolError;
    if (opened.kind === "error") throw new Error(opened.message);
    if (opened.kind !== "forwardOpened" || opened.protocolVersion !== ACCESS_PROTOCOL_IDENTITY || opened.port !== entry.remotePort) {
      throw new Error("remote forward response is invalid");
    }
    if (local.isClosed()) {
      remote.close();
      return;
    }
    bridgeBytes(local, remote);
  } catch {
    local.destroy();
    remote.close();
  }
}

function bridgeBytes(local: LoopbackForwardConnection, remote: WebSocket): void {
  local.onData((chunk) => {
    if (remote.readyState !== WebSocket.OPEN) {
      local.destroy();
      return;
    }
    local.pause();
    remote.send(chunk, { binary: true }, (error) => {
      if (error) local.destroy(error);
      else local.resume();
    });
  });
  local.onError(() => remote.close());
  local.onClose(() => remote.close());
  remote.on("message", (data, binary) => {
    if (!binary) {
      local.destroy();
      remote.close();
      return;
    }
    if (!local.write(rawBuffer(data))) {
      remote.pause();
      local.onDrain(() => remote.resume());
    }
  });
  remote.once("error", () => local.destroy());
  remote.once("close", () => local.end());
}

function rawBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function forwardEndpoint(controlUrl: string): string {
  const url = new URL(controlUrl);
  url.pathname = "/forward";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function socketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("remote forward connection timed out")); }, HANDSHAKE_TIMEOUT_MS);
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("remote forward connection failed")); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", failed);
    };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", failed);
  });
}

function nextJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("remote forward handshake timed out")); }, HANDSHAKE_TIMEOUT_MS);
    const received = (raw: RawData, binary: boolean) => {
      cleanup();
      if (binary) { reject(new Error("remote forward handshake is invalid")); return; }
      try { resolve(JSON.parse(String(raw))); } catch { reject(new Error("remote forward handshake is invalid")); }
    };
    const failed = () => { cleanup(); reject(new Error("remote forward handshake ended")); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", received);
      socket.off("error", failed);
      socket.off("close", failed);
    };
    socket.once("message", received);
    socket.once("error", failed);
    socket.once("close", failed);
  });
}
