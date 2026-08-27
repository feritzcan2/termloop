import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { ACCESS_PROTOCOL_IDENTITY, CONTRACT_IDENTITY, type AccessAuthenticated, type AccessChallenge, type AccessProtocolError } from "@termloop/contract/current";
import { signAccessChallenge } from "../access-auth.js";
import type { DesktopConnectionConfig, RemoteConnectionConfig } from "./connection-profiles.js";

const MAX_CONTROL_MESSAGE_BYTES = 8 * 1024 * 1024;

let latestRemoteConnectionFailure: { profileId: string; message: string } | undefined;

export function remoteConnectionFailureMessage(profileId: string): string | undefined {
  return latestRemoteConnectionFailure?.profileId === profileId
    ? latestRemoteConnectionFailure.message
    : undefined;
}

export interface DesktopControlSocket {
  readonly readyState: number;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void, options?: { once?: boolean }): void;
  on(type: "open" | "message" | "error" | "close", listener: (...args: any[]) => void): this;
  once(type: "open" | "message" | "error" | "close", listener: (...args: any[]) => void): this;
  send(data: string): void;
  close(): void;
}

export function createControlSocket(config: DesktopConnectionConfig): DesktopControlSocket {
  return config.kind === "local"
    ? new WebSocket(config.controlUrl) as unknown as DesktopControlSocket
    : new AccessControlSocket(config);
}

class AccessControlSocket extends EventEmitter implements DesktopControlSocket {
  readyState: number = WebSocket.CONNECTING;
  readonly #socket: WebSocket;
  readonly #config: RemoteConnectionConfig;
  #connectionToken: string | undefined;
  #closed = false;

  constructor(config: RemoteConnectionConfig) {
    super();
    if (latestRemoteConnectionFailure?.profileId !== config.profileId) {
      latestRemoteConnectionFailure = undefined;
    }
    this.#config = config;
    this.#socket = new WebSocket(config.controlUrl, { maxPayload: MAX_CONTROL_MESSAGE_BYTES });
    this.#socket.once("open", () => { void this.#authenticate(); });
    this.#socket.once("error", (error) => this.#fail(error instanceof Error ? error : new Error("remote connection failed")));
    this.#socket.once("close", () => this.#finishClose());
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const wrapped = (...args: any[]) => {
      if (type === "message") listener({ data: String(args[0]) });
      else if (type === "error") listener({ error: args[0] });
      else listener({});
    };
    if (options?.once) this.once(type, wrapped);
    else this.on(type, wrapped);
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || !this.#connectionToken) {
      throw new Error("remote control connection is not authenticated");
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("control messages must be JSON text");
    }
    if (!value || typeof value !== "object" || !("token" in value)) {
      throw new Error("control request is missing its credential field");
    }
    this.#socket.send(JSON.stringify({ ...value, token: this.#connectionToken }));
  }

  close(): void {
    this.#socket.close();
  }

  async #authenticate(): Promise<void> {
    try {
      const challenge = await nextJson(this.#socket, 10_000) as AccessChallenge;
      if (challenge.kind !== "challenge"
        || challenge.protocolVersion !== ACCESS_PROTOCOL_IDENTITY
        || challenge.channel !== "control") {
        throw new Error("remote access challenge is invalid");
      }
      if (challenge.controlProtocolVersion !== CONTRACT_IDENTITY) {
        throw new Error(`Version mismatch: server ${challenge.controlProtocolVersion}, desktop ${CONTRACT_IDENTITY}`);
      }
      if (challenge.serverFingerprint !== this.#config.credential.serverFingerprint) {
        throw new Error("remote server fingerprint changed");
      }
      const authentication = JSON.stringify({
        kind: "authenticate",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        deviceId: this.#config.credential.deviceId,
        signature: signAccessChallenge(
          this.#config.credential.privateKey,
          challenge.serverFingerprint,
          "control",
          challenge.nonce,
        ),
      });
      const responsePromise = nextJson(this.#socket, 10_000);
      this.#socket.send(authentication);
      const response = await responsePromise as AccessAuthenticated | AccessProtocolError;
      if (response.kind === "error") throw new Error(response.message);
      if (response.kind !== "authenticated" || response.protocolVersion !== ACCESS_PROTOCOL_IDENTITY) {
        throw new Error("remote access authentication response is invalid");
      }
      this.#connectionToken = response.connectionToken;
      if (latestRemoteConnectionFailure?.profileId === this.#config.profileId) {
        latestRemoteConnectionFailure = undefined;
      }
      this.readyState = WebSocket.OPEN;
      this.#socket.on("message", (raw, binary) => {
        if (binary) {
          this.#fail(new Error("remote control message framing is invalid"));
          return;
        }
        this.emit("message", raw);
      });
      this.emit("open");
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error("remote access authentication failed"));
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    latestRemoteConnectionFailure = {
      profileId: this.#config.profileId,
      message: error.message,
    };
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.#socket.close();
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = WebSocket.CLOSED;
    this.#connectionToken = undefined;
    this.emit("close");
  }
}

function nextJson(socket: WebSocket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("remote access handshake timed out")); }, timeoutMs);
    const received = (raw: RawData, binary: boolean) => {
      cleanup();
      if (binary) { reject(new Error("remote access handshake response is invalid")); return; }
      try { resolve(JSON.parse(String(raw))); } catch { reject(new Error("remote access handshake response is invalid")); }
    };
    const failed = () => { cleanup(); reject(new Error("remote access handshake ended")); };
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
