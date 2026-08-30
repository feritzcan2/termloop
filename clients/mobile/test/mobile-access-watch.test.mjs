import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  WATCH_PAIR_TTL_MS,
  hashPairCode,
  parseWatchTarget,
  patchTextOf,
  promptSessionName,
  validatePairCode,
  watchProjectWorktreeOf,
  watchTaskWorktreeOf,
} from "../scripts/mobile-access-watch.mjs";
import {
  encodeTerminalFrame,
  replyInputBytes,
  validWatchReply,
} from "../scripts/mobile-access-terminal-input.mjs";
import {
  acceptableTurkishTranscript,
  transcriptionOf,
  validVoiceUpload,
  voiceContainerOf,
  voiceUploadLimitBytes,
} from "../scripts/mobile-access-transcribe.mjs";

describe("watch voice upload helpers", () => {
  it("names prompted Sessions like a Quick Action", () => {
    expect(promptSessionName("  Review this diff  \nThen run tests")).toBe("Review this diff");
    expect(promptSessionName(`  ${"🚀".repeat(81)}  `)).toBe("🚀".repeat(80));
    expect(promptSessionName(" \n\t ")).toBeNull();
  });

  it("accepts only recorded audio within the size ceiling", () => {
    expect(validVoiceUpload("audio/m4a", 1024)).toBe(true);
    expect(validVoiceUpload("audio/mp4; codecs=mp4a", 1024)).toBe(true);
    expect(validVoiceUpload("audio/wav", 1024)).toBe(true);
    expect(validVoiceUpload("application/json", 1024)).toBe(false);
    expect(validVoiceUpload("audio/m4a", 0)).toBe(false);
    expect(validVoiceUpload("audio/m4a", voiceUploadLimitBytes + 1)).toBe(false);
    expect(validVoiceUpload(undefined, 1024)).toBe(false);
  });

  it("classifies only the recording container for privacy-safe diagnostics", () => {
    expect(voiceContainerOf(Buffer.from("RIFF1234WAVEdata"))).toBe("wav");
    expect(voiceContainerOf(Buffer.from("0000ftypM4A  "))).toBe("isobmff");
    expect(voiceContainerOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(voiceContainerOf(Buffer.from("not audio"))).toBe("unknown");
  });

  it("reads the transcript and whether it stayed on device", () => {
    expect(transcriptionOf('{"text":"  merhaba stew ","onDevice":true}'))
      .toEqual({ text: "merhaba stew", onDevice: true });
    expect(transcriptionOf('{"text":"","onDevice":false}')).toEqual({ text: "", onDevice: false });
    expect(() => transcriptionOf("not json")).toThrow();
  });

  it("accepts Turkish and technical Latin text but rejects unrelated scripts", () => {
    expect(acceptableTurkishTranscript("Nucleus PR'ını development'a gönder")).toBe(true);
    expect(acceptableTurkishTranscript("Ödeme durumunu Jira'dan kontrol et")).toBe(true);
    expect(acceptableTurkishTranscript("Проверь статус оплаты")).toBe(false);
    expect(acceptableTurkishTranscript("支払い状況を確認して")).toBe(false);
    expect(acceptableTurkishTranscript("   ")).toBe(false);
  });
});

describe("watch terminal input helpers", () => {
  it("turns dictated text into a plain prompt line and strips control bytes", () => {
    const bytes = replyInputBytes("yes[31m do\nit");
    expect(new TextDecoder().decode(bytes)).toBe("yes[31m do it\r");
  });

  it("frames input with the session identity and payload length", () => {
    const frame = encodeTerminalFrame("11111111-2222-3333-4444-555555555555", 3, 2, 1, new Uint8Array([65]));
    expect(new TextDecoder().decode(frame.slice(0, 4))).toBe("TL01");
    expect(frame[36]).toBe(1);
    expect(frame.byteLength).toBe(42);
    expect(frame[41]).toBe(65);
  });

  it("rejects malformed reply bodies", () => {
    const valid = { sessionId: "11111111-2222-3333-4444-555555555555", runtimeEpoch: 3, text: "ok" };
    expect(validWatchReply(valid)).toBe(true);
    expect(validWatchReply({ ...valid, sessionId: "../etc" })).toBe(false);
    expect(validWatchReply({ ...valid, runtimeEpoch: -1 })).toBe(false);
    expect(validWatchReply({ ...valid, text: "   " })).toBe(false);
    expect(validWatchReply({ ...valid, text: "x".repeat(5000) })).toBe(false);
  });
});

describe("watch facade helpers", () => {
  it("accepts only a fresh, well-formed, matching pair code", () => {
    const stored = { codeHash: hashPairCode("123456"), expiresAtEpochMs: 1_000 + WATCH_PAIR_TTL_MS };
    expect(validatePairCode(stored, "123456", 1_000)).toBe(true);
    expect(validatePairCode(stored, "654321", 1_000)).toBe(false);
    expect(validatePairCode(stored, "123456", 1_000 + WATCH_PAIR_TTL_MS + 1)).toBe(false);
    expect(validatePairCode(stored, "12345", 1_000)).toBe(false);
    expect(validatePairCode(stored, 123456, 1_000)).toBe(false);
    expect(validatePairCode(undefined, "123456", 1_000)).toBe(false);
    expect(validatePairCode({ codeHash: 5, expiresAtEpochMs: 2_000 }, "123456", 1_000)).toBe(false);
  });

  it("parses watch targets strictly", () => {
    expect(parseWatchTarget("task:abc-123")).toEqual({ scope: "task", id: "abc-123" });
    expect(parseWatchTarget("project:p1")).toEqual({ scope: "project", id: "p1" });
    expect(parseWatchTarget("session:x")).toBeNull();
    expect(parseWatchTarget("task:")).toBeNull();
    expect(parseWatchTarget(undefined)).toBeNull();
  });

  it("renders every diff state as text", () => {
    expect(patchTextOf({ state: "patch", patch: "diff" })).toBe("diff");
    expect(patchTextOf({ state: "truncated", patch: "diff" })).toContain("truncated");
    expect(patchTextOf({ state: "binary", patch: null })).toBe("(binary file)");
    expect(patchTextOf({ state: "nonUtf8", patch: null })).toContain("non-UTF-8");
    expect(patchTextOf({ state: "notShown", patch: null })).toBe("(diff not shown)");
    expect(patchTextOf(undefined)).toBe("(diff not shown)");
  });

  it("maps task and project worktrees to the watch shape", () => {
    const entries = [{
      entry_id: "e1", display_path: "src/a.ts", original_display_path: null,
      path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
    }];
    expect(watchTaskWorktreeOf(
      { id: "t1", title: "Watch task", branch: { repository_root: "/r", name: "feat/w" }, worktree: { path: "/wt" } },
      { observation_id: "o1", entries, truncated: false },
    )).toEqual({
      id: "task:t1", name: "Watch task", branch: "feat/w", path: "/wt", truncated: false,
      files: [{ entryId: "e1", path: "src/a.ts", kind: "modified", side: "unstaged" }],
    });
    expect(watchProjectWorktreeOf(
      { id: "p1", name: "TermLoop", folder_path: "/repo" },
      { observation_id: "o2", entries: [], truncated: true },
    )).toMatchObject({ id: "project:p1", name: "TermLoop", path: "/repo", truncated: true, files: [] });
  });
});

describe("watch facade over the gateway", () => {
  it("pairs once with a short code and serves worktrees and patches over plain HTTP", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-watch-facade-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const pairFile = path.join(directory, "watch-pair.json");
    const tokensSeen = [];
    const terminalMessages = [];
    const voiceRequests = [];
    const upstreamServer = http.createServer(async (request, response) => {
      const body = Buffer.concat(await Array.fromAsync(request));
      voiceRequests.push({
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      if (request.url === "/voice/transcriptions") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ text: "OpenAI saatten sesli mesaj" }));
        return;
      }
      if (request.url === "/voice/speech") {
        response.writeHead(200, { "content-type": "audio/mpeg" });
        response.end("fake Steward mp3");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    upstreamSockets.on("connection", (socket, request) => {
      if (request.url === "/terminal") {
        socket.on("message", (data) => {
          terminalMessages.push(Buffer.from(data));
          if ((terminalMessages.length - 1) % 4 === 0) socket.send("TLOK");
        });
        return;
      }
      socket.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        tokensSeen.push({
          method: parsed.method,
          token: parsed.token,
          protocolVersion: parsed.protocolVersion,
          params: parsed.params,
        });
        if (parsed.method === "companion.proposalRespond"
          && parsed.params?.proposalMessageId === "stale-proposal") {
          socket.send(JSON.stringify({
            id: parsed.id,
            ok: false,
            error: { code: "conflict", message: "state revision changed", details: null },
          }));
          return;
        }
        socket.send(JSON.stringify({ id: parsed.id, ok: true, result: upstreamResult(parsed) }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, JSON.stringify({
      controlUrl: `ws://127.0.0.1:${upstreamPort}/control`,
      terminalUrl: `ws://127.0.0.1:${upstreamPort}/terminal`,
      protocolVersion: `sha256:${"e".repeat(64)}`,
      token: "f".repeat(64),
      readOnlyToken: "r".repeat(64),
      terminalToken: "t".repeat(64),
    }));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 1,
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
      watchToken: "w".repeat(64),
    }));
    writeFileSync(pairFile, JSON.stringify({
      codeHash: hashPairCode("246810"),
      expiresAtEpochMs: Date.now() + WATCH_PAIR_TTL_MS,
    }));
    // A stand-in for the Swift speech tool: the route, its authorization, and
    // the transcript-to-Steward hand-off are what this test owns; the real
    // recognizer needs the Mac's speech permission.
    const fakeTranscriber = path.join(directory, "fake-transcriber.mjs");
    writeFileSync(fakeTranscriber, 'process.stdout.write(\'{"text":"saatten sesli mesaj","onDevice":true}\');\n');
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."),
      stdio: "ignore",
      env: { ...process.env, TERMLOOP_TRANSCRIBER_BIN: fakeTranscriber },
    });
    try {
      await waitForHealth(gatewayPort);
      const base = `http://127.0.0.1:${gatewayPort}`;

      const wrongCode = await fetch(`${base}/watch/pair`, { method: "POST", body: JSON.stringify({ code: "000000" }) });
      expect(wrongCode.status).toBe(401);

      const paired = await fetch(`${base}/watch/pair`, { method: "POST", body: JSON.stringify({ code: "246810" }) });
      expect(paired.status).toBe(200);
      expect((await paired.json()).token).toBe("w".repeat(64));
      expect(existsSync(pairFile)).toBe(false);

      const replay = await fetch(`${base}/watch/pair`, { method: "POST", body: JSON.stringify({ code: "246810" }) });
      expect(replay.status).toBe(401);

      // The phone-authenticated credential route: only the full mobile
      // credential may fetch the watch token; the watch token itself may not.
      const credentialAnonymous = await fetch(`${base}/watch/credential`);
      expect(credentialAnonymous.status).toBe(401);
      const credentialWatchBearer = await fetch(`${base}/watch/credential`, {
        headers: { authorization: `Bearer ${"w".repeat(64)}` },
      });
      expect(credentialWatchBearer.status).toBe(401);
      const credential = await fetch(`${base}/watch/credential`, {
        headers: { authorization: `Bearer ${"c".repeat(64)}` },
      });
      expect(credential.status).toBe(200);
      expect(await credential.json()).toEqual({ paired: true, token: "w".repeat(64) });

      const unauthorized = await fetch(`${base}/watch/worktrees`);
      expect(unauthorized.status).toBe(401);

      const authorization = { authorization: `Bearer ${"w".repeat(64)}` };
      const worktrees = await (await fetch(`${base}/watch/worktrees`, { headers: authorization })).json();
      expect(worktrees.worktrees).toEqual([
        {
          id: "project:p1", name: "TermLoop", branch: null, path: "/repo", truncated: false,
          files: [{ entryId: "pe1", path: "README.md", kind: "modified", side: "staged" }],
        },
        {
          id: "task:t1", name: "Watch task", branch: "feat/watch", path: "/repo-wt", truncated: false,
          files: [{ entryId: "e1", path: "src/a.ts", kind: "modified", side: "unstaged" }],
        },
      ]);

      const patches = await (await fetch(`${base}/watch/patches?wt=task:t1`, { headers: authorization })).json();
      expect(patches.files).toEqual([{ path: "src/a.ts", patch: "diff --git a/src/a.ts b/src/a.ts" }]);

      const badTarget = await fetch(`${base}/watch/patches?wt=oops`, { headers: authorization });
      expect(badTarget.status).toBe(400);

      const status = await (await fetch(`${base}/watch/status`, { headers: authorization })).json();
      expect(status.projects).toEqual([{ id: "p1", name: "TermLoop" }]);
      // The Steward session stays out of the wrist status list.
      expect(status.sessions).toEqual([{
        id: "11111111-2222-3333-4444-555555555555", runtimeEpoch: 3, name: "Watch agent",
        agent: "Claude", projectId: "p1", cwd: "/repo-wt", status: "awaitingInput",
      }]);

      const tasks = await (await fetch(`${base}/watch/tasks`, { headers: authorization })).json();
      expect(tasks.tasks).toEqual([{
        id: "t1", title: "Watch task", projectId: "p1", projectName: "TermLoop",
        branch: "feat/watch", hasWorktree: true,
      }]);

      const chatSent = await (await fetch(`${base}/watch/chat`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", content: "watch hello" }),
      })).json();
      expect(chatSent.message).toMatchObject({ author: "user", content: "watch hello", sequence: 2 });

      const proposalApproved = await (await fetch(`${base}/watch/steward-action`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", messageId: "proposal-1", action: "approve" }),
      })).json();
      expect(proposalApproved.message).toMatchObject({ author: "user", kind: "approval", sequence: 3 });
      expect(tokensSeen.find((entry) => entry.method === "companion.proposalRespond")?.params).toEqual({
        projectId: "p1", proposalMessageId: "proposal-1", decision: "approve",
      });

      const suggestionAccepted = await (await fetch(`${base}/watch/steward-action`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", messageId: "suggestion-1", action: "accept" }),
      })).json();
      expect(suggestionAccepted.message).toMatchObject({ author: "user", kind: "reply", sequence: 4 });
      expect(tokensSeen.find((entry) => entry.method === "companion.suggestionAccept")?.params).toEqual({
        projectId: "p1", suggestionMessageId: "suggestion-1",
      });

      const invalidStewardAction = await fetch(`${base}/watch/steward-action`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", messageId: "proposal-1", action: "delete" }),
      });
      expect(invalidStewardAction.status).toBe(400);

      const staleStewardAction = await fetch(`${base}/watch/steward-action`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", messageId: "stale-proposal", action: "approve" }),
      });
      expect(staleStewardAction.status).toBe(409);
      expect(await staleStewardAction.json()).toEqual({
        error: "This Steward request is no longer pending",
      });

      // A recording becomes an ordinary Steward transcript append.
      const voiceUnauthorized = await fetch(`${base}/watch/voice?project=p1`, {
        method: "POST",
        headers: { "content-type": "audio/m4a" },
        body: Buffer.from("audio"),
      });
      expect(voiceUnauthorized.status).toBe(401);

      const voiceWrongType = await fetch(`${base}/watch/voice?project=p1`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: Buffer.from("audio"),
      });
      expect(voiceWrongType.status).toBe(400);

      const voiceBadProject = await fetch(`${base}/watch/voice?project=../etc`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("audio"),
      });
      expect(voiceBadProject.status).toBe(400);

      const voiceSent = await (await fetch(`${base}/watch/voice?project=p1`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      })).json();
      expect(voiceSent.transcript).toBe("OpenAI saatten sesli mesaj");
      // The transcript, not the raw audio, is what reaches the Steward.
      const voiceAppend = tokensSeen.filter((entry) => entry.method === "companion.transcriptAppend").at(-1);
      expect(voiceAppend?.params).toMatchObject({
        projectId: "p1",
        inputMode: "voice",
        content: "OpenAI saatten sesli mesaj",
      });
      expect(voiceRequests.find((entry) => entry.url === "/voice/transcriptions")).toMatchObject({
        authorization: `Bearer ${"f".repeat(64)}`,
        contentType: "audio/m4a",
      });
      // The uploaded recording is not left behind on disk.
      expect(readdirSync(path.dirname(gatewayConfig)).some((entry) => entry.startsWith("watch-voice-"))).toBe(false);

      // The phone uses the same provider path with its owner credential. The
      // watch-scoped token cannot call the mobile route.
      const mobileVoiceWithWatchToken = await fetch(`${base}/steward/voice?project=p1`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      });
      expect(mobileVoiceWithWatchToken.status).toBe(401);
      const ownerAuthorization = { authorization: `Bearer ${"c".repeat(64)}` };
      const mobileTranscribeWithWatchToken = await fetch(`${base}/steward/transcribe`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      });
      expect(mobileTranscribeWithWatchToken.status).toBe(401);
      const appendCountBeforePreview = tokensSeen.filter((entry) => entry.method === "companion.transcriptAppend").length;
      const mobilePreview = await (await fetch(`${base}/steward/transcribe`, {
        method: "POST",
        headers: { ...ownerAuthorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      })).json();
      expect(mobilePreview).toEqual({ transcript: "OpenAI saatten sesli mesaj" });
      expect(tokensSeen.filter((entry) => entry.method === "companion.transcriptAppend"))
        .toHaveLength(appendCountBeforePreview);
      const mobileVoice = await (await fetch(`${base}/steward/voice?project=p1`, {
        method: "POST",
        headers: { ...ownerAuthorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      })).json();
      expect(mobileVoice.transcript).toBe("OpenAI saatten sesli mesaj");
      expect(tokensSeen.filter((entry) => entry.method === "companion.transcriptAppend").at(-1)?.params)
        .toMatchObject({ projectId: "p1", inputMode: "voice" });

      const speech = await fetch(`${base}/watch/speech`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", sequence: 1 }),
      });
      expect(speech.status).toBe(200);
      expect(Buffer.from(await speech.arrayBuffer()).toString()).toBe("fake Steward mp3");
      const speechRequest = voiceRequests.find((entry) => entry.url === "/voice/speech");
      expect(speechRequest?.authorization).toBe(`Bearer ${"f".repeat(64)}`);
      expect(JSON.parse(speechRequest?.body.toString() ?? "{}")).toEqual({ text: "hi" });

      const mobileSpeechWithWatchToken = await fetch(`${base}/steward/speech`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", sequence: 1 }),
      });
      expect(mobileSpeechWithWatchToken.status).toBe(401);
      const mobileSpeech = await fetch(`${base}/steward/speech`, {
        method: "POST",
        headers: { ...ownerAuthorization, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", sequence: 1 }),
      });
      expect(mobileSpeech.status).toBe(200);
      expect(Buffer.from(await mobileSpeech.arrayBuffer()).toString()).toBe("fake Steward mp3");

      const chat = await (await fetch(`${base}/watch/chat?project=p1`, { headers: authorization })).json();
      expect(chat.messages).toEqual([{
        id: "m1", sequence: 1, author: "steward", kind: "reply", content: "hi", atEpochMs: 1,
      }]);

      const launched = await (await fetch(`${base}/watch/task-agent`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ taskId: "t1" }),
      })).json();
      expect(launched.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      // The launch consumed the exact ticket the inspected preview issued.
      const launchCall = tokensSeen.find((entry) => entry.method === "task.launchAgent");
      expect(launchCall?.params).toMatchObject({ taskId: "t1", agentId: "claude", launchTicket: "c".repeat(64) });

      const projectLaunched = await (await fetch(`${base}/watch/project-agent`, {
        method: "POST",
        headers: authorization,
        // A caller-supplied cwd must be ignored; only Core's Project folder is
        // authoritative for the launch target.
        body: JSON.stringify({ projectId: "p1", agentId: "codex", cwd: "/untrusted" }),
      })).json();
      expect(projectLaunched.sessionId).toBe("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
      expect(projectLaunched.runtimeEpoch).toBe(1);
      const projectPreview = tokensSeen.find((entry) => entry.method === "session.previewAgent");
      expect(projectPreview?.params).toEqual({ projectId: "p1", cwd: "/repo", agentId: "codex" });
      const projectLaunch = tokensSeen.find((entry) => entry.method === "session.launchAgent");
      expect(projectLaunch?.params).toEqual({
        projectId: "p1", cwd: "/repo", agentId: "codex", launchTicket: "d".repeat(64),
      });

      const missingProject = await fetch(`${base}/watch/project-agent`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "missing" }),
      });
      expect(missingProject.status).toBe(404);

      const replied = await (await fetch(`${base}/watch/reply`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({
          sessionId: "11111111-2222-3333-4444-555555555555", runtimeEpoch: 3, text: "yes do it",
        }),
      })).json();
      expect(replied.delivered).toBe(true);
      // Auth preamble, attach, bracketed paste, then a distinct submit frame.
      expect(terminalMessages[0].toString("utf8")).toBe(`TL01${"t".repeat(64)}`);
      expect(terminalMessages).toHaveLength(4);
      expect(terminalMessages[1][36]).toBe(10);
      expect(terminalMessages[2][36]).toBe(1);
      expect(terminalMessages[2].subarray(41).toString("utf8")).toBe("\u001b[200~yes do it\u001b[201~");
      expect(terminalMessages[3].subarray(41)).toEqual(Buffer.from("\r"));

      const voiceReplied = await (await fetch(
        `${base}/watch/reply-voice?session=11111111-2222-3333-4444-555555555555&epoch=3`,
        {
          method: "POST",
          headers: { ...authorization, "content-type": "audio/m4a" },
          body: Buffer.from("fake m4a bytes"),
        },
      )).json();
      expect(voiceReplied.delivered).toBe(true);
      expect(voiceReplied.transcript).toBe("saatten sesli mesaj");
      expect(terminalMessages).toHaveLength(8);
      expect(terminalMessages[6].subarray(41).toString("utf8"))
        .toBe("\u001b[200~saatten sesli mesaj\u001b[201~");
      expect(terminalMessages[7].subarray(41)).toEqual(Buffer.from("\r"));

      const invalidVoiceTarget = await fetch(`${base}/watch/reply-voice?session=../etc&epoch=3`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      });
      expect(invalidVoiceTarget.status).toBe(400);

      const voiceProjectLaunch = await (await fetch(
        `${base}/watch/project-agent-voice?project=p1&agent=codex`,
        {
          method: "POST",
          headers: { ...authorization, "content-type": "audio/m4a" },
          body: Buffer.from("fake m4a bytes"),
        },
      )).json();
      expect(voiceProjectLaunch).toMatchObject({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        name: "saatten sesli mesaj",
        runtimeEpoch: 1,
        promptDelivered: true,
        transcript: "saatten sesli mesaj",
      });
      expect(terminalMessages).toHaveLength(8);
      const voiceQuickActionPreview = tokensSeen.filter((entry) => entry.method === "quickAction.preview").at(-1);
      expect(voiceQuickActionPreview?.params).toMatchObject({
        projectId: "p1",
        cwd: "/repo",
        agentId: "codex",
        templateRef: "builtin.quick-action.free-prompt",
        bindings: { prompt: "saatten sesli mesaj" },
        attachments: [],
      });
      const voiceQuickActionLaunch = tokensSeen.filter((entry) => entry.method === "quickAction.launch").at(-1);
      expect(voiceQuickActionLaunch?.params.launchTicket).toBe("b".repeat(64));

      // Transcribe-only: the watch previews the prompt text before launching.
      const transcribed = await (await fetch(`${base}/watch/transcribe`, {
        method: "POST",
        headers: { ...authorization, "content-type": "audio/m4a" },
        body: Buffer.from("fake m4a bytes"),
      })).json();
      expect(transcribed).toEqual({ transcript: "saatten sesli mesaj" });
      expect(terminalMessages).toHaveLength(8);

      // A confirmed text prompt launches and delivers those exact words.
      const promptLaunch = await (await fetch(`${base}/watch/project-agent`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", agentId: "codex", prompt: "onaylanan prompt" }),
      })).json();
      expect(promptLaunch).toMatchObject({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        name: "onaylanan prompt",
        runtimeEpoch: 1,
        promptDelivered: true,
      });
      expect(terminalMessages).toHaveLength(8);
      const textQuickActionLaunch = tokensSeen.filter((entry) => entry.method === "quickAction.launch").at(-1);
      expect(textQuickActionLaunch?.params).toMatchObject({
        bindings: { prompt: "onaylanan prompt" },
        launchTicket: "b".repeat(64),
      });
      expect(tokensSeen.filter((entry) => entry.method === "session.rename")).toEqual([]);

      const blankPrompt = await fetch(`${base}/watch/project-agent`, {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ projectId: "p1", agentId: "codex", prompt: "   " }),
      });
      expect(blankPrompt.status).toBe(400);

      const readOnlyMethods = tokensSeen.filter((entry) => ["project.list", "task.list"].includes(entry.method));
      expect(readOnlyMethods.length).toBeGreaterThan(0);
      for (const entry of readOnlyMethods) expect(entry.token).toBe("r".repeat(64));
      const fullMethods = tokensSeen.filter((entry) => entry.method.includes("worktree"));
      expect(fullMethods.length).toBeGreaterThan(0);
      for (const entry of fullMethods) expect(entry.token).toBe("f".repeat(64));
      // Facade calls carry the live discovery file's protocol version, not a
      // compile-time contract identity, so the gateway survives daemon rebuilds.
      for (const entry of tokensSeen) expect(entry.protocolVersion).toBe(`sha256:${"e".repeat(64)}`);
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });

  it("accepts the watch credential for push registration", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-watch-push-"));
    const runtimeFile = path.join(directory, "runtime.json");
    const gatewayConfig = path.join(directory, "gateway.json");
    const devicesFile = path.join(directory, "push-devices.json");
    const upstreamServer = http.createServer();
    const upstreamSockets = new WebSocketServer({ server: upstreamServer });
    upstreamSockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        const result = request.method === "session.list" || request.method === "agent.statusList" ? [] : {};
        socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      });
    });
    const upstreamPort = await listen(upstreamServer);
    writeFileSync(runtimeFile, JSON.stringify({
      controlUrl: `ws://127.0.0.1:${upstreamPort}/control`,
      terminalUrl: `ws://127.0.0.1:${upstreamPort}/terminal`,
      readOnlyToken: "r".repeat(64),
      terminalToken: "t".repeat(64),
    }));
    const gatewayPort = await freePort();
    writeFileSync(gatewayConfig, JSON.stringify({
      version: 2,
      connectionId: "mac_fixture",
      macName: "Fixture Mac",
      runtimeFile,
      port: gatewayPort,
      controlToken: "c".repeat(64),
      terminalToken: "m".repeat(64),
      watchToken: "w".repeat(64),
      pushDevicesFile: devicesFile,
      apnsConfigFile: path.join(directory, "missing-apns.json"),
    }));
    const gateway = spawn(process.execPath, [path.resolve("scripts/mobile-access-gateway.mjs"), gatewayConfig], {
      cwd: path.resolve("."), stdio: "ignore",
    });
    try {
      await waitForHealth(gatewayPort);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/push/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${"w".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify({
          deviceToken: "b".repeat(64),
          environment: "development",
          bundleId: "ai.termloop.watchreach",
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(devicesFile, "utf8")).devices[0]).toMatchObject({
        deviceToken: "b".repeat(64), bundleId: "ai.termloop.watchreach",
      });
    } finally {
      gateway.kill("SIGTERM");
      upstreamSockets.close();
      upstreamServer.close();
    }
  });
});

