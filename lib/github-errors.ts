// GitHub failures in the Studio start paths, described for two audiences: the
// researcher sees one plain sentence, the server log gets status, endpoint and
// GitHub's request id. Neither ever sees a token, a signed URL or a raw message.
// This module has no imports so the node tests can load it directly.

export type GitHubFailureKind = "access" | "rate_limited" | "unavailable" | "other";
export type GitHubFailure = {
  kind: GitHubFailureKind;
  // True only when GitHub itself answered with this status. A transport failure
  // (reset, timeout) may have delivered the request, so it is never retried.
  responded: boolean;
  status?: number;
  method?: string;
  endpoint?: string;
  requestId?: string;
};

const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);

type Loose = { status?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown; request?: { method?: unknown; url?: unknown }; response?: { headers?: Record<string, unknown> } };

function header(headers: Record<string, unknown> | undefined, name: string) {
  const value = headers?.[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

// Path only: no origin, no query string (a query could carry anything).
function endpointOf(url: unknown) {
  if (typeof url !== "string") return undefined;
  try { return new URL(url).pathname; } catch { return url.split("?")[0].slice(0, 200); }
}

function isNetworkError(error: Loose, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if (typeof error.code === "string" && networkCodes.has(error.code)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (typeof error.message === "string" && /fetch failed|socket hang up|network/i.test(error.message)) return true;
  return isNetworkError(error.cause as Loose, depth + 1);
}

export function describeGitHubError(error: unknown): GitHubFailure {
  const e = (error && typeof error === "object" ? error : {}) as Loose;
  const status = typeof e.status === "number" ? e.status : undefined;
  const headers = e.response?.headers;
  const detail = {
    ...(status !== undefined ? { status } : {}),
    ...(typeof e.request?.method === "string" ? { method: e.request.method } : {}),
    ...(endpointOf(e.request?.url) ? { endpoint: endpointOf(e.request?.url) } : {}),
    ...(header(headers, "x-github-request-id") ? { requestId: header(headers, "x-github-request-id") } : {}),
  };
  // Only Octokit errors carry `request`; Supabase or Blob failures in the same
  // try block must not be blamed on GitHub.
  if (!e.request) return { kind: "other", responded: false, ...detail };
  const responded = status !== undefined && Boolean(e.response?.headers) && !isNetworkError(e);
  const failure = (kind: GitHubFailureKind): GitHubFailure => ({ kind, responded, ...detail });
  if (status === 401) return failure("access");
  if (status === 429 || status === 403 && (header(headers, "x-ratelimit-remaining") === "0" || header(headers, "retry-after") !== undefined)) return failure("rate_limited");
  if (status === 403) return failure("access");
  if (status !== undefined && status >= 500) return failure("unavailable");
  if (isNetworkError(e)) return failure("unavailable");
  return failure("other");
}

const messages: Record<Exclude<GitHubFailureKind, "other">, string> = {
  access: "The website can't start builds right now because its GitHub service access needs attention from the site team. Please try again later.",
  rate_limited: "GitHub is limiting requests right now. Please try again in a few minutes.",
  unavailable: "GitHub didn't respond. Please try again in a minute.",
};

export function githubFailureMessage(error: unknown): string | undefined {
  const kind = describeGitHubError(error).kind;
  return kind === "other" ? undefined : messages[kind];
}

// What reaches the server log. Never the raw message of a GitHub error (Octokit
// echoes request details into it); for anything else, a trimmed message with URLs
// removed, since a Blob error can quote a signed link.
export function logGitHubFailure(context: string, error: unknown, log: (...args: unknown[]) => void = console.error) {
  const failure = describeGitHubError(error);
  const e = (error && typeof error === "object" ? error : {}) as Loose;
  const fields: Record<string, unknown> = { ...failure };
  if (failure.kind === "other" && failure.status === undefined) {
    if (typeof e.name === "string") fields.name = e.name;
    if (typeof e.code === "string") fields.code = e.code;
    if (typeof e.message === "string") fields.message = e.message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
  }
  log(`[studio] ${context} failed`, fields);
  if (failure.kind === "access") log(`[studio] GitHub rejected the server credentials (${failure.status}) on ${failure.endpoint || "a request"}. Renew GITHUB_TOKEN / GITHUB_JOBS_TOKEN in Vercel.`);
  return failure;
}

// Fine-grained tokens report their expiry on every response. Parsing the header
// gives a log warning days before builds start failing with 401.
export function tokenExpiry(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}) ?(UTC|Z|[+-]\d{2}:?\d{2})$/.exec(value.trim());
  const iso = match ? `${match[1]}T${match[2]}${match[3] === "UTC" || match[3] === "Z" ? "Z" : match[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}` : value;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}
export function tokenExpiryWarning(label: string, value: unknown, now = Date.now(), warnWithinMs = 14 * 86_400_000): string | null {
  const expires = tokenExpiry(value);
  if (expires === null || expires - now > warnWithinMs) return null;
  const days = Math.max(0, Math.floor((expires - now) / 86_400_000));
  return expires <= now
    ? `[github] ${label} has expired. Studio builds and playground runs will fail until it is renewed in Vercel.`
    : `[github] ${label} expires in ${days} day${days === 1 ? "" : "s"} (${new Date(expires).toISOString()}). Renew it in Vercel before builds start failing.`;
}

// createWorkflowDispatch returns 204 whether or not a run was queued, and a 5xx
// does not prove that no run was queued either. So a 5xx that GitHub answered is
// retried exactly once, and only after `alreadyQueued` has answered "no run" on
// every check across a ~16 s window. Any doubt (a run appeared, a check failed, a
// transport error that may have delivered the request) means no second dispatch:
// two runs for one job would cancel each other through the workflow's
// concurrency group and the cancelled one marks the job failed.
//
// Residual risk: the runs list can lag. If GitHub queued a run despite the 5xx
// and the list has not shown it after 16 s, the retry duplicates it. Giving the
// Bench workflow a run-name containing the job id would let runMayBelongTo match
// exactly and allow a longer, safe wait.
export type DispatchOutcome = "dispatched" | "already_queued" | "retried";
export async function dispatchWithConfirmedRetry(options: {
  dispatch: () => Promise<void>;
  alreadyQueued: () => Promise<boolean>;
  checkDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (...args: unknown[]) => void;
  context?: string;
}): Promise<DispatchOutcome> {
  const { dispatch, alreadyQueued, checkDelaysMs = [4000, 4000, 4000, 4000], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.error, context = "workflow dispatch" } = options;
  try {
    await dispatch();
    return "dispatched";
  } catch (first) {
    // Only a 5xx that GitHub actually answered is a retry candidate; everything
    // else (4xx, transport errors that may have delivered the request) goes
    // straight to the caller, which logs it.
    const failure = describeGitHubError(first);
    if (failure.kind !== "unavailable" || !failure.responded) throw first;
    logGitHubFailure(context, first, log);
    for (const delay of checkDelaysMs) {
      await sleep(delay);
      let queued: boolean;
      try { queued = await alreadyQueued(); }
      catch (checkError) {
        logGitHubFailure(`${context} confirmation`, checkError, log);
        throw first;
      }
      if (queued) {
        log(`[studio] ${context}: a run was queued despite the error; not dispatching again.`);
        return "already_queued";
      }
    }
    log(`[studio] ${context}: no run was queued; retrying once.`);
    await dispatch();
    return "retried";
  }
}

// A run counts as possibly this job's unless its title names a different job.
// The workflow has no run-name today, so every title is the workflow name and any
// new run blocks the retry, which is the safe direction.
export function runMayBelongTo(jobId: string, run: { display_title?: string | null; created_at: string }, after: number) {
  if (Date.parse(run.created_at) < after) return false;
  const title = run.display_title || "";
  const named = title.match(/studio-[0-9a-f-]{20,}/i);
  return !named || named[0] === jobId || title.includes(jobId);
}
