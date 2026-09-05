import { describe, expect, it } from "vitest";
import config from "../src/assets/ghostty-embedded.conf?raw";

describe("embedded Ghostty configuration", () => {
  it("does not allocate a standalone display link for embedded surfaces", () => {
    expect(config).toContain("window-vsync = false");
  });

  it("provides matching light and dark terminal themes", () => {
    expect(config).toContain("theme = light:Atom One Light,dark:Ghostty Default Style Dark");
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
