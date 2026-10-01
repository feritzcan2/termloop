import { describe, expect, it } from "vitest";

import { terminalStyleColors } from "../../src/presentation/terminal-colors";
import { TerminalScreenProjection } from "../../src/presentation/terminal-screen";
import { darkTheme, lightTheme } from "../../src/theme/tokens";

const esc = "\u001b";
const encoder = new TextEncoder();

function spans(output: string) {
  return new TerminalScreenProjection().write(encoder.encode(`${esc}[1;1H${output}`))!.lines[0]!.spans;
}

describe("terminal appearance", () => {
  it("recolors existing default and ANSI spans without replaying terminal output", () => {
    const original = spans(`plain${esc}[32mgreen${esc}[38;5;4mblue${esc}[0mreset`);
    const render = (theme: typeof lightTheme) => original.map((span) => terminalStyleColors(span.style, theme).color);
    expect(render(lightTheme)).toEqual([lightTheme.color.text, "#147A53", "#1769AA", lightTheme.color.text]);
    expect(render(darkTheme)).toEqual(["#FFFFFF", "#B5BD68", "#81A2BE", "#FFFFFF"]);
    expect(render(lightTheme)[0]).toBe(lightTheme.color.text);
    expect(original.map((span) => span.text)).toEqual(["plain", "green", "blue", "reset"]);
  });

  it("resolves inverse and faint against the selected canvas", () => {
    const inverse = spans(`${esc}[7mselected`)[0]!.style;
    for (const theme of [lightTheme, darkTheme]) {
      expect(terminalStyleColors(inverse, theme)).toEqual({ color: theme.color.bgTerminal, backgroundColor: theme.color.text });
    }
    const faint = spans(`${esc}[2mdim`)[0]!.style;
    expect(terminalStyleColors(faint, darkTheme).color).toBe("rgba(255, 255, 255, 0.62)");
    expect(terminalStyleColors(faint, lightTheme).color).toBe("rgba(23, 32, 51, 0.62)");
  });

  it("preserves explicit truecolor even when it equals a light palette color", () => {
    const explicit = spans(`${esc}[38;2;23;32;51mexact${esc}[38;5;196mred`);
    for (const theme of [lightTheme, darkTheme]) {
      expect(explicit.map((span) => terminalStyleColors(span.style, theme).color)).toEqual(["#172033", "#ff0000"]);
    }
  });

  it("recolors ANSI backgrounds and erased cells", () => {
    const background = spans(`${esc}[44mtext${esc}[K`);
    expect(background.every((span) => terminalStyleColors(span.style, darkTheme).backgroundColor === "#81A2BE")).toBe(true);
    expect(background.every((span) => terminalStyleColors(span.style, lightTheme).backgroundColor === "#1769AA")).toBe(true);
  });
});
