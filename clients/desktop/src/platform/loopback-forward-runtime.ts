import net from "node:net";

export type LoopbackForwardConnection = {
  onData(listener: (chunk: Uint8Array) => void): void;
  onDrain(listener: () => void): void;
  onError(listener: () => void): void;
  onClose(listener: () => void): void;
  isClosed(): boolean;
  write(bytes: Uint8Array): boolean;
  pause(): void;
  resume(): void;
  end(): void;
  destroy(error?: Error): void;
};

export type LoopbackForwardListener = {
  port: number;
  close(): void;
};

export async function listenLoopbackForward(
  preferredPort: number,
  onConnection: (connection: LoopbackForwardConnection) => void,
): Promise<LoopbackForwardListener> {
  try {
    return await listen(preferredPort, onConnection);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    return listen(0, onConnection);
  }
}

function listen(
  requestedPort: number,
  onConnection: (connection: LoopbackForwardConnection) => void,
): Promise<LoopbackForwardListener> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => {
      onConnection({
        onData(callback) { socket.on("data", callback); },
        onDrain(callback) { socket.once("drain", callback); },
        onError(callback) { socket.once("error", callback); },
        onClose(callback) { socket.once("close", callback); },
        isClosed() { return socket.destroyed; },
        write(bytes) { return socket.write(bytes); },
        pause() { socket.pause(); },
        resume() { socket.resume(); },
        end() { socket.end(); },
        destroy(error) { socket.destroy(error); },
      });
    });
    const failed = (error: Error) => {
      listener.removeAllListeners();
      reject(error);
    };
    listener.once("error", failed);
    listener.listen(requestedPort, "127.0.0.1", () => {
      listener.off("error", failed);
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("local forward address is unavailable"));
        return;
      }
      resolve({ port: address.port, close: () => listener.close() });
    });
  });
}
