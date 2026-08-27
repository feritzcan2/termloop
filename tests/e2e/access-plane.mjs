import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ACCESS_PROTOCOL_IDENTITY, CONTRACT_IDENTITY } from "../../contract/generated/typescript/dist/current.js";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-access-plane-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const cargoTargetDirectory = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const serverBinary = path.join(cargoTargetDirectory, "debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
await Promise.all([runtimeDirectory, stateDirectory].map((directory) => mkdir(directory, { recursive: true })));

let server;
let targetServer;
const targetSockets = new Set();
const socketReaders = new WeakMap();
try {
  const accessPort = await reservePort();
  let runtime;
  [server, runtime] = await startServer();
  const disabled = await localCall(runtime, "access.status");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.listening, false);
  const enabled = await localCall(runtime, "access.enable", { port: accessPort });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.listening, true);
  assert.equal(enabled.port, accessPort);
  assert.equal(typeof enabled.access_url, "string");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  assert.equal(typeof publicJwk.x, "string");
  assert.equal(typeof privateJwk.d, "string");
  const enrolled = await enroll(
    `${enabled.access_url}/enroll`,
    "E2E laptop",
    publicJwk.x,
    enabled.server_fingerprint,
  );
  assert.equal(enrolled.kind, "enrolled");
  assert.equal(enrolled.scope, "full");
  assert.equal(enrolled.serverFingerprint, enabled.server_fingerprint);
  const paired = enrolled;

  // Keep the legacy invitation path covered for older clients and the CLI.
  const invitation = await localCall(runtime, "access.pairCreate", { name: "Legacy E2E laptop", scope: "full" });
  assert.equal(invitation.server_fingerprint, enabled.server_fingerprint);
  const legacyKeys = generateKeyPairSync("ed25519");
  const legacyPublicJwk = legacyKeys.publicKey.export({ format: "jwk" });
  assert.equal(typeof legacyPublicJwk.x, "string");

  const wrongFingerprint = await pair(
    `${invitation.access_url}/pair`,
    invitation.pairing_code,
    legacyPublicJwk.x,
    `sha256:${"0".repeat(64)}`,
  );
  assert.equal(wrongFingerprint.kind, "fingerprintMismatch");
  const wrongPairing = await pair(
    `${invitation.access_url}/pair`,
    "AAAA-AAAA",
    legacyPublicJwk.x,
    invitation.server_fingerprint,
  );
  assert.equal(wrongPairing.kind, "error");
  assert.equal(wrongPairing.code, "pairingDenied");
  const legacyPaired = await pair(
    `${invitation.access_url}/pair`,
    invitation.pairing_code,
    legacyPublicJwk.x,
    invitation.server_fingerprint,
  );
  assert.equal(legacyPaired.kind, "paired");
  assert.equal(legacyPaired.serverFingerprint, invitation.server_fingerprint);
  const reused = await pair(
    `${invitation.access_url}/pair`,
    invitation.pairing_code,
    legacyPublicJwk.x,
    invitation.server_fingerprint,
  );
  assert.equal(reused.kind, "error");
  assert.equal(reused.code, "pairingDenied");

  const crossChannel = await authenticate(
    `${invitation.access_url}/control`,
    paired.deviceId,
    privateKey,
    "terminal",
  );
  assert.equal(crossChannel.response.kind, "error");
  crossChannel.socket.close();

  const crossServer = await authenticate(
    `${invitation.access_url}/control`,
    paired.deviceId,
    privateKey,
    "control",
    `sha256:${"f".repeat(64)}`,
  );
  assert.equal(crossServer.response.kind, "error");
  crossServer.socket.close();

  const remote = await authenticate(
    `${invitation.access_url}/control`,
    paired.deviceId,
    privateKey,
    "control",
  );
  assert.equal(remote.response.kind, "authenticated");
  const replaySocket = await openSocket(`${invitation.access_url}/control`);
  await bounded(nextJson(replaySocket), 3_000, "replay challenge timed out");
  replaySocket.send(JSON.stringify({
    kind: "authenticate",
    protocolVersion: ACCESS_PROTOCOL_IDENTITY,
    deviceId: paired.deviceId,
    signature: remote.signature,
  }));
  const replayDenied = await bounded(nextJson(replaySocket), 3_000, "replayed proof was not rejected");
  assert.equal(replayDenied.kind, "error");
  assert.equal(replayDenied.code, "unauthenticated");
  replaySocket.close();
  const version = await remoteCall(remote.socket, remote.response.connectionToken, "system.version");
  assert.equal(version.ok, true);
  assert.equal(version.result.protocolVersion, CONTRACT_IDENTITY);
  remote.socket.send(JSON.stringify({
    id: randomUUID(),
    protocolVersion: CONTRACT_IDENTITY,
    token: remote.response.connectionToken,
    method: "system.ping",
    params: { payload: "x".repeat(9 * 1024 * 1024) },
  }));
  const oversized = await bounded(nextJson(remote.socket), 12_000, "oversized remote request timed out");
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "requestTooLarge");
  const localTokenOnRemote = await remoteCall(remote.socket, runtime.token, "system.ping");
  assert.equal(localTokenOnRemote.ok, false);
  assert.equal(localTokenOnRemote.error.code, "unauthenticated");
  const localReplaySocket = await openSocket(runtime.controlUrl);
  const remoteTokenOnLocal = await remoteCall(localReplaySocket, remote.response.connectionToken, "system.ping");
  assert.equal(remoteTokenOnLocal.ok, false);
  assert.equal(remoteTokenOnLocal.error.code, "unauthenticated");
  localReplaySocket.close();
  const shutdownDenied = await remoteCall(remote.socket, remote.response.connectionToken, "system.shutdown");
  assert.equal(shutdownDenied.ok, false);
  assert.equal(shutdownDenied.error.code, "capabilityDenied");
  const accessDenied = await remoteCall(remote.socket, remote.response.connectionToken, "access.status");
  assert.equal(accessDenied.ok, false);
  assert.equal(accessDenied.error.code, "capabilityDenied");
  const automaticRestartDenied = await remoteCall(
    remote.socket,
    remote.response.connectionToken,
    "session.restartAgentsForClientLaunch",
    { clientLaunchId: randomUUID() },
  );
  assert.equal(automaticRestartDenied.ok, false);
  assert.equal(automaticRestartDenied.error.code, "capabilityDenied");

  const browsed = await remoteCall(remote.socket, remote.response.connectionToken, "system.browseDirectory", { path: temporary });
  assert.equal(browsed.ok, true);
  assert.equal(browsed.result.path, await realpath(temporary));
  assert.deepEqual(browsed.result.entries.map((entry) => entry.name).sort(), ["runtime", "state"]);

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
    Buffer.from("IHDR"),
    Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const sha256 = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const uploadStart = await remoteCall(remote.socket, remote.response.connectionToken, "attachment.beginUpload", {
    mediaType: "image/png",
    byteLength: png.byteLength,
    sha256,
    width: 2,
    height: 3,
  });
  assert.equal(uploadStart.ok, true);
  const attachmentUrl = `${invitation.access_url.replace(/^ws/, "http")}/attachments`;
  const uploadedResponse = await fetch(attachmentUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${uploadStart.result.uploadTicket}`, "content-type": "image/png" },
    body: png,
  });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json();
  assert.equal(uploaded.sha256, sha256);
  assert.equal("filePath" in uploaded, false);
  const replayed = await fetch(attachmentUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${uploadStart.result.uploadTicket}`, "content-type": "image/png" },
    body: png,
  });
  assert.equal(replayed.status, 401);
  const stagedPath = path.join(stateDirectory, "termloop-quick-action-images", uploaded.attachmentId, "image.png");
  assert.deepEqual(await readFile(stagedPath), png);
  if (process.platform !== "win32") assert.equal((await stat(stagedPath)).mode & 0o777, 0o600);
  const accessConfigPath = path.join(stateDirectory, "access-plane.json");
  const deviceRegistryPath = path.join(stateDirectory, "access-devices.json");
  const durableAccessFiles = `${await readFile(accessConfigPath, "utf8")}\n${await readFile(deviceRegistryPath, "utf8")}`;
  for (const secret of [
    invitation.pairing_code,
    remote.response.connectionToken,
    uploadStart.result.uploadTicket,
    privateJwk.d,
  ]) assert.equal(durableAccessFiles.includes(secret), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(accessConfigPath)).mode & 0o777, 0o600);
    assert.equal((await stat(deviceRegistryPath)).mode & 0o777, 0o600);
  }

  const targetPort = await new Promise((resolve, reject) => {
    targetServer = net.createServer((socket) => {
      targetSockets.add(socket);
      socket.once("close", () => targetSockets.delete(socket));
      socket.pipe(socket);
    });
    targetServer.once("error", reject);
    targetServer.listen(0, "127.0.0.1", () => resolve(targetServer.address().port));
  });
  const project = await localCall(runtime, "project.create", { name: "Forward E2E", folderPath: temporary });
  const quickActionPreview = await remoteCall(remote.socket, remote.response.connectionToken, "quickAction.preview", {
    projectId: project.id,
    cwd: temporary,
    agentId: "codex",
    model: "default",
    permission: "default",
    reasoning: "default",
    templateRef: "builtin.quick-action.free-prompt",
    bindings: { prompt: "Inspect the uploaded image" },
    attachments: [uploaded],
  });
  assert.equal(quickActionPreview.ok, true);
  const uploadedImagePart = quickActionPreview.result.manifest.content_parts
    .find((part) => part.kind === "imageAttachment");
  assert.equal(uploadedImagePart?.digest, sha256);
  assert.equal(JSON.stringify(quickActionPreview.result).includes(stagedPath), false);
  const runList = await localCall(runtime, "runConfiguration.list", { projectId: project.id });
  const createdRun = await localCall(runtime, "runConfiguration.create", {
    projectId: project.id,
    name: "Forward target",
    kind: "devServer",
    command: 'node -e "setInterval(function(){},1000)"',
    workingDirectory: ".",
    env: [],
    setupCommand: null,
    setupPolicy: "never",
    urlAutoDetect: false,
    fallbackUrls: [`http://localhost:${targetPort}`],
    autoOpenFirstUrl: false,
    expectedRevision: runList.stateRevision,
  });
  const startedRun = await localCall(runtime, "project.startRun", {
    projectId: project.id,
    configurationId: createdRun.configuration.id,
    forceSetup: false,
  });

  const localTerminal = await openSocket(runtime.terminalUrl);
  const localTerminalAuthMessage = nextSocketMessage(localTerminal);
  localTerminal.send(Buffer.concat([Buffer.from("TL01"), Buffer.from(runtime.terminalToken)]));
  const localTerminalAuth = await bounded(localTerminalAuthMessage, 3_000, "local terminal auth timed out");
  assert.equal(String(localTerminalAuth.raw), "TLOK");
  const remoteTerminal = await authenticate(`${invitation.access_url}/terminal`, paired.deviceId, privateKey, "terminal");
  assert.equal(remoteTerminal.response.kind, "authenticated");
  remoteTerminal.socket.send(Buffer.concat([Buffer.from("TL01"), Buffer.from(remoteTerminal.response.connectionToken)]));
  const remoteTerminalAuth = await bounded(nextSocketMessage(remoteTerminal.socket), 3_000, "remote terminal auth timed out");
  assert.equal(String(remoteTerminalAuth.raw), "TLOK");
  localTerminal.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 1, 10));
  assert.equal(await nextResizeOwnership(localTerminal), true);
  remoteTerminal.socket.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 1, 10));
  assert.equal(await nextResizeOwnership(remoteTerminal.socket), false);
  remoteTerminal.socket.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 2, 13));
  assert.equal(await nextResizeOwnership(localTerminal), false);
  assert.equal(await nextResizeOwnership(remoteTerminal.socket), true);
  localTerminal.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 2, 13));
  assert.equal(await nextResizeOwnership(localTerminal), true);
  assert.equal(await nextResizeOwnership(remoteTerminal.socket), false);
  localTerminal.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 3, 15));
  assert.equal(await nextResizeOwnership(remoteTerminal.socket), false);
  remoteTerminal.socket.send(terminalFrame(startedRun.id, startedRun.runtime_epoch, 3, 13));
  assert.equal(await nextResizeOwnership(remoteTerminal.socket), true);
  localTerminal.close();

  const forwarded = await authenticate(`${invitation.access_url}/forward`, paired.deviceId, privateKey, "forward");
  assert.equal(forwarded.response.kind, "authenticated");
  forwarded.socket.send(JSON.stringify({
    kind: "forwardOpen",
    protocolVersion: ACCESS_PROTOCOL_IDENTITY,
    port: targetPort,
  }));
  const opened = await bounded(nextJson(forwarded.socket), 3_000, "forward did not open");
  assert.equal(opened.kind, "forwardOpened");
  await new Promise((resolve, reject) => forwarded.socket.pong(
    Buffer.from("keepalive"),
    (error) => error ? reject(error) : resolve(),
  ));
  const echo = Buffer.alloc(32 * 1024, 7);
  forwarded.socket.send(echo);
  assert.deepEqual(
    await bounded(nextBinaryBytes(forwarded.socket, echo.byteLength), 3_000, "forward echo timed out"),
    echo,
  );
  const slowConsumerEcho = Buffer.alloc(2 * 1024 * 1024, 11);
  forwarded.socket.pause();
  for (let offset = 0; offset < slowConsumerEcho.byteLength; offset += 64 * 1024) {
    forwarded.socket.send(slowConsumerEcho.subarray(offset, offset + 64 * 1024));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  forwarded.socket.resume();
  assert.deepEqual(
    await bounded(
      nextBinaryBytes(forwarded.socket, slowConsumerEcho.byteLength),
      10_000,
      "forward did not recover after a slow consumer",
    ),
    slowConsumerEcho,
  );

  const deniedForward = await authenticate(`${invitation.access_url}/forward`, paired.deviceId, privateKey, "forward");
  assert.equal(deniedForward.response.kind, "authenticated");
  deniedForward.socket.send(JSON.stringify({
    kind: "forwardOpen",
    protocolVersion: ACCESS_PROTOCOL_IDENTITY,
    port: targetPort === 65_535 ? targetPort - 1 : targetPort + 1,
  }));
  const deniedForwardResponse = await bounded(nextJson(deniedForward.socket), 3_000, "forward denial timed out");
  assert.equal(deniedForwardResponse.kind, "error");
  assert.equal(deniedForwardResponse.code, "forwardDenied");
  deniedForward.socket.close();

  const controlClosedAfterRevoke = onceClosed(remote.socket);
  const terminalClosedAfterRevoke = onceClosed(remoteTerminal.socket);
  const forwardClosedAfterRevoke = onceClosed(forwarded.socket);
  assert.deepEqual(await localCall(runtime, "access.deviceRevoke", { deviceId: paired.deviceId }), { revoked: true });
  await Promise.all([
    bounded(controlClosedAfterRevoke, 2_000, "revoked control connection did not close"),
    bounded(terminalClosedAfterRevoke, 2_000, "revoked terminal connection did not close"),
    bounded(forwardClosedAfterRevoke, 2_000, "revoked forward connection did not close"),
  ]);
  const revokedEnrollment = await enroll(
    `${invitation.access_url}/enroll`,
    "E2E laptop",
    publicJwk.x,
    invitation.server_fingerprint,
  );
  assert.equal(revokedEnrollment.kind, "error");
  assert.equal(revokedEnrollment.code, "enrollmentDenied");

  const secondInvitation = await localCall(runtime, "access.pairCreate", { name: "Persistent laptop", scope: "readOnly" });
  const secondKeys = generateKeyPairSync("ed25519");
  const secondPublicJwk = secondKeys.publicKey.export({ format: "jwk" });
  const secondDevice = await pair(
    `${secondInvitation.access_url}/pair`,
    secondInvitation.pairing_code,
    secondPublicJwk.x,
    secondInvitation.server_fingerprint,
  );
  assert.equal(secondDevice.kind, "paired");

  await localCall(runtime, "system.shutdown");
  await bounded(new Promise((resolve) => server.once("exit", resolve)), 5_000, "daemon did not shut down");
  server = undefined;
  [server, runtime] = await startServer();
  await waitUntil(async () => (await localCall(runtime, "access.status")).listening ? true : undefined, 5_000, "access listener did not restore");
  const restored = await authenticate(
    `ws://127.0.0.1:${accessPort}/control`,
    secondDevice.deviceId,
    secondKeys.privateKey,
    "control",
  );
  assert.equal(restored.response.kind, "authenticated");
  const readOnlyPing = await remoteCall(restored.socket, restored.response.connectionToken, "system.ping");
  assert.equal(readOnlyPing.ok, true);
  const readOnlyMutation = await remoteCall(restored.socket, restored.response.connectionToken, "project.create", {
    name: "Denied",
    folderPath: temporary,
  });
  assert.equal(readOnlyMutation.ok, false);
  assert.equal(readOnlyMutation.error.code, "capabilityDenied");
  const readOnlyForward = await authenticate(
    `ws://127.0.0.1:${accessPort}/forward`,
    secondDevice.deviceId,
    secondKeys.privateKey,
    "forward",
  );
  assert.equal(readOnlyForward.response.kind, "authenticated");
  const readOnlyForwardDenied = await bounded(nextJson(readOnlyForward.socket), 3_000, "read-only forward denial timed out");
  assert.equal(readOnlyForwardDenied.kind, "error");
  assert.equal(readOnlyForwardDenied.code, "forwardDenied");
  readOnlyForward.socket.close();

  const controlClosedAfterDisable = onceClosed(restored.socket);
  const disabledAgain = await localCall(runtime, "access.disable");
  assert.equal(disabledAgain.enabled, false);
  assert.equal(disabledAgain.listening, false);
  await bounded(controlClosedAfterDisable, 2_000, "disabled access plane did not close control connection");
  await localCall(runtime, "system.shutdown");
  await bounded(new Promise((resolve) => server.once("exit", resolve)), 5_000, "daemon did not stop after access test");
  server = undefined;
  console.log("access-plane e2e: PASS");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGINT");
    await bounded(new Promise((resolve) => server.once("exit", resolve)), 3_000, "daemon cleanup timed out").catch(() => undefined);
  }
  for (const socket of targetSockets) socket.destroy();
  if (targetServer) await new Promise((resolve) => targetServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}