function upstreamResult(request) {
  switch (request.method) {
    case "project.list":
      return [{ id: "p1", name: "TermLoop", folder_path: "/repo" }];
    case "task.list":
      return {
        items: [{
          id: "t1", project_id: "p1", title: "Watch task", brief: null, jira_url: null,
          status: "open", archived_at_epoch_ms: null,
          branch: { repository_root: "/repo", name: "feat/watch" },
          worktree: { path: "/repo-wt" },
          rank: 1, created_at_epoch_ms: 1, updated_at_epoch_ms: 1,
        }],
        next_cursor: null,
      };
    case "project.worktreeChangeList":
      return {
        project_id: "p1", observation_id: "obs-p", truncated: false,
        entries: [{
          entry_id: "pe1", display_path: "README.md", original_display_path: null,
          path_encoding: "utf8", side: "staged", kind: "modified", render_state: "available",
        }],
      };
    case "task.worktreeChangeList":
      return {
        task_id: "t1", observation_id: "obs-1", worktree_generation: 1, truncated: false,
        entries: [{
          entry_id: "e1", display_path: "src/a.ts", original_display_path: null,
          path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
        }],
      };
    case "task.worktreeDiff":
      return {
        task_id: "t1", observation_id: "obs-1", entry_id: "e1",
        state: "patch", patch: "diff --git a/src/a.ts b/src/a.ts",
      };
    case "session.list":
      return [
        {
          id: "11111111-2222-3333-4444-555555555555", project_id: "p1", name: "Watch agent",
          kind: "Agent", lifecycle_state: "running", runtime_epoch: 3,
          process: { agent_id: "claude", cwd: "/repo-wt", template_ref: "builtin.agent.interactive" },
        },
        {
          id: "99999999-8888-7777-6666-555555555555", project_id: "p1", name: "Project Steward",
          kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
          process: { agent_id: "claude", cwd: "/repo", template_ref: "builtin.steward.persistent" },
        },
      ];
    case "agent.statusList":
      return [
        { sessionId: "11111111-2222-3333-4444-555555555555", status: "awaitingInput", source: "hook", observedAtEpochMs: 1 },
      ];
    case "companion.transcriptAppend":
      return {
        message: {
          id: "m2", projectId: "p1", sequence: 2, author: "user", kind: "reply",
          content: "watch hello", createdAtEpochMs: 5,
        },
        usage: {}, stateRevision: 1,
      };
    case "companion.transcriptList":
      return {
        messages: [
          { id: "m1", projectId: "p1", sequence: 1, author: "steward", kind: "reply", content: "hi", createdAtEpochMs: 1 },
        ],
        nextBeforeSequence: null, usage: {}, stateRevision: 1,
      };
    case "companion.proposalRespond":
      return {
        message: {
          id: "m3", projectId: "p1", sequence: 3, author: "user", kind: "approval",
          content: "Approved. Proceed with the proposed action.", createdAtEpochMs: 6,
        },
        usage: {}, stateRevision: 2,
      };
    case "companion.suggestionAccept":
      return {
        message: {
          id: "m4", projectId: "p1", sequence: 4, author: "user", kind: "reply",
          content: "Accepted. Proceed with this suggestion.", createdAtEpochMs: 7,
        },
        usage: {}, stateRevision: 3,
      };
    case "task.previewAgent":
      return { launch_ticket: "c".repeat(64), manifest: {} };
    case "task.launchAgent":
      return {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", project_id: "p1", name: "Task agent",
        kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
        process: { agent_id: "claude", cwd: "/repo-wt", template_ref: "builtin.agent.interactive" },
      };
    case "session.previewAgent":
      return { launch_ticket: "d".repeat(64), manifest: {} };
    case "session.launchAgent":
      return {
        id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", project_id: "p1", name: "Project agent",
        kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
        process: { agent_id: "codex", cwd: "/repo", template_ref: "builtin.agent.interactive" },
      };
    case "session.rename":
      return {
        id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", project_id: "p1", name: request.params.name,
        kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
        process: { agent_id: "codex", cwd: "/repo", template_ref: "builtin.agent.interactive" },
      };
    case "quickAction.preview":
      return { launch_ticket: "b".repeat(64), manifest: {} };
    case "quickAction.launch":
      return {
        id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", project_id: "p1",
        name: request.params.bindings.prompt.split("\n", 1)[0].slice(0, 80),
        kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
        process: { agent_id: request.params.agentId, cwd: "/repo", template_ref: request.params.templateRef },
      };
    default:
      return { product: "TermLoop", version: "0.1.0", protocolVersion: `sha256:${"a".repeat(64)}` };
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Gateway still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("gateway did not become healthy");
}
