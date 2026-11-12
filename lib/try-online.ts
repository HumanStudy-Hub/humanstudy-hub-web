// "Try online": HumanStudy Hub desktop, the same app, running for one signed-in user in their own Vercel
// Sandbox. The sandbox runs the desktop main process (humanstudy-desktop app/web), the agent kernel and
// the research runtime; the browser talks to it directly at its *.vercel.run address.
//
// One persistent sandbox per user, named after the user id: Vercel saves its filesystem when it stops
// and restores it on the next visit, so projects, conversations and the sign-in carry over. The base
// image is a snapshot made with app/web/image/setup.sh (TRY_SNAPSHOT_ID).
//
// Who may start one: a signed-in user who has entered an invitation code (the rule of /api/desktop/key),
// remembered per user in a signed cookie. At most TRY_MAX_RUNNING sandboxes run at once.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { APIError, Sandbox } from "@vercel/sandbox";
import { mintDesktopKey } from "./desktop-access";
import { devHubOrigin, devModelAccess, devModelNetwork, isDevPreview } from "./try-dev-models";
import { tokenSecret, tryServiceKey, trySettings } from "./try-online-config";

const PORT = 3000;
const HS = "/vercel/sandbox/hs";
const TAG = { app: "try-online" };

export const TRY_ACCESS_COOKIE = "hs_try";
export const TRY_ACCESS_DAYS = 30;

export class TryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const BUSY = () => new TryError(503, "busy", "Too many people are using HumanStudy Hub online right now. Please try again in a few minutes.");
const FAILED = () => new TryError(502, "start_failed", "HumanStudy Hub could not start. Please try again.");
const ACCOUNT_MISMATCH = () => new TryError(409, "workspace_account_mismatch", "This workspace has a different account signed in. Sign out there before reopening.");

const hmac = (message: string) => createHmac("sha256", tokenSecret()).update(message).digest("hex");
const deploymentScope = () => {
  if (process.env.VERCEL_ENV === "production") return "";
  const branch = process.env.VERCEL_GIT_COMMIT_REF || "local";
  return "preview-" + createHash("sha256").update(branch).digest("hex").slice(0, 12) + "-";
};
const sandboxName = (userId: string) => `try-${deploymentScope()}${userId}`;
const sandboxToken = (userId: string) => hmac(`try-online:v1:${deploymentScope()}${userId}`);

/** Signed, per-user proof that this user entered an invitation code: `<expiry>.<mac>`. */
export function accessCookieFor(userId: string, now = Date.now()): string {
  const exp = now + TRY_ACCESS_DAYS * 86_400_000;
  return `${exp}.${hmac(`try-access:v1:${deploymentScope()}${userId}:${exp}`)}`;
}
export function hasAccess(userId: string, cookie: string | undefined, now = Date.now()): boolean {
  if (!cookie || !tokenSecret()) return false;
  const [exp, mac, extra] = cookie.split(".");
  if (!exp || !mac || extra !== undefined || !/^\d+$/.test(exp) || !(Number(exp) > now)) return false;
  const expected = Buffer.from(hmac(`try-access:v1:${deploymentScope()}${userId}:${exp}`));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** On Vercel the SDK authenticates with the project's OIDC token; elsewhere (tests) with these. */
function credentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const token = process.env.TRY_VERCEL_TOKEN, teamId = process.env.TRY_VERCEL_TEAM_ID, projectId = process.env.TRY_VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

/** A Supabase session of the sandbox's own, so the app's token refreshes never sign the website out. */
async function sessionFor(userId: string, email: string, deadline: AbortSignal): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; email: string } | null> {
  // A key of its own name, so enabling one-click sign-in for /try does not also switch on the other
  // service-role features (community store, research sync and its crons) in an environment.
  const url = trySettings()?.supabaseOrigin, anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  const service = tryServiceKey();
  if (!url || !service || !anon) return null;
  const link = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
    cache: "no-store",
    signal: operationSignal(10_000, deadline),
    redirect: "error",
  });
  if (!link.ok) return null;
  const linkJson = (await link.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const tokenHash = linkJson.properties?.hashed_token || linkJson.hashed_token;
  if (!tokenHash) return null;
  const verify = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
    cache: "no-store",
    signal: operationSignal(10_000, deadline),
    redirect: "error",
  });
  if (!verify.ok) return null;
  const s = (await verify.json()) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number; user?: { id?: string } };
  if (!s.access_token || !s.refresh_token || s.user?.id !== userId) return null;
  const expiresAt = typeof s.expires_at === "number" ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000;
  return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt, email };
}