async function startServer() {
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env, TERMLOOP_RUNTIME_DIR: runtimeDirectory, TERMLOOP_STATE_DIR: stateDirectory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  const runtime = await waitUntil(async () => {
    try {
      const record = JSON.parse(await readFile(runtimeFile, "utf8"));
      return record.pid === child.pid ? record : undefined;
    } catch {
      return undefined;
    }
  }, 10_000, () => `daemon discovery did not appear: ${stderr}`);
  return [child, runtime];
}

async function localCall(runtime, method, params = {}) {
  const socket = await openSocket(runtime.controlUrl);
  try {
    const id = randomUUID();
    socket.send(JSON.stringify({ id, protocolVersion: CONTRACT_IDENTITY, token: runtime.token, method, params }));
    const response = await bounded(nextJson(socket), 12_000, `${method} timed out`);
    if (!response.ok) throw new Error(`${method} failed: ${response.error?.code ?? "unknown"}`);
    return response.result;
  } finally {
    socket.close();
  }
}

async function pair(url, pairingCode, publicKey, serverFingerprint) {
  const socket = await openSocket(url);
  try {
    const challenge = await bounded(nextJson(socket), 3_000, "pairing challenge timed out");
    assert.equal(challenge.kind, "pairChallenge");
    assert.equal(challenge.protocolVersion, ACCESS_PROTOCOL_IDENTITY);
    if (challenge.serverFingerprint !== serverFingerprint) {
      return { kind: "fingerprintMismatch" };
    }
    socket.send(JSON.stringify({
      kind: "pairExchange",
      protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      pairingCode,
      publicKey,
      serverFingerprint,
    }));
    return await bounded(nextJson(socket), 3_000, "pairing timed out");
  } finally {
    socket.close();
  }
}

