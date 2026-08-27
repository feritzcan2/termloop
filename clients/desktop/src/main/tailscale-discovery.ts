import WebSocket from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  type AccessPairChallenge,
  type AccessProtocolError,
} from "@termloop/contract/current";

import type {
  DiscoveredTailscaleServer,
  TailscaleServerDiscovery,
} from "../connection-profile-types.js";
import {
  listOnlineTailscalePeers,
  type TailscalePeer,
} from "../platform/tailscale-runtime.js";
import { accessEndpoint } from "./transports/tailscale.js";

const DISCOVERY_TIMEOUT_MS = 3_000;
const MAX_DISCOVERY_MESSAGE_BYTES = 16 * 1024;
const MAX_CONCURRENT_PROBES = 8;

type PeerProbe = (peer: TailscalePeer) => Promise<DiscoveredTailscaleServer | undefined>;

/** Coalesces scans so opening or refreshing the dialog cannot fan out probes. */
export class TailscaleServerDiscoveryManager {
  #inFlight: Promise<TailscaleServerDiscovery> | undefined;

  constructor(
    private readonly listPeers: () => Promise<TailscalePeer[]> = listOnlineTailscalePeers,
    private readonly probe: PeerProbe = probeTermLoopTailscalePeer,
  ) {}

  discover(): Promise<TailscaleServerDiscovery> {
    if (this.#inFlight) return this.#inFlight;
    const operation = this.#discoverOnce().finally(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
    });
    this.#inFlight = operation;
    return operation;
  }

  async #discoverOnce(): Promise<TailscaleServerDiscovery> {
    let peers: TailscalePeer[];
    try {
      peers = await this.listPeers();
    } catch (error) {
      return {
        state: "unavailable",
        servers: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const servers = await probePeers(peers, this.probe);
    return { state: "ready", servers };
  }
}

export async function probeTermLoopTailscalePeer(
  peer: TailscalePeer,
): Promise<DiscoveredTailscaleServer | undefined> {
  const socket = new WebSocket(accessEndpoint(peer.baseUrl, "enroll"), {
    maxPayload: MAX_DISCOVERY_MESSAGE_BYTES,
  });
  try {
    const [, value] = await Promise.all([
      socketOpen(socket),
      nextJson(socket),
    ]);
    const challenge = value as AccessPairChallenge | AccessProtocolError;
    if (challenge.kind !== "pairChallenge"
      || challenge.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
      || !/^sha256:[0-9a-f]{64}$/u.test(challenge.serverFingerprint)) {
      return undefined;
    }
    return { ...peer, serverFingerprint: challenge.serverFingerprint };
  } catch {
    return undefined;
  } finally {
    closeDiscoverySocket(socket);
  }
}

async function probePeers(
  peers: readonly TailscalePeer[],
  probe: PeerProbe,
): Promise<DiscoveredTailscaleServer[]> {
  const servers: DiscoveredTailscaleServer[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < peers.length) {
      const peer = peers[cursor];
      cursor += 1;
      if (!peer) return;
      const server = await probe(peer).catch(() => undefined);
      if (server) servers.push(server);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_PROBES, peers.length) },
    worker,
  ));
  return servers.sort((left, right) => left.name.localeCompare(right.name));
}

function socketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("TermLoop discovery timed out"));
    }, DISCOVERY_TIMEOUT_MS);
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("TermLoop discovery failed")); };
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
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("TermLoop discovery response timed out"));
    }, DISCOVERY_TIMEOUT_MS);
    const received = (raw: WebSocket.RawData, binary: boolean) => {
      cleanup();
      if (binary) {
        reject(new Error("TermLoop discovery response is invalid"));
        return;
      }
      try {
        resolve(JSON.parse(String(raw)));
      } catch {
        reject(new Error("TermLoop discovery response is invalid"));
      }
    };
    const failed = () => {
      cleanup();
      reject(new Error("TermLoop discovery connection ended"));
    };
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

function closeDiscoverySocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.once("error", () => undefined);
      socket.terminate();
    }
  } catch {
    // A failed candidate is simply absent from discovery results.
  }
}