function operationSignal(ms: number, deadline?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  return deadline ? AbortSignal.any([timeout, deadline]) : timeout;
}

async function health(base: string, deadline: AbortSignal): Promise<unknown> {
  try {
    const r = await fetch(`${base}/healthz`, { cache: "no-store", redirect: "error", signal: operationSignal(4000, deadline) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function assertCurrentBuild(payload: unknown, config: Settings) {
  const value = payload as { ready?: boolean; build?: { version?: string; gitsha?: string; packhash?: string; dirty?: boolean } } | null;
  if (!value?.ready) throw FAILED();
  if (value.build?.version !== config.build.version || value.build?.gitsha !== config.build.gitsha
    || value.build?.packhash !== config.build.packhash || value.build?.dirty !== false) {
    throw new TryError(502, "build_mismatch", "This workspace is running a different build. Stop it and resume to load the current build.");
  }
}

/** POST to the app with the user's token. Null means there was no response. */
async function app(base: string, token: string, path: string, body: unknown, deadline: AbortSignal): Promise<Response | null> {
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: operationSignal(8000, deadline),
    });
    return r;
  } catch {
    return null;
  }
}

type Settings = NonNullable<ReturnType<typeof trySettings>>;
type WorkspaceStatus = "new" | "running" | "stopped" | "transition";

function configuration(): Settings {
  const config = trySettings();
  if (!config) throw new TryError(503, "not_configured", "Online workspaces are unavailable on this deployment.");
  return config;
}

async function leaseRpc<T>(config: Settings, rpc: string, body: Record<string, unknown>): Promise<T> {
  const service = tryServiceKey();
  try {
    const response = await fetch(`${config.supabaseOrigin}/rest/v1/rpc/${rpc}`, {
      method: "POST", headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return await response.json() as T;
  } catch { /* Database admission must succeed before a provider launch. */ }
  throw new TryError(503, "admission_unavailable", "Online workspace availability could not be checked. Please try again.");
}

function claim(config: Settings, workspace_name: string, request_stop: boolean, attempt_id?: string) {
  return leaseRpc<string | null>(config, "online_claim_workspace", {
    workspace_name, request_stop, attempt_id: attempt_id ?? null, session_seconds: config.sessionMinutes * 60,
  });
}

function finish(config: Settings, workspace_name: string, claim_id: string, release_slot: boolean, expiry?: Date) {
  return leaseRpc<boolean>(config, "online_finish_workspace", {
    workspace_name, claim_id, release_slot, provider_expiry: expiry?.toISOString() ?? null,
  });
}

function running(sandbox: Sandbox) {
  return sandbox.status === "running" || sandbox.status === "pending";
}

function transitioning(sandbox: Sandbox) {
  return sandbox.status === "stopping" || sandbox.status === "snapshotting";
}

async function existing(name: string, deadline?: AbortSignal): Promise<Sandbox | null> {
  try {
    return await Sandbox.get({ ...credentials(), name, resume: false, signal: operationSignal(8000, deadline) });
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404
      && !/snapshot/i.test(JSON.stringify(error.json ?? error.message))) return null;
    throw error;
  }
}

/** Checking a workspace must not resume it. */
export async function tryWorkspaceStatus(userId: string): Promise<WorkspaceStatus> {
  configuration();
  try {
    const sandbox = await existing(sandboxName(userId));
    if (!sandbox) return "new";
    if (transitioning(sandbox) || sandbox.status === "pending") return "transition";
    return running(sandbox) ? "running" : "stopped";
  } catch {
    throw new TryError(503, "status_unavailable", "Could not check your workspace status.");
  }
}

/** A provider count also includes sessions that predate the database admission migration. */
async function roomFor(name: string, maxRunning: number, deadline: AbortSignal): Promise<boolean> {
  try {
    const all = await (await Sandbox.list({ ...credentials(), tags: TAG, signal: operationSignal(8000, deadline) })).toArray();
    const preview = name.startsWith("try-preview-");
    const active = all.filter(s => Boolean(s.name?.startsWith("try-preview-")) === preview
      && ["pending", "running", "stopping", "snapshotting"].includes(s.status));
    return active.some(s => s.name === name) || active.length < maxRunning;
  } catch {
    return false;
  }
}

function workspaceOrigin(sandbox: Sandbox) {
  const url = new URL(sandbox.domain(PORT));
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.run")
    || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw FAILED();
  return url.origin;
}

async function stopRunning(sandbox: Sandbox) {
  if (transitioning(sandbox)) throw new TryError(409, "workspace_transition", "Your workspace is already stopping. Check again in a moment.");
  if (running(sandbox)) await sandbox.stop({ signal: AbortSignal.timeout(15_000) });
}

/** Stops the current session while retaining its workspace. A stop during launch records cancellation. */
export async function stopTryOnline(userId: string, attempt?: string): Promise<{ pending: boolean; ignored?: boolean }> {
  const config = configuration(), name = sandboxName(userId);
  const lease = await claim(config, name, true, attempt);
  if (lease === "cancelling") return { pending: true };
  if (lease === "ignored") return { pending: false, ignored: true };
  if (!lease) throw BUSY();
  let release = false;
  try {
    const sandbox = await existing(name);
    if (sandbox) await stopRunning(sandbox);
    release = true;
    return { pending: false };
  } catch (error) {
    if (error instanceof TryError) throw error;
    throw new TryError(502, "stop_failed", "Could not stop the workspace. Please try again.");
  } finally {
    await finish(config, name, lease, release).catch(() => false);
  }
}

/** Inspect the already-running server without resuming or restarting its provider session. */
async function runningWithDevHub(sandbox: Sandbox, origin: string, deadline: AbortSignal): Promise<boolean> {
  const probe = `
    const fs = require("node:fs");
    const [server, origin] = process.argv.slice(1);
    let matches = 0;
    let valid = false;
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\\d+$/.test(pid)) continue;
      try {
        const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0");
        if (args[1] !== server || !/(?:^|\\/)node$/.test(args[0])) continue;
        matches++;
        const env = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\\0");
        valid = env.includes("HUMANSTUDY_SERVER=" + origin) && env.includes("NODE_USE_SYSTEM_CA=1");
      } catch { /* Processes may exit during enumeration. */ }
    }
    if (matches !== 1 || !valid) process.exitCode = 1;
  `;
  try {
    const result = await sandbox.currentSession().runCommand({
      cmd: "node", args: ["-e", probe, `${HS}/app/server.cjs`, origin],
      signal: operationSignal(5000, deadline),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Starts or reopens one private, persistent workspace. A missing prior snapshot is never replaced automatically. */
export async function launchTryOnline(user: { id: string; email?: string | null }, attempt: string = randomUUID()): Promise<{ url: string; resumed: boolean }> {
  const config = configuration();
  if (!user.email) throw new TryError(403, "email_required", "Sign in with an email address to open an online workspace.");
  const hubOrigin = devHubOrigin();
  const managedDev = devModelAccess(user.id);
  const networkPolicy = managedDev ? await devModelNetwork(hubOrigin, config.sessionMinutes) : null;
  if (managedDev && !networkPolicy) throw new TryError(503, "model_auth_unavailable", "The dev model connection is unavailable.");
  const name = sandboxName(user.id), token = sandboxToken(user.id);
  const deadline = AbortSignal.timeout(85_000);
  const lease = await claim(config, name, false, attempt);
  if (lease === "cancelled") throw new TryError(409, "workspace_cancelled", "Startup was cancelled.");
  if (!lease) throw BUSY();

  let sandbox: Sandbox | null = null;
  let started = false, cancelled = false, release = false;
  try {
    sandbox = await existing(name, deadline);
    if (sandbox && transitioning(sandbox)) throw new TryError(409, "workspace_transition", "Your workspace is saving. Try again in a moment.");
    if (!sandbox || !running(sandbox)) {
      if (!(await roomFor(name, config.maxRunning, deadline))) {
        release = true;
        throw BUSY();
      }
    }
    const resumed = Boolean(sandbox);
    if (!sandbox) {
      // Reserve conservatively if create itself fails, since the provider may have accepted it.
      started = true;
      sandbox = await Sandbox.create({
        ...credentials(), name, source: { type: "snapshot", snapshotId: config.snapshotId },
        ports: [PORT], timeout: config.sessionMinutes * 60_000, resources: { vcpus: 2 },
        persistent: true, keepLastSnapshots: { count: 1, expiration: 0 }, tags: TAG,
        ...(networkPolicy ? { networkPolicy } : {}),
        signal: operationSignal(25_000, deadline),
      });
    } else if (networkPolicy) {
      if (running(sandbox) && (sandbox.status !== "running" || !(await runningWithDevHub(sandbox, hubOrigin, deadline)))) {
        throw new TryError(409, "workspace_restart_required", "Stop this workspace and resume it to connect to dev models. Your current session is still running.");
      }
      // The provider applies policy outside the guest. This also resumes stopped workspaces.
      started = sandbox.status !== "running";
      await sandbox.updateNetworkPolicy(networkPolicy, { signal: operationSignal(25_000, deadline) });
    }
    let base = !started && sandbox.status === "running" ? workspaceOrigin(sandbox) : null;
    if (!base) {
      started = true;
      const env: Record<string, string> = { HS_WEB_TOKEN: token };
      if (networkPolicy) {
        env.HUMANSTUDY_SERVER = hubOrigin;
        env.NODE_USE_SYSTEM_CA = "1";
      }
      if (config.appUrl) Object.assign(env, { HS_APP_URL: config.appUrl, HS_APP_SHA256: config.appSha });
      const command = await sandbox.runCommand({ cmd: "bash", args: [`${HS}/app/start.sh`], env, signal: operationSignal(28_000, deadline) });
      if (command.exitCode !== 0) throw FAILED();
      base = workspaceOrigin(sandbox);
    }
    let payload = await health(base, deadline);
    if (started) {
      for (let check = 0; check < 2 && !(payload as { ready?: boolean } | null)?.ready && !deadline.aborted; check++) {
        await new Promise(resolve => setTimeout(resolve, 400));
        payload = await health(base, deadline);
      }
    }
    assertCurrentBuild(payload, config);

    if (networkPolicy) {
      const probe = await sandbox.runCommand({
        cmd: "node",
        args: ["-e", 'fetch(process.argv[1], { redirect: "error", signal: AbortSignal.timeout(8000) }).then(async r => { if (!r.ok || new URL((await r.json()).supabaseUrl).origin !== process.argv[2]) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })', `${hubOrigin}/api/desktop/config`, config.supabaseOrigin],
        env: { NODE_USE_SYSTEM_CA: "1" }, signal: operationSignal(10_000, deadline),
      });
      if (probe.exitCode !== 0) throw new TryError(502, "model_auth_failed", "The workspace could not reach the dev model service.");
    }
    const account = await app(base, token, "/ipc/account:status", { args: [] }, deadline);
    if (!account?.ok) throw FAILED();
    const state = await account.json().catch(() => null) as { value?: { signedIn?: boolean; email?: string } } | null;
    if (typeof state?.value?.signedIn !== "boolean") throw FAILED();
    if (state.value.signedIn && state.value.email?.toLowerCase() !== user.email.toLowerCase()) {
      throw ACCOUNT_MISMATCH();
    }
    // A stored email does not prove the sandbox's Supabase session still works.
    // Each explicit launcher handoff receives its own fresh, verified session.
    const session = await sessionFor(user.id, user.email, deadline).catch(() => null);
    if (!session) throw new TryError(502, "sign_in_failed", "The workspace could not refresh its sign-in. Try opening it again.");
    const seed: Record<string, unknown> = { session };
    if (!isDevPreview() || managedDev) seed.desktopKey = mintDesktopKey(user.id);
    const seeded = await app(base, token, "/__seed", seed, deadline);
    if (seeded?.status === 409) throw ACCOUNT_MISMATCH();
    if (!seeded?.ok || !(await seeded.json().catch(() => null))?.ok) throw FAILED();

    if (!(await finish(config, name, lease, false, sandbox.expiresAt))) {
      cancelled = true;
      throw new TryError(409, "workspace_cancelled", "Startup was cancelled.");
    }
    const url = new URL("/", base);
    url.searchParams.set("t", token);
    return { url: url.href, resumed };
  } catch (error) {
    if (!started && !cancelled && !release) {
      const completed = await finish(config, name, lease, false, sandbox?.expiresAt).catch(() => null);
      cancelled = completed === false;
    }
    if (started || cancelled) {
      // A timed-out create may have succeeded. Keep its reservation if we cannot confirm it stopped.
      try {
        const current = await existing(name);
        if (current) {
          await stopRunning(current);
          release = true;
        } else if (sandbox) {
          release = true;
        }
      } catch { /* Keep the lease when provider state is uncertain. */ }
    }
    await finish(config, name, lease, release).catch(() => false);
    if (cancelled && release) throw new TryError(409, "workspace_cancelled", "Startup was cancelled.");
    if (error instanceof TryError) throw error;
    if (error instanceof APIError && [409, 429].includes(error.response.status)) throw BUSY();
    throw FAILED();
  }
}
