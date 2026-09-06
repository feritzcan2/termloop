import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const paletteSources = [
  "../src/app.css",
  "../src/skills.css",
  "../src/assets/ghostty-light.conf",
];

describe("desktop color palette", () => {
  it("does not expose purple or magenta in the app or light terminal", async () => {
    const offenders: string[] = [];

    for (const source of paletteSources) {
      const url = new URL(source, import.meta.url);
      const contents = await readFile(url, "utf8");
      for (const value of colorValues(contents)) {
        if (isPurple(value.rgb)) {
          offenders.push(`${fileURLToPath(url)}: ${value.literal}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function colorValues(contents: string): Array<{ literal: string; rgb: [number, number, number] }> {
  const values: Array<{ literal: string; rgb: [number, number, number] }> = [];
  const pattern = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/gi;

  for (const match of contents.matchAll(pattern)) {
    const literal = match[0];
    const rgb = literal.startsWith("#") ? hexToRgb(literal) : functionalColorToRgb(literal);
    if (rgb) values.push({ literal, rgb });
  }

  return values;
}

function hexToRgb(literal: string): [number, number, number] | undefined {
  let value = literal.slice(1);
  if (value.length === 3 || value.length === 4) {
    value = value.slice(0, 3).split("").map((digit) => digit + digit).join("");
  }
  if (value.length < 6) return undefined;
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function functionalColorToRgb(literal: string): [number, number, number] | undefined {
  const channels = [...literal.matchAll(/\d+/g)].slice(0, 3).map((match) => Number(match[0]));
  return channels.length === 3 ? channels as [number, number, number] : undefined;
}

function isPurple([red, green, blue]: [number, number, number]) {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const maximum = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const minimum = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return false;

  let hue: number;
  if (maximum === normalizedRed) hue = ((normalizedGreen - normalizedBlue) / delta) % 6;
  else if (maximum === normalizedGreen) hue = ((normalizedBlue - normalizedRed) / delta) + 2;
  else hue = ((normalizedRed - normalizedGreen) / delta) + 4;
  hue = (hue * 60 + 360) % 360;

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  return hue >= 245 && hue <= 335 && saturation >= 0.08;
}
