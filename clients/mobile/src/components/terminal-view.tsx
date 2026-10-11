import { useTheme, createThemedStyles } from "@/theme/context";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
} from "react-native";

import type { TerminalBuffer, TerminalLine } from "@/presentation/terminal-buffer";
import { terminalLoading } from "@/presentation/terminal-loading";
import {
  overscrollRequest,
  terminalDragScroll,
  type InitialTerminalPosition,
} from "@/presentation/terminal-scroll";
import { sameTerminalRowWindow, terminalRowWindow } from "@/presentation/terminal-window";
import { liveTerminalRowsById, terminalReadingRows } from "@/presentation/terminal-history";
import { DEFAULT_TERMINAL_STYLE, type TerminalScreenLine, type TerminalSpan, type TerminalStyle } from "@/presentation/terminal-screen";
import { terminalStyleColors } from "@/presentation/terminal-colors";
import type { MobileTheme } from "@/theme/tokens";
import { terminalLinkSpans } from "@/presentation/terminal-links";
import { ExternalLink } from "@/components/external-link";
import { space, terminalGeometry } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Two renderers behind one surface, chosen by the stream rather than by a setting.
///
/// When a program has proved it owns a grid — an agent TUI redrawing in place — the
/// projected screen is rendered cell-accurately, with its colour intact. Flattening a
/// Claude frame into plain lines is what made this view unreadable on a phone: the
/// redraws arrive as cursor motion, and stripping that motion leaves duplicated
/// fragments in no particular order.
///
/// Everything else is a plain byte stream, and gets the bounded line list: no grid
/// or cursor.
///
/// Long lines scroll horizontally rather than wrapping, because wrapping a 300-column
/// diff at 39 characters produces a column of fragments nobody can read.
export function TerminalView({ buffer, fontSizeIndex, onScrollBack, onReturnToLive, onCopyLine, programScroll = false }: {
  buffer: TerminalBuffer;
  fontSizeIndex: number;
  capNotice: string | undefined;
  /// Receives the text of a long-pressed row. Rows are not natively selectable: on
  /// iOS every selectable Text is a full text view, and a hundred of them mounting
  /// and unmounting under a scroll was most of what made the transcript stutter.
  onCopyLine?: (text: string) => void;
  /// Asks the running program to scroll its own history. Absent for a stream with no
  /// history of its own to ask about.
  onScrollBack?: (lines: number) => void;
  onReturnToLive?: () => void;
  programScroll?: boolean;
}) {
  const theme = useTheme();
  const { color } = theme;
  const styles = useStyles();
  const scroll = useRef<ScrollView>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [programReading, setProgramReading] = useState(false);
  // Following the live edge is the default and is sticky: only a user gesture ends
  // it. Native momentum and layout callbacks cannot revoke that intent, and neither
  // can a scroll event reporting an offset that a burst of new rows just left behind.
  // Before this was sticky, a tool result that appended forty rows in one batch
  // landed the clamped scroll command forty rows short of the new end, the next
  // scroll event read as "no longer at the bottom", and following quietly stopped.
  const returningToLive = useRef(true);
  const liveFrame = useRef<number | undefined>(undefined);
  const scheduleLiveScroll = useCallback(() => {
    if (liveFrame.current !== undefined) return;
    liveFrame.current = requestAnimationFrame(() => {
      liveFrame.current = undefined;
      if (returningToLive.current) scroll.current?.scrollToEnd({ animated: false });
    });
  }, []);
  const [unread, setUnread] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyLine = useCallback((text: string) => {
    if (onCopyLine === undefined) return;
    onCopyLine(text);
    setCopied(true);
    if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => { copiedTimer.current = undefined; setCopied(false); }, 1500);
  }, [onCopyLine]);
  const [viewport, setViewport] = useState({ offset: 0, height: 600 });
  const [initialPosition, setInitialPosition] = useState<InitialTerminalPosition>("waitingForContent");
  const revealFrame = useRef<number | undefined>(undefined);
  const fontSize = terminalGeometry.fontSizes[fontSizeIndex] ?? terminalGeometry.fontSizes[1];
  const lineHeight = terminalGeometry.lineHeights[fontSizeIndex] ?? terminalGeometry.lineHeights[1];
  const hasContent = buffer.screen !== undefined || buffer.lines.length !== 0 || buffer.pending.length !== 0;
  const loading = terminalLoading(buffer);
  const requested = useRef({ direction: 0, lines: 0 });
  const canScrollBack = onScrollBack !== undefined && buffer.screen !== undefined;
  const outputLines = useMemo(() => buffer.lines.filter((line) => line.kind === "output"), [buffer.lines]);
  const historyLines: readonly HistoryLine[] = buffer.screen ?? outputLines;
  const historyKind: HistoryKind = buffer.screen === undefined ? "stream" : "screen";
  // The rows on display when the reader left the live edge. While set, nothing above
  // the reader moves: evicted rows stay, new rows append, and a row the program is
  // still painting shows its live content in its frozen place.
  const [frozen, setFrozen] = useState<{ rows: readonly HistoryLine[]; kind: HistoryKind } | undefined>(undefined);
  if (frozen !== undefined && frozen.kind !== historyKind) {
    // A replaced renderer numbers its rows from a different space. Start it live.
    setFrozen(undefined);
    returningToLive.current = true;
  }
  const reading = useMemo(() => frozen === undefined || frozen.kind !== historyKind ? undefined
    : terminalReadingRows(frozen.rows, historyLines), [frozen, historyKind, historyLines]);
  const liveById = useMemo(() => reading === undefined ? undefined : liveTerminalRowsById(historyLines), [reading, historyLines]);
  const displayed = reading?.rows ?? historyLines;
  const count = displayed.length;
  const directScroll = canScrollBack && programScroll;
  const rows = terminalRowWindow(count, viewport.offset, viewport.height, lineHeight);
  const lastRevision = useRef(buffer.outputRevision);
  const scrolling = useRef(false);
  const drag = useRef({ y: 0, remainder: 0, active: false });
  const dragViewport = useRef({ offset: 0, maxOffset: 0 });
  dragViewport.current = {
    offset: viewport.offset,
    maxOffset: Math.max(0, count * lineHeight + 2 * terminalGeometry.contentPadding - viewport.height),
  };
  const historyRef = useRef(historyLines);
  historyRef.current = historyLines;
  /// Native scrolling leaves live. The program-scroll path never freezes: there the
  /// program owns the frame and repaints it in place, so the rows must stay live.
  const leaveLive = useCallback(() => {
    returningToLive.current = false;
    setFrozen((current) => current ?? { rows: historyRef.current, kind: historyKind });
  }, [historyKind]);
  const scrollGesture = useMemo(() => {
    const reset = () => { drag.current = { y: 0, remainder: 0, active: false }; };
    const move = (y: number) => {
      if (!directScroll || initialPosition !== "ready") return;
      returningToLive.current = false;
      const frame = dragViewport.current;
      const { offset, lines, remainder } = terminalDragScroll(
        y - drag.current.y, lineHeight, drag.current.remainder, frame.offset, frame.maxOffset,
      );
      drag.current = { y, remainder, active: true };
      if (offset !== frame.offset) {
        frame.offset = offset;
        const bottom = offset >= frame.maxOffset;
        atBottomRef.current = bottom;
        setAtBottom(bottom);
        if (bottom) setUnread(false);
        setViewport((current) => ({ ...current, offset }));
        scroll.current?.scrollTo({ y: offset, animated: false });
      }
      if (lines < 0) setProgramReading(true);
      if (lines !== 0) onScrollBack?.(lines);
    };
    return PanResponder.create({
      // Capture vertical drags before the nested native ScrollViews take them.
      // Horizontal panning, taps, and text selection keep their native handlers.
      onMoveShouldSetPanResponderCapture: (_event, gesture) => directScroll
        && initialPosition === "ready" && gesture.numberActiveTouches === 1
        && Math.abs(gesture.dy) > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.15,
      onPanResponderGrant: () => {
        returningToLive.current = false;
        reset();
        drag.current.active = true;
      },
      onPanResponderMove: (_event, gesture) => { move(gesture.dy); },
      onPanResponderRelease: reset,
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => true,
    });
  }, [directScroll, initialPosition, lineHeight, onScrollBack]);

  useEffect(() => {
    if (lastRevision.current !== buffer.outputRevision && (!atBottomRef.current || programReading)) setUnread(true);
    lastRevision.current = buffer.outputRevision;
  }, [buffer.outputRevision, programReading]);

  useLayoutEffect(() => {
    if (!returningToLive.current) return;
    const offset = Math.max(0, count * lineHeight + 2 * terminalGeometry.contentPadding
      + (buffer.screen === undefined && buffer.pending.length !== 0 ? lineHeight : 0) - viewport.height);
    if (offset !== viewport.offset) setViewport((current) => ({ ...current, offset }));
    // The rows must be committed before native scrolling can target them.
    scroll.current?.scrollToEnd({ animated: false });
    // Fabric may still clamp the first command to its previous layout, even
    // when the content height is unchanged and no size callback will follow.
    scheduleLiveScroll();
  }, [viewport.offset, viewport.height, lineHeight, count, buffer.screen, buffer.pending, scheduleLiveScroll]);

  const jumpToLive = useCallback(() => {
    returningToLive.current = true;
    setProgramReading(false);
    scrolling.current = false;
    requested.current = { direction: 0, lines: 0 };
    setUnread(false);
    setAtBottom(true);
    atBottomRef.current = true;
    setFrozen(undefined);
    onReturnToLive?.();
  }, [onReturnToLive]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (drag.current.active) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (returningToLive.current) {
      const expectedHeight = count * lineHeight + 2 * terminalGeometry.contentPadding
        + (buffer.screen === undefined && buffer.pending.length !== 0 ? lineHeight : 0);
      if (Math.abs(contentSize.height - expectedHeight) > 1
        || Math.abs(contentOffset.y - Math.max(0, expectedHeight - layoutMeasurement.height)) > 1) {
        scheduleLiveScroll();
        return;
      }
    }
    const bottom = contentSize.height - layoutMeasurement.height - contentOffset.y < 24;
    if (bottom && !atBottomRef.current && !programReading) {
      // Scrolling back down to the edge resumes following, as sticky as a Live tap.
      returningToLive.current = true;
      setFrozen(undefined);
    }
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnread(false);
    const offset = Math.max(0, contentOffset.y);
    // Commit the offset only when it moves the mounted window; React only needs to
    // hear about it per block.
    if (layoutMeasurement.height !== viewport.height
      || !sameTerminalRowWindow(rows, terminalRowWindow(count, offset, layoutMeasurement.height, lineHeight))) {
      setViewport({ offset, height: layoutMeasurement.height });
    }
    if (directScroll || !canScrollBack || !scrolling.current) return;
    const total = overscrollRequest(contentOffset.y, contentSize.height, layoutMeasurement.height, lineHeight);
    const direction = Math.sign(total);
    if (direction === 0) { requested.current = { direction: 0, lines: 0 }; return; }
    if (requested.current.direction !== direction) requested.current = { direction, lines: 0 };
    const lines = Math.abs(total) - requested.current.lines;
    if (lines <= 0) return;
    requested.current = { direction, lines: Math.abs(total) };
    onScrollBack?.(direction * lines);
  }, [canScrollBack, directScroll, lineHeight, onScrollBack, programReading, viewport.height, rows, count, buffer.screen, buffer.pending, scheduleLiveScroll]);

  const onContentChange = useCallback(() => {
    if (initialPosition !== "ready") {
      if (!hasContent && loading) return;
      scroll.current?.scrollToEnd({ animated: false });
      if (revealFrame.current !== undefined) return;
      revealFrame.current = requestAnimationFrame(() => {
        scroll.current?.scrollToEnd({ animated: false });
        revealFrame.current = requestAnimationFrame(() => {
          revealFrame.current = undefined;
          setInitialPosition("ready");
        });
      });
      return;
    }
    if (atBottomRef.current && !programReading) {
      scroll.current?.scrollToEnd({ animated: false });
      // The first command can land on the previous layout; repeat once it settles.
      scheduleLiveScroll();
    }
  }, [hasContent, initialPosition, loading?.label, programReading, scheduleLiveScroll]);

  useEffect(() => {
    if (!hasContent && !loading) setInitialPosition("ready");
  }, [hasContent, loading?.label]);
  useEffect(() => () => {
    if (revealFrame.current !== undefined) cancelAnimationFrame(revealFrame.current);
    if (liveFrame.current !== undefined) cancelAnimationFrame(liveFrame.current);
    if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
  }, []);

  return (
    <View style={styles.surface} {...scrollGesture.panHandlers}>
      <ScrollView ref={scroll} style={styles.scroll}
        scrollEnabled={!directScroll}
        contentContainerStyle={[styles.content, initialPosition === "ready" ? null : styles.initiallyHidden]}
        onLayout={(event) => {
          // Fabric releases this pooled event before a queued updater may run.
          const height = event.nativeEvent.layout.height;
          setViewport((current) => current.height === height ? current : { ...current, height });
        }}
        onScroll={onScroll} scrollEventThrottle={16}
        onScrollBeginDrag={() => {
          leaveLive();
          scrolling.current = true;
        }}
        onScrollEndDrag={() => { scrolling.current = false; requested.current = { direction: 0, lines: 0 }; }}
        onMomentumScrollBegin={() => { scrolling.current = true; }}
        onMomentumScrollEnd={() => { scrolling.current = false; requested.current = { direction: 0, lines: 0 }; }}
        alwaysBounceVertical={canScrollBack} onContentSizeChange={onContentChange}>
        <ScrollView horizontal contentContainerStyle={styles.horizontal} showsHorizontalScrollIndicator={false}>
          <View>
            <View style={{ height: rows.before }} />
            {displayed.slice(rows.start, rows.end).map((row) => {
              const line = liveById?.get(row.id) ?? row;
              return "spans" in line
                ? <TerminalScreenRow key={line.id} spans={line.spans} fontSize={fontSize} lineHeight={lineHeight} onCopyLine={copyLine} />
                : <TerminalLineText key={line.id} line={line} fontSize={fontSize} lineHeight={lineHeight} onCopyLine={copyLine} />;
            })}
            <View style={{ height: rows.after }} />
            {buffer.screen === undefined && buffer.pending.length !== 0 ? <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1}>{renderSpans([{ text: buffer.pending, style: DEFAULT_TERMINAL_STYLE }], theme)}</Text> : null}
          </View>
        </ScrollView>
      </ScrollView>
      {initialPosition !== "ready" && loading ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.loading]}
        accessibilityRole="progressbar" accessibilityLabel={loading.label}
        {...(loading.percent === undefined ? {} : { accessibilityValue: { min: 0, max: 100, now: loading.percent } })}>
        <ActivityIndicator color={color.accentStrong} />
        <Text style={styles.loadingLabel}>{loading.label}</Text>
        {loading.percent === undefined ? null : <Text style={styles.loadingProgress}>{loading.percent}%</Text>}
      </View> : null}
      {copied ? <View pointerEvents="none" style={[styles.pill, styles.copied]}><Text style={styles.jumpGlyph}>Line copied</Text></View> : null}
      {atBottom && !programReading ? null : <Pressable onPress={jumpToLive} accessibilityRole="button" accessibilityLabel="Return to live output" style={[styles.pill, styles.jump]}>
        <Text style={styles.jumpGlyph}>{unread ? "New output · " : ""}↓ Live</Text>
      </Pressable>}
    </View>
  );
}

