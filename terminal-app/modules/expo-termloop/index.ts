import { EventEmitter, type EventSubscription } from 'expo-modules-core';
import ExpoTermLoopModule from './src/ExpoTermLoopModule';

const emitter = new EventEmitter(ExpoTermLoopModule as any);

export type TermLoopConnectionState = 'ready' | 'failed' | 'cancelled';

export interface TermLoopMessageEvent {
  sessionId: string;
  line: string;
}

export interface TermLoopStateEvent {
  sessionId: string;
  state: TermLoopConnectionState;
  error?: string;
}

export interface TermLoopDisconnectEvent {
  sessionId: string;
  error?: string;
}

export function connect(host: string, port: number): Promise<string> {
  return ExpoTermLoopModule.connect(host, port);
}

export function send(sessionId: string, line: string): Promise<void> {
  return ExpoTermLoopModule.send(sessionId, line);
}

export function disconnect(sessionId: string): Promise<void> {
  return ExpoTermLoopModule.disconnect(sessionId);
}

export function onMessage(
  callback: (event: TermLoopMessageEvent) => void
): EventSubscription {
  return (emitter as any).addListener('onMessage', callback);
}

export function onState(
  callback: (event: TermLoopStateEvent) => void
): EventSubscription {
  return (emitter as any).addListener('onState', callback);
}

export function onDisconnect(
  callback: (event: TermLoopDisconnectEvent) => void
): EventSubscription {
  return (emitter as any).addListener('onDisconnect', callback);
}
