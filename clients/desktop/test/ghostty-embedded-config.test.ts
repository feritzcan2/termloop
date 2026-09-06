import { describe, expect, it } from "vitest";
import config from "../src/assets/ghostty-embedded.conf?raw";
import lightConfig from "../src/assets/ghostty-light.conf?raw";

describe("embedded Ghostty configuration", () => {
  it("does not allocate a standalone display link for embedded surfaces", () => {
    expect(config).toContain("window-vsync = false");
  });

  it("keeps the original dark terminal config free of color overrides", () => {
    expect(config).not.toContain("theme =");
    expect(config).not.toContain("background =");
    expect(config).not.toContain("palette =");
  });

  it("provides a complete light terminal palette", () => {
    expect(lightConfig).toContain("background = #f9f9f9");
    expect(lightConfig).toContain("foreground = #2a2c33");
    expect(lightConfig.match(/^palette = /gm)).toHaveLength(16);
    expect(lightConfig).toContain("palette = 5=#a35300");
    expect(lightConfig).toContain("palette = 13=#8a4500");
  });

  it.each([
    "ctrl+tab",
    "ctrl+shift+tab",
    "super+n",
    "super+q",
    "super+w",
    "super+t",
    "super+d",
    "super+shift+d",
    "super+left_bracket",
    "super+right_bracket",
    "super+alt+left",
    "super+alt+right",
  ])("unbinds standalone lifecycle chord %s", (chord) => {
    expect(config).toContain(`keybind = ${chord}=unbind`);
  });

  it.each(["super+c", "super+v", "super+f", "super+a", "super+k"])(
    "preserves terminal-local chord %s",
    (chord) => expect(config).not.toContain(`keybind = ${chord}=unbind`),
  );
});
