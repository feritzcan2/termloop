import { Platform } from "react-native";

export const colors = {
  // Backgrounds — slightly warm dark grays, not pure black
  bg: "#0e0f13",
  bgElevated: "#16181f",
  bgRaised: "#1a1d26",
  inputBg: "#1c1f29",
  surfaceBg: "#08090c",

  // Borders
  border: "#252835",
  borderStrong: "#2f3340",
  borderAccent: "#3b6dff44",

  // Text
  text: "#eef0f4",
  label: "#9aa0ad",
  sub: "#7d8492",
  hint: "#5e6573",
  placeholder: "#525866",

  // Accent / status
  primary: "#5b8dff",
  primaryDim: "#5b8dff22",
  success: "#5acf8a",
  successDim: "#5acf8a1f",
  successBorder: "#5acf8a55",
  danger: "#e57373",
  dangerDim: "#e573731f",
  dangerBorder: "#e5737355",
  warn: "#e6b347",

  // Overlays
  overlay: "rgba(0,0,0,0.55)",
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
} as const;

export const monoFont = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
}) as string;
