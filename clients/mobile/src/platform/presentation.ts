import { Platform, type KeyboardAvoidingViewProps } from "react-native";

export const monoFontFamily = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

export const keyboardAvoidingBehavior: KeyboardAvoidingViewProps["behavior"] =
  Platform.OS === "ios" ? "padding" : undefined;
