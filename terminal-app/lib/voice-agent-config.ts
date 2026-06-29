import { NativeModules, Platform } from "react-native";

type VoiceAgentConnection = {
  id: string;
  name: string;
  host: string;
  alternateHosts?: string[];
  port: number;
  deviceId?: string;
  accessToken?: string;
  password?: string;
};

type NativeVoiceAgentConfig = {
  saveConnection?: (config: {
    id: string;
    name: string;
    host: string;
    alternateHosts?: string[];
    port: number;
    deviceId?: string;
    accessToken?: string;
    password?: string;
  }) => Promise<void>;
  clearConnection?: (connectionId?: string) => Promise<void>;
};

const nativeModule = NativeModules.TermLoopVoiceAgentConfig as
  | NativeVoiceAgentConfig
  | undefined;

export async function saveVoiceAgentConnection(
  conn: VoiceAgentConnection
): Promise<void> {
  if (Platform.OS !== "ios" || !nativeModule?.saveConnection) return;
  if (!conn.deviceId && !conn.password) return;
  if (conn.deviceId && !conn.accessToken) return;

  const [host, ...alternateHosts] = connectionHostCandidates(conn);
  if (!host) return;

  await nativeModule.saveConnection({
    id: conn.id,
    name: conn.name,
    host,
    alternateHosts,
    port: conn.port,
    ...(conn.deviceId ? { deviceId: conn.deviceId } : {}),
    ...(conn.accessToken ? { accessToken: conn.accessToken } : {}),
    ...(conn.password ? { password: conn.password } : {}),
  });
}

export async function clearVoiceAgentConnection(
  connectionId?: string
): Promise<void> {
  if (Platform.OS !== "ios" || !nativeModule?.clearConnection) return;
  await nativeModule.clearConnection(connectionId);
}

function connectionHostCandidates(
  conn: Pick<VoiceAgentConnection, "host" | "alternateHosts">
): string[] {
  const out: string[] = [];
  for (const host of [conn.host, ...(conn.alternateHosts ?? [])]) {
    const normalized = host?.trim();
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}
