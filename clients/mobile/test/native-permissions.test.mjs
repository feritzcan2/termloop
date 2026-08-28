import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));

function pluginOptions(name) {
  const entry = app.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name);
  return entry?.[1];
}

describe("native permission configuration", () => {
  it("keeps the microphone usage description after Expo plugins run in reverse order", () => {
    const expected = app.expo.ios.infoPlist.NSMicrophoneUsageDescription;

    expect(expected).toContain("Steward");
    expect(pluginOptions("expo-camera")?.microphonePermission).toBe(expected);
    expect(pluginOptions("expo-audio")?.microphonePermission).toBe(expected);
    expect(pluginOptions("expo-camera")?.recordAudioAndroid).toBe(false);
    expect(pluginOptions("expo-audio")?.recordAudioAndroid).toBe(true);
  });
});
