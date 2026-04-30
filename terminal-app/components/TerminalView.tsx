import React, { useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import { getTerminalHtml } from '../lib/terminal-html';
import { TerminalTheme } from '../lib/types';

export type TerminalMode = 'scroll' | 'select';

interface TerminalMessage {
  type: 'data' | 'title' | 'bell' | 'resize' | 'ctrlConsumed' | 'selection' | 'doubleTap';
  payload?: string;
  cols?: number;
  rows?: number;
}

interface TerminalViewProps {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  onCtrlConsumed?: () => void;
  onSelection?: (text: string) => void;
  onDoubleTap?: () => void;
}

export interface TerminalViewHandle {
  write: (data: string) => void;
  sendInput: (data: string) => void;
  setCtrl: (active: boolean) => void;
  setTheme: (theme: TerminalTheme) => void;
  setFontSize: (size: number) => void;
  setMode: (mode: TerminalMode) => void;
  refit: () => void;
  scrollLines: (n: number) => void;
  clearSelection: () => void;
  paste: () => void;
  focusInput: () => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onData, onResize, onTitleChange, onCtrlConsumed, onSelection, onDoubleTap }, ref) => {
    const webViewRef = useRef<WebView>(null);

    const postMessage = useCallback((msg: object) => {
      // Using injectJavaScript with a trailing `true;` (instead of WebView.postMessage)
      // silences iOS WKWebView's "JavaScript execution returned a result of an unsupported
      // type" warning that fires on every message during high-throughput PTY streams.
      // Dispatch to `window` only. Dispatching to both window AND document
      // combined with the HTML listening on both caused every message to be
      // handled twice — every `term.write` doubled, producing character-level
      // echo duplication like "ramsie" → "ramamsie".
      const payload = JSON.stringify(JSON.stringify(msg));
      const js = `(function(){var e=new MessageEvent('message',{data:${payload}});window.dispatchEvent(e);})();true;`;
      webViewRef.current?.injectJavaScript(js);
    }, []);

    useImperativeHandle(ref, () => ({
      write(data: string) {
        postMessage({ type: 'write', payload: data });
      },
      sendInput(data: string) {
        postMessage({ type: 'input', payload: data });
      },
      setCtrl(active: boolean) {
        postMessage({ type: 'ctrl', active });
      },
      setTheme(theme: TerminalTheme) {
        postMessage({ type: 'theme', payload: theme.colors });
      },
      setFontSize(size: number) {
        postMessage({ type: 'fontSize', payload: size });
      },
      setMode(mode: TerminalMode) {
        postMessage({ type: 'setMode', payload: mode });
      },
      refit() {
        postMessage({ type: 'refit' });
      },
      scrollLines(n: number) {
        postMessage({ type: 'scrollLines', payload: n });
      },
      clearSelection() {
        postMessage({ type: 'clearSelection' });
      },
      paste() {
        postMessage({ type: 'paste' });
      },
      focusInput() {
        postMessage({ type: 'focusInput' });
      },
    }));

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let msg: TerminalMessage;
        try {
          msg = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case 'data':
            onData?.(msg.payload!);
            break;
          case 'title':
            onTitleChange?.(msg.payload!);
            break;
          case 'bell':
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            break;
          case 'resize':
            onResize?.(msg.cols!, msg.rows!);
            break;
          case 'ctrlConsumed':
            onCtrlConsumed?.();
            break;
          case 'selection':
            if (msg.payload) onSelection?.(msg.payload);
            break;
          case 'doubleTap':
            onDoubleTap?.();
            break;
        }
      },
      [onData, onResize, onTitleChange, onCtrlConsumed, onSelection, onDoubleTap]
    );

    return (
      <WebView
        ref={webViewRef}
        source={{ html: getTerminalHtml() }}
        style={styles.webview}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        allowsBackForwardNavigationGestures={false}
      />
    );
  }
);

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: '#282a36',
  },
});
