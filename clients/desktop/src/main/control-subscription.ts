import WebSocket from "ws";
import {
  CONTRACT_IDENTITY,
  type ControlEvent,
  type ControlResponse,
  type ProjectionInvalidatedPayload,
} from "@termloop/contract/current";
import { createControlSocket, type DesktopControlSocket } from "./access-websocket.js";
import type { DesktopConnectionConfig } from "./connection-profiles.js";

const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

export class ControlSubscription {
  #socket: DesktopControlSocket | undefined;
  #plannedCloseSocket: DesktopControlSocket | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryMs = MIN_RETRY_MS;
  #stopped = true;
  #generation = 0;
  #subscriptionId = 0;
  #projectIds: string[] = [];

  constructor(
    readonly onInvalidation: (payload: ProjectionInvalidatedPayload) => void,
    readonly onConnected?: () => Promise<void>,
    readonly resolveConnectionConfig: () => Promise<DesktopConnectionConfig | undefined> = async () => (
      (await import("./connection-registry.js")).localConnectionConfig()
    ),
    readonly onState?: (state: "connecting" | "connected" | "offline", message?: string) => void,
  ) {}

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#generation += 1;
    this.onState?.("connecting");
    void this.#connect(this.#generation);
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#plannedCloseSocket = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  setProjectIds(projectIds: readonly string[]): void {
    const next = [...new Set(projectIds)].sort();
    if (next.join("\0") === this.#projectIds.join("\0")) return;
    this.#projectIds = next;
    if (this.#socket) {
      this.#plannedCloseSocket = this.#socket;
      this.#socket.close();
    }
  }

  async #connect(generation: number): Promise<void> {
    if (this.#stopped || generation !== this.#generation) return;
    let config;
    try {
      config = await this.resolveConnectionConfig();
    } catch (error) {
      // SSH transport setup rejects during its bounded reconnect backoff.
      // Treat that exactly like temporarily missing discovery.
      this.onState?.("offline", error instanceof Error ? error.message : String(error));
      this.#scheduleRetry(generation);
      return;
    }
    if (this.#stopped || generation !== this.#generation) return;
    if (!config) {
      this.onState?.("offline", "TermLoop server is unavailable");
      this.#scheduleRetry(generation);
      return;
    }
    const socket = createControlSocket(config);
    this.#socket = socket;
    let connectionFailure: string | undefined;
    const id = `desktop-subscription-${++this.#subscriptionId}`;
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id,
        protocolVersion: CONTRACT_IDENTITY,
        token: config.token,
        method: "control.subscribe",
        params: {
          topics: ["project", "task", "session", "agentStatus", "gitHost", "branchCommit", "companion", "steward", "worker", "routine", "keepAwake"],
          ...(this.#projectIds.length > 0 ? { projectIds: this.#projectIds } : {}),
        },
      }));
    });
    let subscriptionAccepted = false;
    socket.on("message", (data) => {
      let message: ControlResponse | ControlEvent;
      try {
        message = JSON.parse(data.toString()) as ControlResponse | ControlEvent;
      } catch {
        socket.close();
        return;
      }
      if ("id" in message) {
        if (message.id !== id || !message.ok || subscriptionAccepted) {
          if (message.id === id) socket.close();
          return;
        }
        subscriptionAccepted = true;
        void this.#finishConnection(socket, message.result as {
          stateRevision: number;
          observationSequence: number;
        });
        return;
      }
      if (message.event !== "projection.invalidated") return;
      this.onInvalidation(message.payload as ProjectionInvalidatedPayload);
    });
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      const plannedClose = this.#plannedCloseSocket === socket;
      if (plannedClose) this.#plannedCloseSocket = undefined;
      if (!plannedClose && !this.#stopped && generation === this.#generation) {
        this.onState?.("offline", connectionFailure ?? "Connection lost; reconnecting");
      }
      this.#scheduleRetry(generation);
    });
    socket.once("error", (error) => {
      connectionFailure = error instanceof Error ? error.message : String(error);
      socket.close();
    });
  }

  async #finishConnection(
    socket: DesktopControlSocket,
    result: { stateRevision: number; observationSequence: number },
  ): Promise<void> {
    try {
      await this.onConnected?.();
    } catch {
      socket.close();
      return;
    }
    if (this.#stopped || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    this.#retryMs = MIN_RETRY_MS;
    this.onState?.("connected");
    this.onInvalidation({
      topics: ["project", "task", "session", "agentStatus", "gitHost", "branchCommit", "companion", "steward", "worker", "routine", "keepAwake"],
      stateRevision: result.stateRevision,
      observationSequence: result.observationSequence,
    });
  }

  #scheduleRetry(generation: number): void {
    if (this.#stopped || generation !== this.#generation || this.#retry) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#connect(generation);
    }, delay);
  }
}
