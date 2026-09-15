// Node reports synthetic permission bits on Windows; native OpenSSH validates
// the key's access there instead of a POSIX mode assertion.
export const supportsPosixFileModes = process.platform !== "win32";
