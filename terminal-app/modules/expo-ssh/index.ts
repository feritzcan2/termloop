import { EventEmitter, type EventSubscription } from 'expo-modules-core';
import ExpoSshModule from './src/ExpoSshModule';

const emitter = new EventEmitter(ExpoSshModule as any);

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface SshShellDataEvent {
  sessionId: string;
  data: string;
}

export interface SshDisconnectEvent {
  sessionId: string;
  error?: string;
}

export function connect(config: SshConnectConfig): Promise<string> {
  return ExpoSshModule.connect(
    config.host,
    config.port,
    config.username,
    config.password ?? '',
    config.privateKey ?? ''
  );
}

export function startShell(
  sessionId: string,
  termType: string,
  cols: number,
  rows: number
): Promise<void> {
  return ExpoSshModule.startShell(sessionId, termType, cols, rows);
}

export function writeToShell(sessionId: string, data: string): Promise<void> {
  return ExpoSshModule.writeToShell(sessionId, data);
}

export function resizeShell(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  return ExpoSshModule.resizeShell(sessionId, cols, rows);
}

export function closeShell(sessionId: string): Promise<void> {
  return ExpoSshModule.closeShell(sessionId);
}

export function disconnect(sessionId: string): Promise<void> {
  return ExpoSshModule.disconnect(sessionId);
}

export function onShellData(
  callback: (event: SshShellDataEvent) => void
): EventSubscription {
  return (emitter as any).addListener('onShellData', callback);
}

export function onDisconnect(
  callback: (event: SshDisconnectEvent) => void
): EventSubscription {
  return (emitter as any).addListener('onDisconnect', callback);
}
