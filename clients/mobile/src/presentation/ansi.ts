/// Reduces terminal bytes to readable plain text for the bounded placeholder view.
///
/// This is not a terminal emulator and does not pretend to be one. There is no
/// grid, no cursor addressing, and no scroll region: a real renderer is a later F6
/// packet, and approximating one here would produce a view that looks authoritative
/// while quietly disagreeing with the Mac. What this module does is remove the
/// escape machinery so a redraw-heavy TUI degrades into legible lines instead of
/// visible garbage.
///
/// Every pattern is assembled from character codes rather than typed as a literal,
/// so no raw control byte enters this source file. A regex holding an invisible
/// escape character is unreviewable in a diff and one careless copy-paste silently
/// changes what it matches.

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function range(from: number, to: number): string {
  return `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
}

/// OSC (`ESC ] … BEL` or `ESC ] … ESC \`) is stripped before CSI, because its
/// payload can contain bytes that would otherwise be read as a shorter escape.
const oscSequence = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
/// CSI: `ESC [`, parameter bytes, intermediate bytes, one final byte. This is what
/// carries colour, cursor movement, and the erase commands a TUI redraws with.
const csiSequence = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/// Charset selection and the other two-byte escapes.
const twoByteEscape = new RegExp(`${ESC}[ -/][@-~]`, "g");
/// Single-character escapes (`ESC M`, `ESC 7`, `ESC =`). `[` and `]` are already
/// consumed above.
const shortEscape = new RegExp(`${ESC}[@-Z0-9=><]`, "g");
/// A lone `ESC` with nothing decodable after it, so a chunk boundary cannot leave
/// an escape byte visible in the output.
const strayEscape = new RegExp(ESC, "g");
/// C0 and DEL controls that survive stripping have no plain-text meaning. Tab,
/// newline, and carriage return are excluded here and handled by the line splitter.
const otherControls = new RegExp(
  `[${range(0x00, 0x08)}${range(0x0b, 0x0c)}${range(0x0e, 0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

export function stripControlSequences(value: string): string {
  return value
    .replace(oscSequence, "")
    .replace(csiSequence, "")
    .replace(twoByteEscape, "")
    .replace(shortEscape, "")
    .replace(strayEscape, "")
    .replace(otherControls, "");
}

/// Applies the one cursor movement a line-oriented view can honour truthfully: a
/// bare carriage return means the emitter is rewriting the line it just wrote, so
/// only the final revision survives. Progress bars and spinners collapse to their
/// last frame, which is what a reader wants from a log they arrived at late.
export function applyCarriageReturns(line: string): string {
  const index = line.lastIndexOf("\r");
  return index < 0 ? line : line.slice(index + 1);
}
