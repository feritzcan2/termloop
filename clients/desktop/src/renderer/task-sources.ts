import type {
  TaskSourceCandidateDto,
  TaskSourceCandidateState,
  TaskSourceBoardDto,
  TaskSourceBoardSelectionDto,
  TaskSourceCredentialState,
  TaskSourceCredentialsSetResult,
  TaskSourceDto,
  TaskSourceFailureReason,
  TaskSourceImportPolicy,
  TaskSourceMutationResult,
  TaskSourceRefreshResult,
  TaskSourceScopeKind,
  TaskSourceStatusDto,
} from "@termloop/contract/current";

/// Presentation rules for Project Task Sources. Everything here is a pure
/// projection of generated DTOs: the renderer names states and orders rows, it
/// never decides what a candidate is or whether a Task exists.

export const TASK_SOURCE_NAME_MAX_CHARACTERS = 80;
export const TASK_SOURCE_JQL_MAX_CHARACTERS = 4_096;
export const TASK_SOURCE_REFRESH_MIN_SECONDS = 60;
export const TASK_SOURCE_REFRESH_MAX_SECONDS = 86_400;
export const TASK_SOURCE_DEFAULT_REFRESH_SECONDS = 15 * 60;
export const TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT = 5;
export const TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX = 50;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/// The daemon accepts only an Atlassian Cloud site. Mirroring that gate here
/// keeps the message next to the field instead of a rejected round trip.
const JIRA_CLOUD_SITE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.atlassian\.net$/u;

export type TaskSourceDraft = {
  name: string;
  siteBaseUrl: string;
  scopeKind: TaskSourceScopeKind;
  boards: TaskSourceBoardSelectionDto[];
  statuses: TaskSourceStatusDto[];
  jql: string;
  importPolicy: TaskSourceImportPolicy;
  autoImportActiveTaskLimit: number;
  refreshIntervalSeconds: number;
};

export function emptyTaskSourceDraft(): TaskSourceDraft {
  return {
    name: "",
    siteBaseUrl: "",
    scopeKind: "assignedToMe",
    boards: [],
    statuses: [],
    jql: "",
    importPolicy: "review",
    autoImportActiveTaskLimit: TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
    refreshIntervalSeconds: TASK_SOURCE_DEFAULT_REFRESH_SECONDS,
  };
}

export function taskSourceDraftFrom(source: TaskSourceDto): TaskSourceDraft {
  return {
    name: source.name,
    siteBaseUrl: source.siteBaseUrl,
    scopeKind: source.scopeKind,
    boards: source.boards,
    statuses: source.statuses,
    jql: source.jql ?? "",
    importPolicy: source.importPolicy,
    autoImportActiveTaskLimit: source.autoImportActiveTaskLimit,
    refreshIntervalSeconds: source.refreshIntervalSeconds,
  };
}

/// Trailing slashes and whitespace are the usual paste artifacts; a path or a
/// query is not, so those still fail validation visibly.
export function normalizeSiteBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/// Where the pasted address came from, for the confirmation line under the
/// field: a bare site, an issue link, or some other page on the same site.
export type JiraSiteInputKind = "site" | "issue" | "path";

export type JiraSiteInput =
  | { ok: true; siteBaseUrl: string; tenant: string; kind: JiraSiteInputKind; issueKey?: string; boardId?: string }
  | { ok: false; message: string };

/// Atlassian Cloud tenants are exactly one DNS label under atlassian.net.
/// Requiring that single label rejects look-alikes such as
/// `acme.atlassian.net.evil.example` (wrong suffix) and
/// `evil.acme.atlassian.net` (extra label) in one rule.
const JIRA_CLOUD_TENANT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,19}$/u;
const JIRA_BOARD_ID = /^[1-9][0-9]{0,19}$/u;