async function enroll(url, deviceName, publicKey, serverFingerprint) {
  const socket = await openSocket(url);
  try {
    const challenge = await bounded(nextJson(socket), 3_000, "enrollment challenge timed out");
    assert.equal(challenge.kind, "pairChallenge");
    assert.equal(challenge.protocolVersion, ACCESS_PROTOCOL_IDENTITY);
    assert.equal(challenge.serverFingerprint, serverFingerprint);
    socket.send(JSON.stringify({
      kind: "enroll",
      protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      deviceName,
      publicKey,
      serverFingerprint,
    }));
    return await bounded(nextJson(socket), 3_000, "enrollment timed out");
  } finally {
    socket.close();
  }
}

async function authenticate(url, deviceId, privateKey, proofChannel, proofServerFingerprint) {
  const socket = await openSocket(url);
  const challenge = await bounded(nextJson(socket), 3_000, "challenge timed out");
  assert.equal(challenge.kind, "challenge");
  assert.equal(challenge.protocolVersion, ACCESS_PROTOCOL_IDENTITY);
  assert.equal(challenge.controlProtocolVersion, CONTRACT_IDENTITY);
  const signature = sign(
    null,
    Buffer.from(`tl-access-v1|${proofServerFingerprint ?? challenge.serverFingerprint}|${proofChannel}|${challenge.nonce}`),
    privateKey,
  ).toString("base64url");
  socket.send(JSON.stringify({
    kind: "authenticate",
    protocolVersion: ACCESS_PROTOCOL_IDENTITY,
    deviceId,
    signature,
  }));
  return {
    socket,
    signature,
    response: await bounded(nextJson(socket), 3_000, "authentication timed out"),
  };
}

