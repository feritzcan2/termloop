import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const complication = readFileSync(
  new URL("../targets/watch-widget/TermLoopComplication.swift", import.meta.url),
  "utf8",
);
const chatView = readFileSync(new URL("../targets/watch/ChatView.swift", import.meta.url), "utf8");
const recorder = readFileSync(new URL("../targets/watch/VoiceRecorder.swift", import.meta.url), "utf8");
const gatewayAPI = readFileSync(new URL("../targets/watch/WorktreesView.swift", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../scripts/mobile-access-gateway.mjs", import.meta.url), "utf8");

describe("watch quick Steward message", () => {
  it("routes the complication directly to the one-shot message screen", () => {
    expect(complication).toContain('widgetURL(URL(string: "termloop-watch://message"))');
    expect(complication).not.toContain('widgetURL(URL(string: "termloop-watch://talk"))');
  });

  it("starts recording before any project or transcript network read", () => {
    const run = chatView.slice(chatView.indexOf("private func run() async"), chatView.indexOf("private func loadProjects() async"));

    expect(run.indexOf("beginQuickMessage()")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("await loadProjects()")).toBeGreaterThan(run.indexOf("beginQuickMessage()"));
    expect(run.indexOf("await refresh()")).toBeGreaterThan(run.indexOf("beginQuickMessage()"));
    expect(chatView).toContain("if quickCapture, quickResult == .preparing, recorder.phase == .idle");
  });

  it("sends after one second of silence and leaves reply delivery asynchronous", () => {
    expect(recorder).toContain("private let tick = 0.1");
    expect(recorder).toContain("private let silenceTicksToStop = 10");
    expect(chatView).toContain('path: "/watch/voice"');
    expect(chatView).toContain('caption: "Yanıt bildirimle gelecek"');
  });

  it("leaves enough time for the parallel transcription providers", () => {
    expect(gatewayAPI).toContain("config.timeoutIntervalForResource = 45");
    expect(gatewayAPI).toContain("request.timeoutInterval = 40");
  });

  it("uses one OpenAI-first transcription path for every in-app Watch microphone", () => {
    expect(gateway).not.toContain("transcribeWatchRequest");
    expect(gateway.match(/const transcription = await transcribeVoiceRequest\(request\);/g)).toHaveLength(5);
    expect(gateway).toContain('diagnostics.report("voiceTranscription", "transcription_started"');
  });
});
