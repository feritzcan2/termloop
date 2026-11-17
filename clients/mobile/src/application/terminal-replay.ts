const MIN_PARTIAL_OVERLAP_BYTES = 64;

export interface ReplayContinuation {
  readonly continuous: boolean;
  readonly bytes: Uint8Array;
}


/// Finds the longest prefix of `replay` that is also a suffix of `previous` in
/// linear time. This is the exact relationship between two snapshots of the same
/// rolling daemon ring when bytes were appended and, optionally, evicted.
function replayOverlap(previous: Uint8Array, replay: Uint8Array): number {
  if (previous.byteLength === 0 || replay.byteLength === 0) return 0;
  const prefix = new Uint32Array(replay.byteLength);
  for (let index = 1, matched = 0; index < replay.byteLength; index += 1) {
    while (matched > 0 && replay[index] !== replay[matched]) matched = prefix[matched - 1] ?? 0;
    if (replay[index] === replay[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  for (const byte of previous.subarray(Math.max(0, previous.byteLength - replay.byteLength))) {
    while (matched > 0 && byte !== replay[matched]) matched = prefix[matched - 1] ?? 0;
    if (byte === replay[matched]) matched += 1;
    if (matched === replay.byteLength) {
      /// Keep a complete match only when it ends at the previous tail. Otherwise the
      /// next byte must continue from the pattern's longest proper prefix.
      matched = prefix[matched - 1] ?? 0;
    }
  }
  /// A replay identical to the previous tail is the common reconnect case. The loop
  /// above falls back after a complete match, so recover that exact boundary here.
  if (previous.byteLength >= replay.byteLength) {
    const start = previous.byteLength - replay.byteLength;
    let identicalSuffix = true;
    for (let index = 0; index < replay.byteLength; index += 1) {
      if (previous[start + index] !== replay[index]) {
        identicalSuffix = false;
        break;
      }
    }
    if (identicalSuffix) return replay.byteLength;
  }
  return matched;
}

/// Returns only bytes not already represented by the retained projection. A tiny
/// accidental suffix/prefix match is not enough evidence: in that case the caller
/// rebuilds from the complete replay rather than risking a stale screen.
export function continueTerminalReplay(
  previous: Uint8Array,
  replay: Uint8Array,
): ReplayContinuation {
  const opening = openingGridLength(replay);
  if (opening === 0) return continueOutput(previous, replay);
  /// A daemon that reports geometry opens every replay with the grid its first byte
  /// was laid out for. That marker sits at the window start, not where the previous
  /// tail saw it, so overlap is measured on the output after it.
  const output = replay.subarray(opening);
  if (output.byteLength === 0) return { continuous: true, bytes: replay.slice() };
  const continuation = continueOutput(previous, output);
  if (!continuation.continuous) return { continuous: false, bytes: replay };
  /// A continued projection already holds the grid at the overlap point; replaying the
  /// window's older opening grid there would undo a later change. Only a projection
  /// that has never been told a grid takes it.
  if (containsGridSequence(previous)) return continuation;
  const bytes = new Uint8Array(opening + continuation.bytes.byteLength);
  bytes.set(replay.subarray(0, opening), 0);
  bytes.set(continuation.bytes, opening);
  return { continuous: true, bytes };
}

const GRID_PREFIX = [0x1b, 0x5b, 0x38, 0x3b] as const; // ESC [ 8 ;

/// Length of a leading `ESC [ 8 ; rows ; cols t`, or 0.
function openingGridLength(bytes: Uint8Array): number {
  if (!GRID_PREFIX.every((byte, index) => bytes[index] === byte)) return 0;
  let separators = 0;
  for (let index = GRID_PREFIX.length; index < Math.min(bytes.byteLength, 24); index += 1) {
    const byte = bytes[index];
    if (byte === 0x74) return separators === 1 ? index + 1 : 0; // t
    if (byte === 0x3b) separators += 1; // ;
    else if (byte === undefined || byte < 0x30 || byte > 0x39) return 0;
  }
  return 0;
}

function containsGridSequence(bytes: Uint8Array): boolean {
  for (let index = bytes.indexOf(0x1b); index >= 0; index = bytes.indexOf(0x1b, index + 1)) {
    if (openingGridLength(bytes.subarray(index)) > 0) return true;
  }
  return false;
}

function continueOutput(
  previous: Uint8Array,
  replay: Uint8Array,
): ReplayContinuation {
  const overlap = replayOverlap(previous, replay);
  const completeBoundary = overlap === previous.byteLength || overlap === replay.byteLength;
  const continuous = overlap > 0
    && (completeBoundary || overlap >= MIN_PARTIAL_OVERLAP_BYTES);
  return continuous
    ? { continuous: true, bytes: replay.slice(overlap) }
    : { continuous: false, bytes: replay };
}
