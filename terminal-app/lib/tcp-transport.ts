/**
 * Real TCP transport. Wire format: newline-delimited JSON.
 * Requires `react-native-tcp-socket` — Expo Go cannot provide raw TCP, so
 * this transport only works in a development build.
 */

import type { RpcRequest, RpcResponse, Transport } from "./termloop-client";

type TcpSocketsModule = typeof import("react-native-tcp-socket").default;

let cachedTcp: TcpSocketsModule | null = null;
let cachedError: Error | null = null;

function loadTcpModule(): TcpSocketsModule {
  if (cachedTcp) return cachedTcp;
  if (cachedError) throw cachedError;
  try {
    const mod = require("react-native-tcp-socket");
    const lib = (mod && (mod.default ?? mod)) as TcpSocketsModule;
    if (!lib || typeof lib.createConnection !== "function") {
      throw new Error("createConnection unavailable");
    }
    cachedTcp = lib;
    return lib;
  } catch (err) {
    cachedError = new Error(
      "TCP transport unavailable. TermLoop mobile requires a development " +
        "build (Expo Go cannot open raw TCP sockets). Run `npx expo prebuild " +
        "--clean` and `npm run ios|android`. " +
        `Underlying error: ${(err as Error).message}`
    );
    throw cachedError;
  }
}

interface PendingCall {
  resolve: (resp: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** Per-request timeout in ms. Default 10s. */
  requestTimeoutMs?: number;
  /** Connect timeout in ms. Default 8s. */
  connectTimeoutMs?: number;
  /** Max bytes buffered on the read side before the socket is dropped. */
  maxRxBufferBytes?: number;
}

const DEFAULT_MAX_RX_BUFFER = 1 << 20; // 1 MiB

export class TcpTransport implements Transport {
  private socket: ReturnType<TcpSocketsModule["createConnection"]> | null = null;
  private connectPromise: Promise<void> | null = null;
  private rxBuffer = "";
  private pending = new Map<string, PendingCall>();
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxRxBufferBytes: number;

  constructor(private readonly opts: TcpTransportOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
    this.maxRxBufferBytes = opts.maxRxBufferBytes ?? DEFAULT_MAX_RX_BUFFER;
  }

  private connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (err) {
          // Allow the next send() to retry instead of latching the failure.
          if (this.connectPromise === promise) this.connectPromise = null;
          reject(err);
        } else {
          resolve();
        }
      };
      const connectTimer = setTimeout(
        () =>
          finish(
            new Error(
              `Connect timeout after ${this.connectTimeoutMs}ms (${this.opts.host}:${this.opts.port})`
            )
          ),
        this.connectTimeoutMs
      );

      let sock: ReturnType<TcpSocketsModule["createConnection"]>;
      try {
        const tcp = loadTcpModule();
        sock = tcp.createConnection(
          { host: this.opts.host, port: this.opts.port },
          () => finish()
        );
      } catch (err) {
        finish(err as Error);
        return;
      }
      this.socket = sock;

      sock.on("data", (data: string | Buffer) => {
        const chunk = typeof data === "string" ? data : data.toString("utf8");
        this.onData(chunk);
      });
      sock.on("error", (err: Error) => {
        finish(err);
        this.failAll(err);
      });
      sock.on("close", () => {
        if (!this.closed) this.failAll(new Error("Connection closed"));
        this.socket = null;
      });
    });
    this.connectPromise = promise;
    return promise;
  }

  private onData(chunk: string): void {
    this.rxBuffer += chunk;
    if (this.rxBuffer.length > this.maxRxBufferBytes) {
      const err = new Error(
        `RX buffer exceeded ${this.maxRxBufferBytes} bytes; dropping connection`
      );
      this.failAll(err);
      this.rxBuffer = "";
      this.socket?.destroy();
      return;
    }
    let idx: number;
    while ((idx = this.rxBuffer.indexOf("\n")) >= 0) {
      const line = this.rxBuffer.slice(0, idx).trim();
      this.rxBuffer = this.rxBuffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let resp: RpcResponse;
    try {
      resp = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (!resp || typeof resp !== "object" || typeof resp.id !== "string") return;
    const call = this.pending.get(resp.id);
    if (!call) return;
    this.pending.delete(resp.id);
    clearTimeout(call.timer);
    call.resolve(resp);
  }

  private failAll(err: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }

  async send<R>(req: RpcRequest): Promise<RpcResponse<R>> {
    if (this.closed) throw new Error("Transport is closed");
    await this.connect();
    if (this.closed) throw new Error("Transport is closed");
    const sock = this.socket;
    if (!sock) throw new Error("Socket not available");

    return new Promise<RpcResponse<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(
          new Error(
            `Request timeout after ${this.requestTimeoutMs}ms (${req.method})`
          )
        );
      }, this.requestTimeoutMs);

      this.pending.set(req.id, {
        resolve: resolve as (r: RpcResponse) => void,
        reject,
        timer,
      });

      try {
        sock.write(JSON.stringify(req) + "\n", "utf8");
      } catch (err) {
        this.pending.delete(req.id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("Transport closed by client"));
    const sock = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (sock) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

export function createTcpTransport(opts: TcpTransportOptions): TcpTransport {
  return new TcpTransport(opts);
}