async function remoteCall(socket, token, method, params = {}) {
  const id = randomUUID();
  socket.send(JSON.stringify({ id, protocolVersion: CONTRACT_IDENTITY, token, method, params }));
  while (true) {
    const message = await bounded(nextJson(socket), 12_000, `${method} timed out`);
    if (message.id === id) return message;
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    ensureSocketReader(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextJson(socket) {
  return nextSocketMessage(socket).then(({ raw, binary }) => {
    if (binary) throw new Error("expected JSON websocket message");
    return JSON.parse(String(raw));
  });
}

async function nextBinaryBytes(socket, expectedBytes) {
  const chunks = [];
  let receivedBytes = 0;
  while (receivedBytes < expectedBytes) {
    const chunk = await nextBinary(socket);
    chunks.push(chunk);
    receivedBytes += chunk.byteLength;
    if (receivedBytes > expectedBytes) throw new Error("forward returned more bytes than requested");
  }
  return Buffer.concat(chunks, receivedBytes);
}

function nextBinary(socket) {
  return nextSocketMessage(socket).then(({ raw, binary }) => {
    if (!binary) throw new Error(`expected binary websocket message, received ${String(raw)}`);
    return Buffer.from(raw);
  });
}

function terminalFrame(id, epoch, sequence, kind, payload = new Uint8Array()) {
  const compact = id.replaceAll("-", "");
  const bytes = new Uint8Array(41 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("TL01"));
  bytes.set(Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16)), 4);
  view.setBigUint64(20, BigInt(epoch));
  view.setBigUint64(28, BigInt(sequence));
  bytes[36] = kind;
  view.setUint32(37, payload.length);
  bytes.set(payload, 41);
  return bytes;
}

async function nextResizeOwnership(socket) {
  while (true) {
    const frame = await bounded(nextBinary(socket), 3_000, "resize ownership update timed out");
    if (frame.length >= 42 && frame[36] === 14) return frame[41] === 1;
  }
}

function nextSocketMessage(socket) {
  const reader = ensureSocketReader(socket);
  const queued = reader.queue.shift();
  if (queued) return Promise.resolve(queued);
  if (reader.ended) return Promise.reject(reader.ended);
  return new Promise((resolve, reject) => reader.waiters.push({ resolve, reject }));
}

function ensureSocketReader(socket) {
  let reader = socketReaders.get(socket);
  if (!reader) {
    reader = { queue: [], waiters: [], ended: undefined };
    socketReaders.set(socket, reader);
    socket.on("message", (raw, binary) => {
      const waiter = reader.waiters.shift();
      if (waiter) waiter.resolve({ raw, binary });
      else reader.queue.push({ raw, binary });
    });
    const end = (error) => {
      reader.ended = error;
      for (const waiter of reader.waiters.splice(0)) waiter.reject(error);
    };
    socket.once("close", () => end(new Error("socket closed")));
    socket.once("error", end);
  }
  return reader;
}

function onceClosed(socket) {
  return new Promise((resolve) => socket.once("close", resolve));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntil(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

async function bounded(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
