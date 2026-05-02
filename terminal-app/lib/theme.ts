import { Platform } from "react-native";

export const colors = {
  // Backgrounds — cool dark with clear layer separation. Not pure black so
  // borders, shadows and pressed states are actually visible on OLED.
  bg: "#11131c",
  bgElevated: "#1c1f2c",
  bgRaised: "#262a3a",
  inputBg: "#1f2330",
  surfaceBg: "#0f111b",

  // Borders
  border: "#2c3044",
  borderStrong: "#383d54",
  borderAccent: "#3b6dff44",

  // Text
  text: "#eef0f4",
  terminalText: "#e0e3ee",
  onPrimary: "#ffffff",
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
