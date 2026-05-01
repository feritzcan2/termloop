import { Platform } from "react-native";

export const colors = {
  bg: "#0b0b0d",
  inputBg: "#15151a",
  border: "#22222a",
  borderStrong: "#2a2a32",
  text: "#e8e8ea",
  label: "#a8a8b0",
  sub: "#8a8a92",
  hint: "#6a6a72",
  placeholder: "#5a5a63",
  primary: "#2b6cff",
  danger: "#d96b6b",
  surfaceBg: "#000",
  bgRaised: "#101015",
} as const;

export const monoFont = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
}) as string;
