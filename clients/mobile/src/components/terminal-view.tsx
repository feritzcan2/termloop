import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { nextTerminalLoadingProgress } from "@/presentation/terminal-loading";
import {
  overscrollRequest,
  reduceInitialTerminalPosition,
  type InitialTerminalPosition,
} from "@/presentation/terminal-scroll";
import type { TerminalSpan, TerminalStyle } from "@/presentation/terminal-screen";
import { color, space, terminalGeometry } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Two renderers behind one surface, chosen by the stream rather than by a setting.
///
/// When a program has proved it owns a grid — an agent TUI redrawing in place — the
/// projected screen is rendered cell-accurately, with its colour intact. Flattening a
/// Claude frame into plain lines is what made this view unreadable on a phone: the
/// redraws arrive as cursor motion, and stripping that motion leaves duplicated
/// fragments in no particular order.
///
/// Everything else is a plain byte stream, and gets the bounded line list: no grid, no
/// cursor, and two places where it says out loud that it is not telling the whole
/// story — a dropped-frame gap, and its own buffer cap.
///
/// Long lines scroll horizontally rather than wrapping, because wrapping a 300-column
/// diff at 39 characters produces a column of fragments nobody can read.
export function TerminalView({ buffer, fontSizeIndex, capNotice, onScrollBack }: {
  buffer: TerminalBuffer;
  fontSizeIndex: number;
  capNotice: string | undefined;
  /// Asks the running program to scroll its own history. Absent for a stream with no
  /// history of its own to ask about.
  onScrollBack?: (lines: number) => void;
}) {
  const scroll = useRef<ScrollView>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [initialPosition, setInitialPosition] = useState<InitialTerminalPosition>("waitingForContent");
  const revealFrame = useRef<number | undefined>(undefined);
  const fontSize = terminalGeometry.fontSizes[fontSizeIndex] ?? terminalGeometry.fontSizes[1];
  const lineHeight = terminalGeometry.lineHeights[fontSizeIndex] ?? terminalGeometry.lineHeights[1];
  const hasContent = capNotice !== undefined
    || buffer.screen !== undefined
    || buffer.lines.length !== 0
    || buffer.pending.length !== 0;
  const waitingForContent = !hasContent && (
    buffer.stream === "attaching"
    || buffer.stream === "reconnecting"
    || buffer.stream === "live"
  );
  const [loadingProgress, setLoadingProgress] = useState(hasContent ? 100 : 0);
  const showInitialLoading = initialPosition !== "ready" && (hasContent || waitingForContent);

  /// How far the current drag has already been converted into scroll requests. The
  /// bounce animates back through the same offsets it came in on, so without a
  /// high-water mark the release would replay the whole gesture a second time.
  const requested = useRef({ direction: 0, lines: 0 });
  /// Only a projected screen has history behind it worth asking for. The line buffer
  /// holds its own window and scrolls locally.
  const canScrollBack = onScrollBack !== undefined && buffer.screen !== undefined;

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setAtBottom(distance < 24);

    if (!canScrollBack) return;
    const total = overscrollRequest(
      contentOffset.y,
      contentSize.height,
      layoutMeasurement.height,
      lineHeight,
    );
    const direction = Math.sign(total);
    if (direction === 0) {
      requested.current = { direction: 0, lines: 0 };
      return;
    }
    if (requested.current.direction !== direction) {
      requested.current = { direction, lines: 0 };
    }
    const lines = Math.abs(total) - requested.current.lines;
    if (lines <= 0) return;
    requested.current = { direction, lines: Math.abs(total) };
    onScrollBack(direction * lines);
  }, [canScrollBack, lineHeight, onScrollBack]);

  /// Released fingers end the gesture. The next drag starts its own high-water mark.
  const onScrollEnd = useCallback(() => {
    requested.current = { direction: 0, lines: 0 };
  }, []);

  /// Let the first `scrollToEnd` reach native layout, repeat it against the settled
  /// content height, and reveal only on the following frame. Keeping this local to the
  /// initial snapshot avoids delaying ordinary live output after startup.
  const finishInitialPosition = useCallback(() => {
    if (revealFrame.current !== undefined) return;
    revealFrame.current = requestAnimationFrame(() => {
      scroll.current?.scrollToEnd({ animated: false });
      revealFrame.current = requestAnimationFrame(() => {
        revealFrame.current = undefined;
        setInitialPosition((current) => reduceInitialTerminalPosition(current, { type: "positioned" }));
      });
    });
  }, []);

  useEffect(() => () => {
    if (revealFrame.current !== undefined) cancelAnimationFrame(revealFrame.current);
  }, []);

  useEffect(() => {
    if (hasContent) {
      setLoadingProgress(100);
      return;
    }
    if (!waitingForContent) return;
    setLoadingProgress((current) => current === 100 ? 0 : current);
    const interval = setInterval(() => {
      setLoadingProgress((current) => nextTerminalLoadingProgress(current, false));
    }, 120);
    return () => clearInterval(interval);
  }, [hasContent, waitingForContent]);

  /// Auto-scroll only while the reader is already at the bottom. Yanking a scrolled-up
  /// reader back down every time an agent writes a line makes reading the middle of a
  /// stream impossible.
  const onContentChange = useCallback(() => {
    if (initialPosition !== "ready") {
      const next = reduceInitialTerminalPosition(initialPosition, {
        type: "contentChanged",
        hasContent,
      });
      if (next === "positioning") {
        setInitialPosition(next);
        scroll.current?.scrollToEnd({ animated: false });
        finishInitialPosition();
      }
      return;
    }
    if (atBottom) scroll.current?.scrollToEnd({ animated: false });
  }, [atBottom, finishInitialPosition, hasContent, initialPosition]);

  return (
    <View style={styles.surface}>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          initialPosition === "ready" ? null : styles.initiallyHidden,
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollEndDrag={onScrollEnd}
        onMomentumScrollEnd={onScrollEnd}
        /// Bounce even when the frame is shorter than the viewport, so pulling past the
        /// top stays available on a screen that happens to fit.
        alwaysBounceVertical={canScrollBack}
        onContentSizeChange={onContentChange}
      >
        {capNotice === undefined ? null : (
          <Text style={[styles.capNotice, { fontSize: Math.max(10, fontSize - 2) }]}>{capNotice}</Text>
        )}
        <ScrollView
          horizontal
          contentContainerStyle={styles.horizontal}
          showsHorizontalScrollIndicator={false}
        >
          <View>
            {buffer.screen === undefined
              ? buffer.lines.map((line) => (
                  <TerminalLineText key={line.id} line={line} fontSize={fontSize} lineHeight={lineHeight} />
                ))
              : buffer.screen.map((line) => (
                  <TerminalScreenRow
                    key={line.id}
                    spans={line.spans}
                    fontSize={fontSize}
                    lineHeight={lineHeight}
                  />
                ))}
            {buffer.screen === undefined && buffer.pending.length !== 0 ? (
              <Text style={[styles.output, { fontSize, lineHeight }]} numberOfLines={1} selectable>
                {buffer.pending}
              </Text>
            ) : null}
            {buffer.screen === undefined ? null : buffer.lines
              .filter((line) => line.kind !== "output")
              .map((line) => (
                <TerminalLineText key={`semantic-${line.id}`} line={line} fontSize={fontSize} lineHeight={lineHeight} />
              ))}
          </View>
        </ScrollView>
      </ScrollView>

      {showInitialLoading ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.loading]}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading terminal"
          accessibilityLiveRegion="polite"
          accessibilityValue={{ min: 0, max: 100, now: loadingProgress }}
        >
          <ActivityIndicator color={color.accentStrong} />
          <Text style={styles.loadingLabel}>Loading terminal</Text>
          <Text style={styles.loadingProgress}>{loadingProgress}%</Text>
        </View>
      ) : null}

      {atBottom ? null : (
        <Pressable
          onPress={() => {
            setAtBottom(true);
            scroll.current?.scrollToEnd({ animated: true });
          }}
          accessibilityRole="button"
          accessibilityLabel="Jump to the latest output"
          style={styles.jump}
        >
          <Text style={styles.jumpGlyph}>↓</Text>
        </Pressable>
      )}
    </View>
  );
}

