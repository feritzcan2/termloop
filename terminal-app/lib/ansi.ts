/**
 * Minimal ANSI/VT parser for terminal-surface text.
 *
 * Handles SGR (Select Graphic Rendition: colors, bold, italic, underline)
 * inside CSI escapes (`\x1b[...m`). All other CSI sequences (cursor moves,
 * screen clears) are stripped — the mobile terminal is a scrollback view,
 * not a real VT, so applying them would corrupt the buffer. Non-CSI
 * escapes and BEL/NUL bytes are dropped.
 *
 * `parseAnsi` carries SGR state across runs of plain text and emits
 * `AnsiSegment[]` for direct rendering as nested <Text> nodes. Throws on
 * pathological input — callers should fall back to `stripAnsi` + plain
 * rendering.
 */

import type { TextStyle } from "react-native";

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: TextStyle["fontWeight"];
  fontStyle?: TextStyle["fontStyle"];
  textDecorationLine?: TextStyle["textDecorationLine"];
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const FG_BASIC: Record<number, string> = {
  30: "#3b3f4c",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#dcdfe4",
  90: "#5c6370",
  91: "#ff7b86",
  92: "#a6e088",
  93: "#fbd58a",
  94: "#7cc0ff",
  95: "#dd8cf0",
  96: "#6cd0dc",
  97: "#ffffff",
};

const XTERM_RAMP = [0, 95, 135, 175, 215, 255];
const XTERM_BASIC_16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function rgbHex(r: number, g: number, b: number): string {
  const clamp = (n: number) =>
    Math.max(0, Math.min(255, Math.floor(n))).toString(16).padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

function xterm256(n: number): string {
  if (n < 0 || n > 255) return "#ffffff";
  if (n < 16) return XTERM_BASIC_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgbHex(v, v, v);
  }
  const i = n - 16;
  const r = XTERM_RAMP[Math.floor(i / 36)];
  const g = XTERM_RAMP[Math.floor((i % 36) / 6)];
  const b = XTERM_RAMP[i % 6];
  return rgbHex(r, g, b);
}

function applySgr(prev: AnsiStyle, params: number[]): AnsiStyle {
  let s: AnsiStyle = { ...prev };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!Number.isFinite(p) || p === 0) {
      s = {};
    } else if (p === 1) s.fontWeight = "bold";
    else if (p === 22) s.fontWeight = "normal";
    else if (p === 3) s.fontStyle = "italic";
    else if (p === 23) s.fontStyle = "normal";
    else if (p === 4) s.textDecorationLine = "underline";
    else if (p === 24) s.textDecorationLine = "none";
    else if (p >= 30 && p <= 37) s.color = FG_BASIC[p];
    else if (p === 38) {
      const mode = params[i + 1];
      if (mode === 5 && params[i + 2] != null) {
        s.color = xterm256(params[i + 2]);
        i += 2;
      } else if (mode === 2 && params[i + 4] != null) {
        s.color = rgbHex(params[i + 2], params[i + 3], params[i + 4]);
        i += 4;
      }
    } else if (p === 39) s.color = undefined;
    else if (p >= 40 && p <= 47) s.backgroundColor = FG_BASIC[p - 10];
    else if (p === 48) {
      const mode = params[i + 1];
      if (mode === 5 && params[i + 2] != null) {
        s.backgroundColor = xterm256(params[i + 2]);
        i += 2;
      } else if (mode === 2 && params[i + 4] != null) {
        s.backgroundColor = rgbHex(params[i + 2], params[i + 3], params[i + 4]);
        i += 4;
      }
    } else if (p === 49) s.backgroundColor = undefined;
    else if (p >= 90 && p <= 97) s.color = FG_BASIC[p];
    else if (p >= 100 && p <= 107) s.backgroundColor = FG_BASIC[p - 10];
  }
  return s;
}

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let plain = "";
  const flush = () => {
    if (plain.length > 0) {
      segments.push({ text: plain, style });
      plain = "";
    }
  };

  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b) {
      flush();
      const next = text[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < len) {
          const c = text.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          j++;
        }
        if (j >= len) {
          // Incomplete CSI at end-of-buffer — drop and stop.
          i = len;
          break;
        }
        if (text[j] === "m") {
          const inner = text.slice(i + 2, j);
          const params = inner === ""
            ? [0]
            : inner.split(";").map((s) => (s === "" ? 0 : Number.parseInt(s, 10)));
          style = applySgr(style, params);
        }
        i = j + 1;
      } else if (next === "]") {
        // OSC — terminated by BEL or ST (ESC \). Strip.
        let j = i + 2;
        while (j < len) {
          const c = text.charCodeAt(j);
          if (c === 0x07) { j++; break; }
          if (c === 0x1b && text[j + 1] === "\\") { j += 2; break; }
          j++;
        }
        i = j;
      } else {
        // Two-byte ESC seq — drop both.
        i += 2;
      }
    } else if (ch === 0x07 || ch === 0x00) {
      i++;
    } else {
      plain += text[i];
      i++;
    }
  }
  flush();
  return segments;
}

export function stripAnsi(text: string): string {
  return text
    // CSI: ESC [ params final
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    // OSC: ESC ] ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other two-byte ESC seqs
    .replace(/\x1b./g, "")
    // Stray BEL / NUL
    .replace(/[\x00\x07]/g, "");
}
