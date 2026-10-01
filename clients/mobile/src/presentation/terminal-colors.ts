import type { MobileTheme } from "../theme/tokens";
import type { TerminalStyle } from "./terminal-screen";

const lightAnsi = [
  "#1F2937", "#B4233A", "#147A53", "#8A5700",
  "#1769AA", "#93400F", "#087485", "#596579",
  "#667085", "#C53049", "#167B53", "#945D00",
  "#1B70B4", "#963F0E", "#08788A", "#344054",
] as const;

// Ghostty's default 16-color palette, from vendor/ghostty/src/terminal/color.zig.
const ghosttyAnsi = [
  "#1D1F21", "#CC6666", "#B5BD68", "#F0C674",
  "#81A2BE", "#B294BB", "#8ABEB7", "#C5C8C6",
  "#666666", "#D54E53", "#B9CA4A", "#E7C547",
  "#7AA6DA", "#C397D8", "#70C0B1", "#EAEAEA",
] as const;

export function terminalStyleColors(style: TerminalStyle, theme: MobileTheme): {
  color: string;
  backgroundColor?: string;
} {
  const foreground = resolveColor(style.foreground, theme);
  return {
    color: style.faint ? faded(foreground) : foreground,
    ...(style.background === undefined ? {} : { backgroundColor: resolveColor(style.background, theme) }),
  };
}

function resolveColor(value: string, theme: MobileTheme): string {
  if (value === "defaultForeground") return theme.color.text;
  if (value === "defaultBackground") return theme.color.bgTerminal;
  if (value.startsWith("ansi:")) {
    return (theme.mode === "dark" ? ghosttyAnsi : lightAnsi)[Number(value.slice(5))] ?? theme.color.text;
  }
  return value;
}

function faded(value: string): string {
  if (!/^#[\da-f]{6}$/i.test(value)) return value;
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.62)`;
}
