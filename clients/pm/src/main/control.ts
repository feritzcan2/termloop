// Owns the generated PM control client and the one event subscription. Both
// live in main; the renderer sees only call outcomes and validated events.
import WebSocket from "ws";
import {
  CONTRACT_IDENTITY,
  EVENTS,
  TermLoopPmClient,
  validateEventPayload,
  type EventName,
  type SocketLike,
} from "@termloop/pm-contract/pm";
import type { PmDiscovery } from "./daemon-lifecycle.js";

const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 4_000;
const SUBSCRIPTION_ID = "pm-app-subscription";

export type PmControlEvent = { event: EventName; payload: unknown };

export class PmControl {
  readonly #client: TermLoopPmClient;
  #socket: WebSocket | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryMs = MIN_RETRY_MS;
  #stopped = true;

  constructor(
    readonly discovery: PmDiscovery,
    readonly onEvent: (event: PmControlEvent) => void,
    readonly onResubscribed: () => void = () => {},
  ) {
    this.#client = new TermLoopPmClient(
      discovery.controlUrl,
      discovery.token,
      (url) => new WebSocket(url) as unknown as SocketLike,
    );
  }

  call(method: string, params: object): Promise<unknown> {
    // The renderer allowlist was applied by the caller; the client validates
    // every result against the contract before it resolves.
    return (this.#client.call as (method: string, params: object) => Promise<unknown>)(method, params);
  }

  /** Opens the subscription socket and keeps it open with bounded backoff. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#client.close();
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.discovery.controlUrl);
    this.#socket = socket;
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: SUBSCRIPTION_ID,
        protocolVersion: CONTRACT_IDENTITY,
        token: this.discovery.token,
        method: "pm_subscribe",
        params: { events: [...EVENTS] },
      }));
    });
    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        socket.close();
        return;
      }
      if (message["id"] === SUBSCRIPTION_ID) {
        if (message["ok"] !== true) {
          socket.close();
          return;
        }
        this.#retryMs = MIN_RETRY_MS;
        this.onResubscribed();
        return;
      }
      const event = message["event"];
      if (message["protocolVersion"] !== CONTRACT_IDENTITY || typeof event !== "string") return;
      if (!(EVENTS as readonly string[]).includes(event) || !validateEventPayload(event, message["payload"])) return;
      this.onEvent({ event: event as EventName, payload: message["payload"] });
    });
    socket.once("error", () => socket.close());
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retry) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#connect();
    }, delay);
  }
}