/// Turns whatever the user pasted — the site itself, an issue link, a board
/// URL — into the exact lowercase `https://<tenant>.atlassian.net` the daemon
/// accepts. Anything that could point somewhere else (other scheme, userinfo,
/// port, query, fragment, another host) is refused with the reason, never
/// silently rewritten. A bare host with no scheme is the one shorthand allowed,
/// because https is the only transport the daemon will use anyway.
export function normalizeJiraSiteInput(value: string): JiraSiteInput {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, message: "Paste your Jira site or any issue link, for example https://acme.atlassian.net/browse/ABC-123." };
  if (/[\s\p{Cc}]/u.test(trimmed)) return { ok: false, message: "The address must not contain spaces or line breaks." };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: "That is not a valid web address." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Only https:// Jira Cloud addresses are accepted." };
  if (url.username || url.password) return { ok: false, message: "Remove the user name or password from the address." };
  if (url.port) return { ok: false, message: "Jira Cloud does not use a custom port; remove it." };
  if (url.search) return { ok: false, message: "Remove the query string (everything after “?”)." };
  if (url.hash) return { ok: false, message: "Remove the fragment (everything after “#”)." };
  const host = url.hostname.toLowerCase();
  const tenant = host.endsWith(".atlassian.net") ? host.slice(0, -".atlassian.net".length) : undefined;
  if (tenant === undefined || !JIRA_CLOUD_TENANT.test(tenant)) {
    return { ok: false, message: "Only Jira Cloud sites are supported: the host must be <site>.atlassian.net." };
  }
  const siteBaseUrl = `https://${tenant}.atlassian.net`;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { ok: true, siteBaseUrl, tenant, kind: "site" };
  if (segments[0] === "browse" && segments.length === 2 && JIRA_ISSUE_KEY.test(segments[1]!)) {
    return { ok: true, siteBaseUrl, tenant, kind: "issue", issueKey: segments[1]! };
  }
  const boardId = segments.at(-2) === "boards" && JIRA_BOARD_ID.test(segments.at(-1) ?? "")
    ? segments.at(-1)
    : undefined;
  return { ok: true, siteBaseUrl, tenant, kind: "path", ...(boardId ? { boardId } : {}) };
}

export type JiraBoardLookup =
  | { ok: true; boardId: string }
  | { ok: false; message: string };

/// Accepts either the numeric board ID or a board URL from the same Jira site.
/// The URL is normalized through the same origin gate as the connect field, so
/// a pasted look-alike host can never redirect discovery or cross tenants.
export function normalizeJiraBoardLookup(value: string, siteBaseUrl: string): JiraBoardLookup {
  const trimmed = value.trim();
  if (JIRA_BOARD_ID.test(trimmed)) return { ok: true, boardId: trimmed };
  const parsed = normalizeJiraSiteInput(trimmed);
  if (!parsed.ok || !parsed.boardId) {
    return { ok: false, message: "Paste a Jira board URL or its numeric board ID." };
  }
  if (parsed.siteBaseUrl !== normalizeSiteBaseUrl(siteBaseUrl).toLowerCase()) {
    return { ok: false, message: "That board belongs to a different Jira site." };
  }
  return { ok: true, boardId: parsed.boardId };
}

