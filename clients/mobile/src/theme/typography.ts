import { StyleSheet } from "react-native";

import { monoFontFamily } from "@/platform/presentation";
import { color } from "./tokens";

/// Mono is this client's display voice, not just its data voice. Titles, section
/// prompts, state words, and the wordmark render in the terminal's own face, so
/// the chrome speaks the same language as the screens it pages for. Human prose —
/// row titles, briefs, body copy — stays sans, because a Task title is not
/// machine output and should not pretend to be.
export const fontFamily = {
  mono: monoFontFamily,
} as const;

export const text = StyleSheet.create({
  /// Section prompts. Lowercase mono at 12, so a section reads as a console
  /// listing header and can be skipped by shape.
  eyebrow: {
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "lowercase",
  },
  screenTitle: {
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 21,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  headerTitle: {
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 14.5,
    fontWeight: "600",
  },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: "600" },
  body: { color: color.text, fontSize: 13 },
  secondary: { color: color.textSecondary, fontSize: 12 },
  muted: { color: color.textMuted, fontSize: 12 },
  pill: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  /// The one state word a row prints, in the status-line register: mono caps.
  stateWord: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  mono: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12 },
  monoStrong: { color: color.text, fontFamily: fontFamily.mono, fontSize: 13 },
});
