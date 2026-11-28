/// Whether this app sends anonymous usage sessions and error reports.
///
/// `unavailable`: this build has no reporting endpoint, or reporting is turned
/// off for the whole process (smoke runs, TERMLOOP_TELEMETRY=off).
/// `restartRequired`: reporting was turned back on and starts at next launch.
export type TelemetryStatus =
  | { state: "available"; enabled: boolean; restartRequired: boolean }
  | { state: "unavailable" };