export function mergeBoardOptions(current: TaskSourceBoardDto[], incoming: TaskSourceBoardDto[]): TaskSourceBoardDto[] {
  const byId = new Map(current.map((board) => [board.id, board]));
  for (const board of incoming) byId.set(board.id, board);
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/// "acme" → "Acme Jira", "my-team" → "My Team Jira". Capitalizes each word of
/// the tenant label; the result always fits the daemon's name bound.
export function deriveSourceName(tenant: string): string {
  const words = tenant
    .split(/[-_.]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  const label = words.length > 0 ? words.join(" ") : tenant;
  const name = `${label} Jira`;
  if (utf8ByteLength(name) <= TASK_SOURCE_NAME_MAX_CHARACTERS) return name;
  let end = TASK_SOURCE_NAME_MAX_CHARACTERS - " Jira".length;
  while (utf8ByteLength(label.slice(0, end)) > TASK_SOURCE_NAME_MAX_CHARACTERS - " Jira".length) end -= 1;
  return `${label.slice(0, end).trimEnd()} Jira`;
}

export function taskSourceDraftError(draft: TaskSourceDraft): string | undefined {
  const name = draft.name.trim();
  if (name.length === 0) return "Name the source so it is recognizable in the list.";
  if (utf8ByteLength(name) > TASK_SOURCE_NAME_MAX_CHARACTERS) return `Name must stay within ${TASK_SOURCE_NAME_MAX_CHARACTERS} UTF-8 bytes.`;
  const site = normalizeSiteBaseUrl(draft.siteBaseUrl);
  if (site.length === 0) return "Enter the Jira Cloud site, for example https://acme.atlassian.net.";
  if (!JIRA_CLOUD_SITE.test(site)) return "Site must be an https://<site>.atlassian.net address with no path.";
  // Board and status rows can only enter this draft through generated Jira
  // discovery results (or an already validated source projection). Their
  // field shape is therefore owned by the generated contract and Core. The UI
  // owns only interaction invariants here: bounds and duplicate selections.
  if (draft.boards.length > 10
    || new Set(draft.boards.map((board) => board.id)).size !== draft.boards.length) {
    return "Choose up to 10 different Jira boards after loading the boards visible to this account.";
  }
  if (draft.statuses.length > 100
    || new Set(draft.statuses.map((status) => status.id)).size !== draft.statuses.length) {
    return "Choose up to 100 different Jira statuses loaded from the selected boards.";
  }
  if (draft.statuses.length > 0 && draft.boards.length === 0) {
    return "Choose at least one Jira board before filtering by status.";
  }
  if (draft.scopeKind === "jql") {
    const jql = draft.jql.trim();
    if (jql.length === 0) return "Advanced scope needs a JQL query.";
    if (utf8ByteLength(jql) > TASK_SOURCE_JQL_MAX_CHARACTERS) return `JQL must stay within ${TASK_SOURCE_JQL_MAX_CHARACTERS.toLocaleString("en-US")} UTF-8 bytes.`;
  }
  if (!Number.isInteger(draft.autoImportActiveTaskLimit)
    || draft.autoImportActiveTaskLimit < 1
    || draft.autoImportActiveTaskLimit > TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX) {
    return `Automatic import active Task limit must be between 1 and ${TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX}.`;
  }
  if (!Number.isInteger(draft.refreshIntervalSeconds)
    || draft.refreshIntervalSeconds < TASK_SOURCE_REFRESH_MIN_SECONDS
    || draft.refreshIntervalSeconds > TASK_SOURCE_REFRESH_MAX_SECONDS) {
    return "Refresh interval must be between 1 minute and 24 hours.";
  }
  return undefined;
}

export function taskSourceCredentialsError(email: string, apiToken: string): string | undefined {
  const trimmedEmail = email.trim();
  const emailParts = trimmedEmail.split("@");
  if (trimmedEmail.length < 3 || emailParts.length !== 2 || !emailParts[0] || !emailParts[1] || /[\s\p{Cc}]/u.test(trimmedEmail)) {
    return "Enter the Atlassian account email.";
  }
  if (utf8ByteLength(trimmedEmail) > 254) return "Email is too long.";
  if (apiToken.length === 0) return "Paste an Atlassian API token.";
  if (utf8ByteLength(apiToken) > 1_024) return "API token is too long.";
  if (/[\s\p{Cc}]/u.test(apiToken)) return "API token must not contain spaces or line breaks.";
  return undefined;
}

export function intakeLabel(policy: TaskSourceImportPolicy, activeTaskLimit?: number): string {
  return policy === "autoAdd"
    ? `Auto-import · ${activeTaskLimit ?? TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT} active max`
    : "Review";
}

export const TASK_SOURCE_REFRESH_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 5 * 60, label: "Every 5 minutes" },
  { seconds: 15 * 60, label: "Every 15 minutes" },
  { seconds: 30 * 60, label: "Every 30 minutes" },
  { seconds: 60 * 60, label: "Every hour" },
  { seconds: 6 * 60 * 60, label: "Every 6 hours" },
  { seconds: 24 * 60 * 60, label: "Once a day" },
];

