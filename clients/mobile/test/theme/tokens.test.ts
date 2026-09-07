import { describe, expect, it } from "vitest";

import appConfig from "../../app.json";
import { color, toneColor } from "../../src/theme/tokens";

describe("mobile light theme", () => {
  it("forces the native application into light appearance", () => {
    expect(appConfig.expo.userInterfaceStyle).toBe("light");
  });

  it("keeps every application surface light without returning to near-white glare", () => {
    for (const surface of [color.bgApp, color.bgRaised, color.bgSidebar, color.bgHover, color.bgTerminal]) {
      expect(relativeLuminance(surface)).toBeGreaterThan(0.58);
      expect(relativeLuminance(surface)).toBeLessThan(0.9);
    }
  });

  it("uses a brighter raised surface above the dimmer application canvas", () => {
    expect(relativeLuminance(color.bgRaised)).toBeGreaterThan(relativeLuminance(color.bgApp));
    expect(relativeLuminance(color.bgApp)).toBeGreaterThan(relativeLuminance(color.bgSidebar));
    expect(relativeLuminance(color.bgSidebar)).toBeGreaterThan(relativeLuminance(color.bgHover));
  });

  it("keeps small semantic text readable on the application canvas", () => {
    const foregrounds = [
      color.text,
      color.textSecondary,
      color.textMuted,
      color.accent,
      color.accentStrong,
      color.success,
      color.warning,
      color.danger,
      color.attention,
      color.agentClaude,
      color.agentCodex,
      ...Object.values(toneColor),
    ];

    for (const foreground of foregrounds) {
      expect(contrastRatio(foreground, color.bgApp)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps primary action labels readable", () => {
    expect(contrastRatio(color.onAccent, color.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(color.onAccent, color.accentStrong)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the product palette free of purple hues", () => {
    const palette = [...Object.values(color), ...Object.values(toneColor)];
    for (const value of palette) {
      const hue = hueDegrees(value);
      expect(hue < 250 || hue > 330, `${value} has a purple hue of ${hue}`).toBe(true);
    }
  });
});

function hueDegrees(value: string): number {
  const hex = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(value);
  const match = hex ?? /^rgba\((\d+),(\d+),(\d+),/.exec(value);
  if (match === null) throw new Error(`Expected a hex or rgba colour, received ${value}`);
  const radix = hex === null ? 10 : 16;
  const [red = 0, green = 0, blue = 0] = match.slice(1, 4).map((channel) => Number.parseInt(channel, radix));
  const channels = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = max === channels[0]
    ? ((channels[1] ?? 0) - (channels[2] ?? 0)) / delta
    : max === channels[1]
      ? 2 + ((channels[2] ?? 0) - (channels[0] ?? 0)) / delta
      : 4 + ((channels[0] ?? 0) - (channels[1] ?? 0)) / delta;
  hue = (hue * 60 + 360) % 360;
  return hue;
}

function contrastRatio(first: string, second: string): number {
  const brightest = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darkest = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brightest + 0.05) / (darkest + 0.05);
}

function relativeLuminance(value: string): number {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(value);
  if (match === null) throw new Error(`Expected a six-digit hex colour, received ${value}`);
  const channels = match.slice(1).map((channel) => linearise(Number.parseInt(channel, 16) / 255));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function linearise(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
