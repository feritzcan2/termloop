export interface DataSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: { type?: string }) => void) | null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

export type DataSocketFactory = (url: string) => DataSocket;

export async function dataSocketMessageBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("WebSocket message type is unsupported.");
}
