import React, { useRef, useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform, Alert, Keyboard, AppState } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { TerminalView, TerminalViewHandle } from '../../components/TerminalView';
import { KeyboardBar, KeyboardBarAction } from '../../components/KeyboardBar';
import { getConnection } from '../../lib/connections';
import { getTheme } from '../../lib/themes';
import { Connection } from '../../lib/types';
import { getSshPassword, setSshPassword } from '../../lib/secrets';
import { buildInitialCommand } from '../../lib/terminal-command';
import {
  removeTerminalResumeRoute,
  upsertTerminalResumeRoute,
} from '../../lib/terminal-resume-route';
import { makeTerminalInstanceId } from '../../lib/terminal-route-instance';
import * as Ssh from '../../modules/expo-ssh';

const TERMINAL_SETTINGS_KEY = 'terminal_settings';

interface TerminalSettings {
  defaultTheme?: string;
  fontSize?: number;
  hapticEnabled?: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 3;

export default function TerminalScreen() {
  const { id, cwd, resume, workspaceId, instanceId } = useLocalSearchParams<{
    id: string;
    cwd?: string;
    resume?: string;
    workspaceId?: string;
    instanceId?: string;
  }>();
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const termRef = useRef<TerminalViewHandle>(null);

  const [connection, setConnection] = useState<Connection | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [password, setPassword] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const initialCommandSentRef = useRef(false);
  const intentionalDisconnectRef = useRef(false);
  const connectingRef = useRef(false);
  const resumeInstanceIdRef = useRef(
    typeof instanceId === 'string' && instanceId.trim().length > 0
      ? instanceId
      : makeTerminalInstanceId()
  );
  const hapticEnabledRef = useRef(true);

  // Keep every resumable terminal screen in persistent order so a cold app
  // restart can rebuild the full terminal stack, not just the top screen.
  useEffect(() => {
    if (!resume) return;
    void upsertTerminalResumeRoute({
      instanceId: resumeInstanceIdRef.current,
      id,
      resume,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
  }, [id, cwd, resume, workspaceId]);

  useEffect(() => {
    if (!resume) return;
    return navigation.addListener('beforeRemove', () => {
      removeTerminalResumeRoute(resumeInstanceIdRef.current).catch(() => {});
    });
  }, [navigation, resume]);

  useFocusEffect(
    useCallback(() => {
      if (!resume) return undefined;
      void upsertTerminalResumeRoute({
        instanceId: resumeInstanceIdRef.current,
        id,
        resume,
        ...(cwd ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      return undefined;
    }, [id, cwd, resume, workspaceId])
  );

  // Load app-wide terminal settings (font size + default theme) and apply them.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(TERMINAL_SETTINGS_KEY).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const s = JSON.parse(raw) as TerminalSettings;
        if (typeof s.fontSize === 'number' && termRef.current) {
          termRef.current.setFontSize(s.fontSize);
        }
        if (s.defaultTheme && termRef.current && !connection?.theme) {
          const theme = getTheme(s.defaultTheme);
          if (theme) termRef.current.setTheme(theme);
        }
        hapticEnabledRef.current = s.hapticEnabled !== false;
      } catch {}
    });
    return () => { cancelled = true; };
  }, [connection]);

  // Load connection config
  useEffect(() => {
    if (!id) return;
    getConnection(id).then((conn) => {
      if (!conn) {
        Alert.alert('Error', 'Connection not found');
        navigation.goBack();
        return;
      }
      setConnection(conn);
    });
  }, [id]);

  // Load stored SSH password, fall back to Alert.prompt
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    (async () => {
      const stored = await getSshPassword(connection.id);
      if (cancelled) return;
      if (stored) {
        setPassword(stored);
        return;
      }
      Alert.prompt(
        'SSH Password',
        `Enter password for ${connection.ssh.user}@${connection.host}`,
        async (text) => {
          if (!text) return;
          await setSshPassword(connection.id, text);
          if (!cancelled) setPassword(text);
        },
        'secure-text',
      );
    })();
    return () => { cancelled = true; };
  }, [connection]);

  // Track keyboard visibility — also refit xterm on toggle so prompt stays visible.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
      setTimeout(() => termRef.current?.refit(), 50);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setTimeout(() => termRef.current?.refit(), 50);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Connect SSH once we have both connection config and password
  useEffect(() => {
    if (!connection || !password) return;

    let currentSessionId: string | null = null;

    // Subscribe to SSH events ONCE per useEffect mount. `Ssh.onShellData` and
    // `onDisconnect` are global EventEmitter listeners filtered per-event by
    // `event.sessionId === currentSessionId`. Re-subscribing inside connectSsh
    // leaked native listeners across reconnects (N reconnects → N duplicate
    // writes per byte), producing the "ramamsie" / "mssiiee" garbled echo.
    const shellDataSub = Ssh.onShellData((event) => {
      if (event.sessionId === currentSessionId) {
        termRef.current?.write(event.data);
      }
    });
    const disconnectSub = Ssh.onDisconnect((event) => {
      if (event.sessionId === currentSessionId) {
        termRef.current?.write(`\r\nDisconnected: ${event.error ?? 'connection closed'}\r\n`);
        handleDisconnect();
      }
    });

    function maybeSendInitialCommand(sid: string) {
      if (initialCommandSentRef.current) return;
      if (!resume) return;
      const cmd = buildInitialCommand({ resumeId: resume, cwd, workspaceId });
      Ssh.writeToShell(sid, cmd).catch((e) => console.warn('initial cmd failed', e));
      initialCommandSentRef.current = true;
    }

    async function connectSsh() {
      if (connectingRef.current || currentSessionId) return;
      connectingRef.current = true;
      try {
        termRef.current?.write(`Connecting to ${connection!.host}...\r\n`);

        currentSessionId = await Ssh.connect({
          host: connection!.host,
          port: connection!.ssh.port,
          username: connection!.ssh.user,
          password: password ?? undefined,
        });
        setSessionId(currentSessionId);

        await Ssh.startShell(currentSessionId, 'xterm-256color', termSize.cols, termSize.rows);

        const theme = getTheme(connection!.theme);
        if (theme) termRef.current?.setTheme(theme);

        setReconnectAttempts(0);

        setTimeout(() => {
          if (currentSessionId) maybeSendInitialCommand(currentSessionId);
        }, 600);
      } catch (err: any) {
        termRef.current?.write(`\r\nConnection failed: ${err.message}\r\n`);
        handleDisconnect();
      } finally {
        connectingRef.current = false;
      }
    }

    function handleDisconnect() {
      setSessionId(null);
      currentSessionId = null;
      initialCommandSentRef.current = false;
      if (intentionalDisconnectRef.current) {
        termRef.current?.write('\r\nPaused (app backgrounded). Resume on return.\r\n');
        return;
      }
      setReconnectAttempts((prev) => {
        const next = prev + 1;
        if (next <= MAX_RECONNECT_ATTEMPTS) {
          termRef.current?.write(`Reconnecting (${next}/${MAX_RECONNECT_ATTEMPTS})...\r\n`);
          setTimeout(connectSsh, 2000);
        } else {
          termRef.current?.write('Max reconnect attempts reached.\r\n');
        }
        return next;
      });
    }

    const appStateSub = AppState.addEventListener('change', (next) => {
      // Only react to real `background` — `inactive` fires for transient states
      // like Control Center peek, which would otherwise churn SSH for no reason
      // and race foregrounds against still-landing disconnects.
      if (next === 'background') {
        if (currentSessionId) {
          intentionalDisconnectRef.current = true;
          const sid = currentSessionId;
          Ssh.disconnect(sid).catch(() => {});
        }
      } else if (next === 'active') {
        if (!currentSessionId && !connectingRef.current && intentionalDisconnectRef.current) {
          intentionalDisconnectRef.current = false;
          setReconnectAttempts(0);
          termRef.current?.write('\r\nResuming...\r\n');
          connectSsh();
        }
      }
    });

    connectSsh();

    return () => {
      shellDataSub.remove();
      disconnectSub.remove();
      appStateSub.remove();
      if (currentSessionId) {
        Ssh.disconnect(currentSessionId).catch(() => {});
      }
    };
  }, [connection, password, cwd, resume, workspaceId]);

  const handleData = useCallback(
    (data: string) => {
      if (sessionId) {
        Ssh.writeToShell(sessionId, data).catch((err) => {
          console.warn('Write failed:', err);
        });
      }
    },
    [sessionId]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      setTermSize({ cols, rows });
      if (sessionId) {
        Ssh.resizeShell(sessionId, cols, rows).catch(() => {});
      }
    },
    [sessionId]
  );

  const handleSelection = useCallback((_text: string) => {
    if (hapticEnabledRef.current) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, []);

  const writeToSsh = useCallback(
    (data: string) => {
      if (!data || !sessionId) return;
      Ssh.writeToShell(sessionId, data).catch(() => {});
    },
    [sessionId]
  );

  const handleKeyboardAction = useCallback(
    (action: KeyboardBarAction) => {
      switch (action.kind) {
        case 'input':
          writeToSsh(action.value);
          return;
        case 'ctrl-toggle':
          termRef.current?.setCtrl(action.active);
          return;
        case 'select-toggle': {
          setSelectMode(action.active);
          termRef.current?.setMode(action.active ? 'select' : 'scroll');
          return;
        }
        case 'scroll':
          // Local xterm scroll (no-op when Claude's TUI redraws in place and
          // scrollback stays empty), and remote page keys so tmux copy-mode
          // can page through its own scrollback.
          termRef.current?.scrollLines(action.lines);
          writeToSsh(action.lines < 0 ? '\x1b[5~' : '\x1b[6~');
          return;
        case 'paste': {
          termRef.current?.paste();
          return;
        }
      }
    },
    [writeToSsh]
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      navigation.setOptions({ headerTitle: title });
    },
    [navigation]
  );

  const handleDoubleTap = useCallback(() => {
    if (keyboardVisible) {
      Keyboard.dismiss();
    } else {
      termRef.current?.focusInput();
    }
  }, [keyboardVisible]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <TerminalView
        ref={termRef}
        onData={handleData}
        onResize={handleResize}
        onTitleChange={handleTitleChange}
        onCtrlConsumed={() => {}}
        onSelection={handleSelection}
        onDoubleTap={handleDoubleTap}
      />
      <KeyboardBar onAction={handleKeyboardAction} selectActive={selectMode} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#282a36',
  },
});
