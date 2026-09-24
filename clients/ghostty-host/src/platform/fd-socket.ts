import net from "node:net";

/// Wraps an already-open file descriptor (e.g. the host end of the
/// Ghostty surface socketpair) in a duplex stream. Ownership of the fd
/// transfers to the socket; destroying the socket closes it.
export type FdSocket = net.Socket;

export function socketFromFd(fd: number): FdSocket {
  return new net.Socket({ fd, readable: true, writable: true });
}