export function refreshIntervalLabel(seconds: number): string {
  const known = TASK_SOURCE_REFRESH_OPTIONS.find((option) => option.seconds === seconds);
  if (known) return known.label;
  if (seconds % 3_600 === 0) return `Every ${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

/// Issue scope, boards, and statuses are three independent filters that always
/// apply together. One projection names all three in the same order and wording
/// so the form's summary, the source row, and the tests never drift apart.
export type TaskSourceFilterSelection = Pick<TaskSourceDto, "scopeKind" | "boards" | "statuses">;

export type TaskSourceFilterPart = {
  key: "scope" | "boards" | "statuses";
  label: string;
  /// What the filter currently keeps, or the "no filter" wording when unset.
  value: string;
  /// Every selected name, for a title attribute when `value` is a count.
  detail?: string;
  filled: boolean;
};

export const SCOPE_KIND_LABEL: Record<TaskSourceScopeKind, string> = {
  assignedToMe: "Assigned to me",
  all: "All issues",
  jql: "Advanced JQL",
};

/// One name, two names joined by "or" — boards and statuses widen a match — and
/// a count beyond that, because a long comma list stops being scannable.
function selectionSummary(names: readonly string[], plural: string): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.length} ${plural}`;
}

export function filterSummaryParts(filters: TaskSourceFilterSelection): TaskSourceFilterPart[] {
  const boardNames = filters.boards.map((board) => board.name);
  const statusNames = filters.statuses.map((status) => status.name);
  return [
    { key: "scope", label: "Issue scope", value: SCOPE_KIND_LABEL[filters.scopeKind], filled: true },
    {
      key: "boards",
      label: "Boards",
      value: boardNames.length === 0 ? "Any board" : selectionSummary(boardNames, "boards"),
      ...(boardNames.length > 2 ? { detail: boardNames.join(", ") } : {}),
      filled: boardNames.length > 0,
    },
    {
      key: "statuses",
      label: "Statuses",
      value: statusNames.length === 0 ? "Any status" : selectionSummary(statusNames, "statuses"),
      ...(statusNames.length > 2 ? { detail: statusNames.join(", ") } : {}),
      filled: statusNames.length > 0,
    },
  ];
}

/// The row-level form: the scope always shows, the optional filters only once
/// they narrow something.
export function filterSummaryLine(filters: TaskSourceFilterSelection): string {
  return filterSummaryParts(filters)
    .filter((part) => part.filled)
    .map((part) => part.value)
    .join(" · ");
}

export function scopeLabel(source: TaskSourceFilterSelection): string {
  return filterSummaryLine(source);
}

/// Statuses are discovered only from the currently selected boards, so changing
/// the board set can retire a status. Keeping every still-offered selection and
/// naming the retired ones is safer than clearing the whole status filter
/// silently: the user sees exactly what the board change cost them.
export function reconcileStatusSelection(
  selected: readonly TaskSourceStatusDto[],
  discovered: readonly TaskSourceStatusDto[],
): { statuses: TaskSourceStatusDto[]; dropped: string[] } {
  const offered = (status: TaskSourceStatusDto) => discovered.some((row) => row.id === status.id && row.name === status.name);
  return {
    statuses: selected.filter((status) => offered(status)),
    dropped: selected.filter((status) => !offered(status)).map((status) => status.name),
  };
}

export function staleStatusNotice(dropped: readonly string[]): string | undefined {
  if (dropped.length === 0) return undefined;
  const quoted = dropped.map((name) => `“${name}”`);
  const list = quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
  return dropped.length === 1
    ? `${list} is not offered by the selected boards, so it left the status filter.`
    : `${list} are not offered by the selected boards, so they left the status filter.`;
}

/// Removing the last board takes the status filter with it: a status only
/// exists inside a board, and the daemon rejects statuses without one. Doing it
/// here — with a notice — keeps the form savable instead of leaving a hidden
/// selection behind the locked status step.
export function applyBoardChange(
  boards: TaskSourceBoardSelectionDto[],
  statuses: readonly TaskSourceStatusDto[],
): { boards: TaskSourceBoardSelectionDto[]; statuses: TaskSourceStatusDto[]; notice: string | undefined } {
  if (boards.length > 0 || statuses.length === 0) return { boards, statuses: [...statuses], notice: undefined };
  return {
    boards,
    statuses: [],
    notice: `The status filter (${statuses.map((status) => status.name).join(", ")}) was cleared with the last board: a status filter needs at least one selected board.`,
  };
}

