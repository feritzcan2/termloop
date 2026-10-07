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
import { terminalRowWindow } from "@/presentation/terminal-window";
import {
  earlierTerminalHistory, recentTerminalHistory, reconcileTerminalHistory,
  terminalReadingAnchor, terminalReadingOffset, type TerminalHistoryPage,
} from "@/presentation/terminal-history";
import { DEFAULT_TERMINAL_STYLE, type TerminalSpan, type TerminalStyle } from "@/presentation/terminal-screen";
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
export function TerminalView({ buffer, fontSizeIndex, onScrollBack, onReturnToLive, programScroll = false }: {
  buffer: TerminalBuffer;
  fontSizeIndex: number;
  capNotice: string | undefined;
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
  const returningToLive = useRef(false);
  const [unread, setUnread] = useState(false);
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
  const historyLines = buffer.screen ?? outputLines;
  const historyKind = buffer.screen === undefined ? "stream" : "screen";
  const [history, setHistory] = useState(() => recentTerminalHistory(historyLines, historyKind));
  const page = reconcileTerminalHistory(history, historyLines, historyKind, atBottom, programReading);
  if (page !== history) setHistory(page);
  const count = page.rows.length - page.start;
  const directScroll = canScrollBack && programScroll && page.start === 0;
  const rows = terminalRowWindow(count, viewport.offset, viewport.height, lineHeight);
  const lastRevision = useRef(buffer.outputRevision);
  const reading = useRef<{ page: TerminalHistoryPage; offset: number; lineHeight: number } | undefined>(undefined);
  const pendingPosition = useRef<number | undefined>(undefined);
  const loadingPage = useRef(false);
  const scrolling = useRef(false);
  const pagedDuringGesture = useRef(false);
  const drag = useRef({ y: 0, remainder: 0, active: false });
  const dragViewport = useRef({ offset: 0, maxOffset: 0 });
  dragViewport.current = {
    offset: viewport.offset,
    maxOffset: Math.max(0, count * lineHeight + 2 * terminalGeometry.contentPadding - viewport.height),
  };
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
      onPanResponderGrant: () => { reset(); drag.current.active = true; },
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
    if (returningToLive.current) {
      const offset = Math.max(0, count * lineHeight + 2 * terminalGeometry.contentPadding
        + (buffer.screen === undefined && buffer.pending.length !== 0 ? lineHeight : 0) - viewport.height);
      if (offset !== viewport.offset) setViewport((current) => ({ ...current, offset }));
      reading.current = { page, offset, lineHeight };
      // The recent page must be committed before native scrolling can target it.
      scroll.current?.scrollToEnd({ animated: false });
      return;
    }
    const previous = reading.current;
    let offset = viewport.offset;
    if (previous && previous.page.kind === page.kind && !atBottomRef.current && !programReading
      && (previous.page !== page || previous.lineHeight !== lineHeight)) {
      const anchor = terminalReadingAnchor(previous.page, previous.offset, previous.lineHeight);
      if (anchor !== undefined) offset = terminalReadingOffset(page, anchor, lineHeight);
      if (offset !== viewport.offset) {
        pendingPosition.current = offset;
        setViewport((current) => ({ ...current, offset }));
        // Repeat after native content measurement: the old content height can
        // clamp a scroll command issued in the same commit as a prepend.
        scroll.current?.scrollTo({ y: offset, animated: false });
      }
    }
    reading.current = { page, offset, lineHeight };
  }, [page, viewport.offset, viewport.height, lineHeight, count, buffer.screen, buffer.pending, programReading]);

  const loadEarlier = useCallback(() => {
    if (initialPosition !== "ready" || loadingPage.current || page.start === 0) return;
    loadingPage.current = true;
    pagedDuringGesture.current = true;
    atBottomRef.current = false;
    setAtBottom(false);
    setHistory(earlierTerminalHistory(page));
  }, [initialPosition, page]);

  const jumpToLive = useCallback(() => {
    returningToLive.current = true;
    setProgramReading(false);
    scrolling.current = false;
    requested.current = { direction: 0, lines: 0 };
    setUnread(false);
    setAtBottom(true);
    atBottomRef.current = true;
    loadingPage.current = false;
    pendingPosition.current = undefined;
    setHistory(recentTerminalHistory(historyLines, historyKind));
    onReturnToLive?.();
  }, [historyLines, historyKind, onReturnToLive]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (loadingPage.current || drag.current.active) return;
    pendingPosition.current = undefined;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (returningToLive.current) {
      const expectedHeight = count * lineHeight + 2 * terminalGeometry.contentPadding
        + (buffer.screen === undefined && buffer.pending.length !== 0 ? lineHeight : 0);
      if (Math.abs(contentSize.height - expectedHeight) > 1
        || Math.abs(contentOffset.y - Math.max(0, expectedHeight - layoutMeasurement.height)) > 1) return;
      returningToLive.current = false;
    }
    const movingUp = contentOffset.y < viewport.offset;
    reading.current = { page, offset: Math.max(0, contentOffset.y), lineHeight };
    const bottom = contentSize.height - layoutMeasurement.height - contentOffset.y < 24;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnread(false);
    setViewport({ offset: Math.max(0, contentOffset.y), height: layoutMeasurement.height });
    if (initialPosition === "ready" && scrolling.current && movingUp
      && contentOffset.y <= lineHeight * 4 && page.start > 0) {
      loadEarlier();
      return;
    }
    // Native bounce events from revealing cached rows must never become input
    // to the program, including the gesture that revealed the final page.
    if (pagedDuringGesture.current) return;
    if (directScroll || !canScrollBack || !scrolling.current) return;
    if (contentOffset.y < 0 && page.start > 0) return;
    const total = overscrollRequest(contentOffset.y, contentSize.height, layoutMeasurement.height, lineHeight);
    const direction = Math.sign(total);
    if (direction === 0) { requested.current = { direction: 0, lines: 0 }; return; }
    if (requested.current.direction !== direction) requested.current = { direction, lines: 0 };
    const lines = Math.abs(total) - requested.current.lines;
    if (lines <= 0) return;
    requested.current = { direction, lines: Math.abs(total) };
    onScrollBack?.(direction * lines);
  }, [canScrollBack, directScroll, initialPosition, lineHeight, loadEarlier, onScrollBack, page, viewport.offset, count, buffer.screen, buffer.pending]);

  const onContentChange = useCallback(() => {
    if (pendingPosition.current !== undefined) {
      scroll.current?.scrollTo({ y: pendingPosition.current, animated: false });
      pendingPosition.current = undefined;
    }
    loadingPage.current = false;
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
    if (atBottomRef.current && !programReading) scroll.current?.scrollToEnd({ animated: false });
  }, [hasContent, initialPosition, loading?.label, programReading]);

  useEffect(() => {
    if (!hasContent && !loading) setInitialPosition("ready");
  }, [hasContent, loading?.label]);
  useEffect(() => () => {
    if (revealFrame.current !== undefined) cancelAnimationFrame(revealFrame.current);
  }, []);

  return (
    <View style={styles.surface} {...scrollGesture.panHandlers}>
      {page.start > 0 ? <View style={styles.historyBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Load earlier output" onPress={loadEarlier}>
          <Text style={styles.notice}>↑ Scroll up for earlier output</Text>
        </Pressable>
      </View> : null}
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
          returningToLive.current = false;
          scrolling.current = true;
          pagedDuringGesture.current = false;
          pendingPosition.current = undefined;
        }}
        onScrollEndDrag={() => { scrolling.current = false; requested.current = { direction: 0, lines: 0 }; }}
        onMomentumScrollBegin={() => { scrolling.current = true; }}
        onMomentumScrollEnd={() => { scrolling.current = false; requested.current = { direction: 0, lines: 0 }; }}
        alwaysBounceVertical={canScrollBack} onContentSizeChange={onContentChange}>
        <ScrollView horizontal contentContainerStyle={styles.horizontal} showsHorizontalScrollIndicator={false}>
          <View>
            <View style={{ height: rows.before }} />
            {buffer.screen === undefined
              ? outputLines.slice(page.start + rows.start, page.start + rows.end).map((line) => <TerminalLineText key={line.id} line={line} fontSize={fontSize} lineHeight={lineHeight} />)
              : buffer.screen.slice(page.start + rows.start, page.start + rows.end).map((line) => <TerminalScreenRow key={line.id} spans={line.spans} fontSize={fontSize} lineHeight={lineHeight} />)}
            <View style={{ height: rows.after }} />
            {buffer.screen === undefined && buffer.pending.length !== 0 ? <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1} selectable>{renderSpans([{ text: buffer.pending, style: DEFAULT_TERMINAL_STYLE }], theme)}</Text> : null}
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
      {atBottom && !programReading ? null : <Pressable onPress={jumpToLive} accessibilityRole="button" accessibilityLabel="Return to live output" style={styles.jump}>
        <Text style={styles.jumpGlyph}>{unread ? "New output · " : ""}↓ Live</Text>
      </Pressable>}
    </View>
  );
}

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
const TerminalScreenRow = memo(function TerminalScreenRow({ spans, fontSize, lineHeight }: {
  spans: readonly TerminalSpan[];
  fontSize: number;
  lineHeight: number;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1} selectable>
      {spans.length === 0
        ? " "
        : renderSpans(spans, theme)}
    </Text>
  );
});

function TerminalLineText({ line, fontSize, lineHeight }: {
  line: TerminalLine;
  fontSize: number;
  lineHeight: number;
}) {
  const styles = useStyles();
  const theme = useTheme();
  /// Selectable so a long-press can copy a line without the view owning a clipboard
  /// dependency of its own.
  return (
    <Text style={[styles.output, { fontSize, lineHeight, height: lineHeight }]} numberOfLines={1} selectable>
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
  historyBar: { paddingHorizontal: space.sm, paddingVertical: space.xs, alignItems: "center" },
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
  notice: { color: color.textMuted, fontFamily: fontFamily.mono },
  jump: {
    position: "absolute",
    right: space.md,
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
  jumpGlyph: { color: color.text, fontSize: 12, lineHeight: 20 },
}));