type HistoryLine = TerminalScreenLine | TerminalLine;
type HistoryKind = "stream" | "screen";

/// Resolved styles are cached against the interned cell style they came from, so a
/// frame that reuses a dozen colours allocates a dozen style objects rather than one
/// per span per redraw.
const spanStyles = new WeakMap<MobileTheme, WeakMap<TerminalStyle, TextStyle>>();

function spanStyle(style: TerminalStyle, theme: MobileTheme): TextStyle {
  let cache = spanStyles.get(theme);
  if (cache === undefined) {
    cache = new WeakMap();
    spanStyles.set(theme, cache);
  }
  const existing = cache.get(style);
  if (existing !== undefined) return existing;
  const created: TextStyle = {
    ...terminalStyleColors(style, theme),
    ...(style.bold ? { fontWeight: "700" as const } : null),
    ...(style.italic ? { fontStyle: "italic" as const } : null),
    ...(style.underline ? { textDecorationLine: "underline" as const } : null),
  };
  cache.set(style, created);
  return created;
}

/// One projected screen row.
///
/// Memoised on the span array, which the projector keeps referentially stable for any
/// row a redraw left unchanged. Without that, every frame of a full-screen redraw would
/// reconcile every row on the screen.
const TerminalScreenRow = memo(function TerminalScreenRow({ spans, fontSize, lineHeight, onCopyLine }: {
  spans: readonly TerminalSpan[];
  fontSize: number;
  lineHeight: number;
  onCopyLine: (text: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const copy = useCallback(() => { onCopyLine(spans.map((span) => span.text).join("").trimEnd()); }, [onCopyLine, spans]);
  return (
    <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1} onLongPress={copy}>
      {spans.length === 0
        ? " "
        : renderSpans(spans, theme)}
    </Text>
  );
});

function TerminalLineText({ line, fontSize, lineHeight, onCopyLine }: {
  line: TerminalLine;
  fontSize: number;
  lineHeight: number;
  onCopyLine: (text: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  /// A long-press hands the line to the owner, which holds the clipboard; the view
  /// itself owns no clipboard dependency.
  return (
    <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1} onLongPress={() => onCopyLine(line.text)}>
      {line.text.length === 0 ? " " : renderSpans([{ text: line.text, style: DEFAULT_TERMINAL_STYLE }], theme)}
    </Text>
  );
}

function renderSpans(spans: readonly TerminalSpan[], theme: MobileTheme) {
  return terminalLinkSpans(spans).map((span, index) => span.url
    ? <ExternalLink key={index} url={span.url} style={spanStyle(span.style, theme)}>{span.text}</ExternalLink>
    : <Text key={index} style={spanStyle(span.style, theme)}>{span.text}</Text>);
}

const useStyles = createThemedStyles(({ color }) => ({
  surface: { flex: 1, backgroundColor: color.bgTerminal },
  scroll: { flex: 1 },
  /// No `gap` here. A gap between the notice and the output block is fine, but the block
  /// itself is a grid of lines whose spacing is the line height — inserting flex gaps
  /// into it would open stripes through a TUI frame.
  content: { padding: terminalGeometry.contentPadding },
  initiallyHidden: { opacity: 0 },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    backgroundColor: color.bgTerminal,
  },
  loadingLabel: { color: color.textSecondary, fontSize: 13 },
  loadingProgress: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12 },
  /// `minWidth` rather than `width`, so short output still fills the surface while a wide
  /// line is free to push the content box past the screen and become scrollable.
  horizontal: { minWidth: "100%" },
  output: { color: color.text, fontFamily: fontFamily.mono },
  pill: {
    position: "absolute",
    bottom: space.md,
    paddingHorizontal: space.md,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
  },
  jump: { right: space.md },
  jumpGlyph: { color: color.text, fontSize: 12, lineHeight: 20 },
  copied: { left: space.md },
}));