/// Whether two id/name selections are the same list in the same order. Used to
/// tell an untouched stored filter from one the user is re-choosing, so an
/// unrelated edit never has to re-discover boards or statuses first.
export function sameSelection(
  left: readonly { id: string; name: string }[],
  right: readonly { id: string; name: string }[],
): boolean {
  return left.length === right.length
    && left.every((item, index) => item.id === right[index]?.id && item.name === right[index]?.name);
}

export function credentialStateLabel(state: TaskSourceCredentialState): string {
  switch (state) {
    case "none": return "No credentials";
    case "present": return "Credentials stored";
    case "invalid": return "Credentials rejected";
    case "unavailable": return "Credentials unreadable";
  }
}

export function failureReasonCopy(reason: TaskSourceFailureReason): string {
  switch (reason) {
    case "credentialsMissing": return "Add an email and API token before this source can refresh.";
    case "credentialsInvalid": return "Jira rejected the stored email or API token. Replace the credentials.";
    case "credentialsUnavailable": return "The stored credentials could not be read from secure storage. Replace them.";
    case "scopeInvalid": return "Jira rejected the scope. Check the board, JQL, or site address.";
    case "rateLimited": return "Jira is rate limiting requests. TermLoop retries after the wait it asked for.";
    case "providerUnavailable": return "Jira could not be reached. TermLoop retries on the next interval.";
    case "responseTooLarge": return "Jira returned more than 8 MiB in one refresh. Switch to Advanced JQL and narrow the query.";
    case "malformedResponse": return "Jira returned a response TermLoop could not read.";
  }
}

export type TaskSourceHealthTone = "ok" | "attention" | "muted" | "busy";

export function sourceHealth(source: TaskSourceDto, now: number): { tone: TaskSourceHealthTone; label: string; detail?: string } {
  if (!source.enabled) return { tone: "muted", label: "Disabled" };
  if (source.runtimeState === "refreshing") return { tone: "busy", label: "Refreshing…" };
  if (source.credentialState === "none") return { tone: "attention", label: "Needs credentials", detail: failureReasonCopy("credentialsMissing") };
  if (source.runtimeState === "attention" || source.failureReason) {
    const reason = source.failureReason ?? "providerUnavailable";
    const retry = source.retryAfterEpochMs && source.retryAfterEpochMs > now
      ? ` Retry ${relativeTime(source.retryAfterEpochMs, now)}.`
      : "";
    return { tone: "attention", label: failureReasonLabel(reason), detail: failureReasonCopy(reason) + retry };
  }
  if (source.lastSuccessfulAtEpochMs === null) return { tone: "muted", label: "Not refreshed yet" };
  return { tone: "ok", label: `Synced ${relativeTime(source.lastSuccessfulAtEpochMs, now)}` };
}

function failureReasonLabel(reason: TaskSourceFailureReason): string {
  switch (reason) {
    case "credentialsMissing": return "Needs credentials";
    case "credentialsInvalid": return "Credentials rejected";
    case "credentialsUnavailable": return "Credentials unreadable";
    case "scopeInvalid": return "Scope rejected";
    case "rateLimited": return "Rate limited";
    case "providerUnavailable": return "Jira unreachable";
    case "responseTooLarge": return "Result too large";
    case "malformedResponse": return "Unreadable response";
  }
}

/// Coarse relative time for source health. Past instants read "3 min ago",
/// future instants (retry deadlines) read "in 3 min".
export function relativeTime(epochMs: number, now: number): string {
  const delta = epochMs - now;
  const magnitude = Math.abs(delta);
  const unit = magnitude < 60_000 ? "just now"
    : magnitude < 3_600_000 ? `${Math.round(magnitude / 60_000)} min`
    : magnitude < 86_400_000 ? `${Math.round(magnitude / 3_600_000)} h`
    : `${Math.round(magnitude / 86_400_000)} d`;
  if (unit === "just now") return delta > 0 ? "in under a minute" : "just now";
  return delta > 0 ? `in ${unit}` : `${unit} ago`;
}

export function candidateStateLabel(state: TaskSourceCandidateState): string {
  switch (state) {
    case "new": return "New";
    case "changed": return "Changed";
    case "possibleDuplicate": return "Possible duplicate";
    case "added": return "Added";
    case "ignored": return "Ignored";
    case "noLongerMatches": return "No longer matches";
  }
}

