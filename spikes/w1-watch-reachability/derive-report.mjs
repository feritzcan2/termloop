// Derives REPORT.md from evidence/watch-reports.jsonl. Status is computed
// from evidence only; scenarios without a report are UNMEASURED.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const reportsPath = join(here, "evidence", "watch-reports.jsonl");

const MATRIX = [
  "iphone-same-wifi",
  "iphone-cellular-nearby",
  "tailscale-on-phone",
  "tailscale-away-from-lan",
];
const PASS_THRESHOLD = 6;

const rows = existsSync(reportsPath)
  ? readFileSync(reportsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  : [];

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const byScenario = new Map();
for (const row of rows) {
  const scenario = row.report?.scenario;
  if (typeof scenario !== "string") continue;
  if (!byScenario.has(scenario)) byScenario.set(scenario, []);
  byScenario.get(scenario).push(row);
}

const lines = [];
lines.push("# W1 watch-reachability spike report");
lines.push("");
lines.push(`Derived from ${rows.length} watch report(s) in \`evidence/watch-reports.jsonl\`.`);
lines.push("Regenerate with `node spikes/w1-watch-reachability/derive-report.mjs`.");
lines.push("");
lines.push("| scenario | status | best run | median latency (ms) | device | reports |");
lines.push("| --- | --- | --- | --- | --- | --- |");

const scenarioNames = [...new Set([...MATRIX, ...byScenario.keys()])];
for (const scenario of scenarioNames) {
  const reports = byScenario.get(scenario) ?? [];
  if (reports.length === 0) {
    lines.push(`| ${scenario} | UNMEASURED | — | — | — | 0 |`);
    continue;
  }
  const best = reports.reduce((a, b) =>
    (b.report.successCount ?? 0) > (a.report.successCount ?? 0) ? b : a,
  );
  const successCount = best.report.successCount ?? 0;
  const attemptCount = best.report.attemptCount ?? 0;
  const status = successCount >= PASS_THRESHOLD ? "PASS" : "FAIL";
  const latencies = (best.report.attempts ?? [])
    .filter((attempt) => attempt.ok && typeof attempt.latencyMs === "number")
    .map((attempt) => attempt.latencyMs);
  const medianLatency = median(latencies);
  const device = best.report.device
    ? `${best.report.device.model} watchOS ${best.report.device.systemVersion}`
    : "unknown";
  lines.push(
    `| ${scenario} | ${status} | ${successCount}/${attemptCount} | ${
      medianLatency === null ? "—" : Math.round(medianLatency)
    } | ${device} | ${reports.length} |`,
  );
}

lines.push("");
lines.push(`PASS requires at least ${PASS_THRESHOLD} of 8 pings in a single run.`);
lines.push("Route attribution: compare each report's `remoteAddress` (recorded by the");
lines.push("server) against the iPhone's and watch's own addresses to see whether the");
lines.push("request traversed the phone proxy or the watch's own Wi-Fi.");
lines.push("");
const unmeasured = MATRIX.filter((scenario) => !byScenario.has(scenario));
if (unmeasured.length > 0) {
  lines.push(`Unmeasured matrix scenarios: ${unmeasured.join(", ")}.`);
} else {
  lines.push("All matrix scenarios have at least one report.");
}
lines.push("");

writeFileSync(join(here, "REPORT.md"), lines.join("\n"));
console.log(`Wrote REPORT.md (${rows.length} report(s), ${unmeasured.length} unmeasured scenario(s)).`);