/// Resolved styles are cached against the interned cell style they came from, so a
/// frame that reuses a dozen colours allocates a dozen style objects rather than one
/// per span per redraw.
const spanStyles = new WeakMap<TerminalStyle, TextStyle>();

function spanStyle(style: TerminalStyle): TextStyle {
  const existing = spanStyles.get(style);
  if (existing !== undefined) return existing;
  const created: TextStyle = {
    color: style.foreground,
    ...(style.background === undefined ? null : { backgroundColor: style.background }),
    ...(style.bold ? { fontWeight: "700" as const } : null),
    ...(style.italic ? { fontStyle: "italic" as const } : null),
    ...(style.underline ? { textDecorationLine: "underline" as const } : null),
  };
  spanStyles.set(style, created);
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
  return (
    <Text style={[styles.output, { fontSize, lineHeight }]} numberOfLines={1} selectable>
      {spans.length === 0
        ? " "
        : spans.map((span, index) => (
            <Text key={index} style={spanStyle(span.style)}>{span.text}</Text>
          ))}
    </Text>
  );
});

function TerminalLineText({ line, fontSize, lineHeight }: {
  line: TerminalLine;
  fontSize: number;
  lineHeight: number;
}) {
  if (line.kind === "gap") {
    return (
      <Text style={[styles.gap, { fontSize: Math.max(10, fontSize - 1), lineHeight }]} numberOfLines={1}>
        {`⋯ ${line.text} ⋯`}
      </Text>
    );
  }
  if (line.kind === "notice") {
    return (
      <Text style={[styles.notice, { fontSize: Math.max(10, fontSize - 1), lineHeight }]} numberOfLines={1}>
        {line.text}
      </Text>
    );
  }
  /// Selectable so a long-press can copy a line without the view owning a clipboard
  /// dependency of its own.
  return (
    <Text style={[styles.output, { fontSize, lineHeight }]} numberOfLines={1} selectable>
      {line.text.length === 0 ? " " : line.text}
    </Text>
  );
}

const styles = StyleSheet.create({
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
  gap: { color: color.warning, fontFamily: fontFamily.mono, fontStyle: "italic" },
  notice: { color: color.textMuted, fontFamily: fontFamily.mono },
  capNotice: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    lineHeight: 16,
    marginBottom: space.sm,
  },
  jump: {
    position: "absolute",
    right: space.md,
    bottom: space.md,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
  },
  jumpGlyph: { color: color.text, fontSize: 17, lineHeight: 20 },
});
