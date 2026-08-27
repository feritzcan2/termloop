export type TailscaleTransportInput = {
  kind: "tailscale";
  baseUrl: string;
};

export type SshTransportInput = {
  kind: "ssh";
  host: string;
  user?: string;
  remotePort: number;
};

export type ConnectionTransportInput = TailscaleTransportInput | SshTransportInput;

export type ConnectionProfileConnectInput = {
  name: string;
  transport: ConnectionTransportInput;
  expectedServerFingerprint?: string;
};

export type ConnectionProfileSummary = {
  id: string;
  name: string;
  transport: "local" | "tailscale" | "ssh";
  scope: "local" | "full" | "readOnly";
  endpoint: string;
  enabled: boolean;
  persistence: "local" | "encrypted" | "sessionOnly";
  warning?: string;
  state?: ConnectionSourceState;
  message?: string;
};

export type ConnectionSourceState = "connecting" | "connected" | "offline";

export type ConnectionSourceSummary = ConnectionProfileSummary & {
  state: ConnectionSourceState;
  message?: string;
};

export type ConnectionProfileConnectResult = {
  profile: ConnectionProfileSummary;
  warning?: string;
};

export type DiscoveredTailscaleServer = {
  name: string;
  dnsName: string;
  baseUrl: string;
  serverFingerprint: string;
};

export type TailscaleServerDiscovery = {
  state: "ready" | "unavailable";
  servers: DiscoveredTailscaleServer[];
  message?: string;
};

export type RemoteHostTransport = "tailscale" | "ssh";

export type RemoteHostTailscaleStatus =
  | { state: "idle" }
  | { state: "available"; baseUrl: string }
  | { state: "ready"; baseUrl: string }
  | { state: "conflict"; message: string }
  | { state: "unavailable"; message: string };

export type RemoteHostStatus = {
  enabled: boolean;
  listening: boolean;
  port: number | null;
  serverFingerprint: string;
  tailscale: RemoteHostTailscaleStatus;
  warning?: string;
  error?: string;
};