/// Jira's update time is the primary order across every candidate state.
/// State controls available actions and filters, but never lifts older work
/// above a more recently updated Jira issue.
export function orderCandidates(candidates: readonly TaskSourceCandidateDto[]): TaskSourceCandidateDto[] {
  return [...candidates].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key));
}

export type CandidateFilter = "actionable" | "all";

export function filterCandidates(candidates: readonly TaskSourceCandidateDto[], filter: CandidateFilter): TaskSourceCandidateDto[] {
  return filter === "all" ? [...candidates] : candidates.filter((candidate) => candidate.state === "new" || candidate.state === "changed" || candidate.state === "possibleDuplicate");
}

export function candidateCounts(candidates: readonly TaskSourceCandidateDto[]): Record<TaskSourceCandidateState, number> {
  const counts: Record<TaskSourceCandidateState, number> = { new: 0, changed: 0, possibleDuplicate: 0, added: 0, ignored: 0, noLongerMatches: 0 };
  for (const candidate of candidates) counts[candidate.state] += 1;
  return counts;
}

/// Which intents a row offers. Import and ignore are the only writes the V1
/// review policy allows; "no longer matches" stays read-only because the
/// daemon may drop it on the next refresh.
export function candidateActions(candidate: TaskSourceCandidateDto): { import: boolean; ignore: boolean; unignore: boolean; openTask: boolean } {
  return {
    import: candidate.state === "new",
    ignore: candidate.state === "new",
    unignore: candidate.state === "ignored",
    openTask: candidate.taskId !== null,
  };
}

/// Connecting a source is three daemon commands. Each may fail on its own, so
/// the outcome names how far it got: the source then exists in the list with
/// the state it actually has, and the form offers the exact remaining step
/// instead of asking for everything again.
export type TaskSourceSetupStage = "create" | "credentials" | "refresh";

export type TaskSourceSetupOutcome =
  | { ok: true; source: TaskSourceDto; credentialState: TaskSourceCredentialState; refresh: TaskSourceRefreshResult }
  | { ok: false; stage: "create"; message: string }
  | { ok: false; stage: "credentials" | "refresh"; source: TaskSourceDto; message: string };

export async function runTaskSourceSetup(
  steps: {
    create(): Promise<TaskSourceMutationResult>;
    setCredentials(source: TaskSourceDto): Promise<TaskSourceCredentialsSetResult>;
    refresh(source: TaskSourceDto): Promise<TaskSourceRefreshResult>;
  },
  describeError: (error: unknown) => string,
): Promise<TaskSourceSetupOutcome> {
  let source: TaskSourceDto;
  try {
    source = (await steps.create()).source;
  } catch (error) {
    return { ok: false, stage: "create", message: describeError(error) };
  }
  let credentialState: TaskSourceCredentialState;
  try {
    credentialState = (await steps.setCredentials(source)).credentialState;
  } catch (error) {
    return { ok: false, stage: "credentials", source, message: describeError(error) };
  }
  try {
    const refresh = await steps.refresh(source);
    if (!refresh.refreshed) {
      return {
        ok: false,
        stage: "refresh",
        source,
        message: failureReasonCopy(refresh.failureReason ?? "providerUnavailable"),
      };
    }
    return { ok: true, source, credentialState, refresh };
  } catch (error) {
    return { ok: false, stage: "refresh", source, message: describeError(error) };
  }
}

export function setupFailureCopy(outcome: Extract<TaskSourceSetupOutcome, { ok: false }>): string {
  switch (outcome.stage) {
    case "create": return `The source was not created: ${outcome.message}`;
    case "credentials": return `The source was created but its credentials were not stored: ${outcome.message} Add them from the source row.`;
    case "refresh": return `The source and credentials are saved, but the first refresh failed: ${outcome.message}`;
  }
}

/// Conflict-shaped daemon errors mean another client or the daemon moved the
/// source on; the fix is a reload, not a retry of the same expectation.
export function isStaleExpectationMessage(message: string): boolean {
  return /conflict|revision|generation|stale|expected/iu.test(message);
}
