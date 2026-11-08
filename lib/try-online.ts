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
import { createHmac, timingSafeEqual } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { mintDesktopKey } from "./desktop-access";
import { tokenSecret, tryConfigured } from "./try-online-config";

const PORT = 3000;
const HS = "/vercel/sandbox/hs";
/** Session length; Hobby allows at most 45 minutes. A stopped session resumes on the next visit. */
const SESSION_MS = Number(process.env.TRY_SESSION_MINUTES || 45) * 60_000;
const MAX_RUNNING = Number(process.env.TRY_MAX_RUNNING || 6);
const TAG = { app: "try-online" };

export const TRY_ACCESS_COOKIE = "hs_try";
export const TRY_ACCESS_DAYS = 30;

export class TryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const BUSY = () => new TryError(503, "busy", "Too many people are using HumanStudy Hub online right now. Please try again in a few minutes.");
const FAILED = () => new TryError(502, "start_failed", "HumanStudy Hub could not start. Please try again.");

const hmac = (message: string) => createHmac("sha256", tokenSecret()).update(message).digest("hex");
const sandboxName = (userId: string) => `try-${userId}`;
/** The secret that admits the browser to this user's sandbox. Stable, so a second tab does not restart it. */
const sandboxToken = (userId: string) => hmac(`try-online:v1:${userId}`);

/** Signed, per-user proof that this user entered an invitation code: `<expiry>.<mac>`. */
export function accessCookieFor(userId: string, now = Date.now()): string {
  const exp = now + TRY_ACCESS_DAYS * 86_400_000;
  return `${exp}.${hmac(`try-access:v1:${userId}:${exp}`)}`;
}
export function hasAccess(userId: string, cookie: string | undefined, now = Date.now()): boolean {
  if (!cookie || !tokenSecret()) return false;
  const [exp, mac] = cookie.split(".");
  if (!exp || !mac || !(Number(exp) > now)) return false;
  const expected = Buffer.from(hmac(`try-access:v1:${userId}:${exp}`));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** On Vercel the SDK authenticates with the project's OIDC token; elsewhere (tests) with these. */
function credentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const token = process.env.TRY_VERCEL_TOKEN, teamId = process.env.TRY_VERCEL_TEAM_ID, projectId = process.env.TRY_VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

/** A Supabase session of the sandbox's own, so the app's token refreshes never sign the website out. */
async function sessionFor(email: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; email: string } | null> {
  // A key of its own name, so enabling one-click sign-in for /try does not also switch on the other
  // service-role features (community store, research sync and its crons) in an environment.
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  const service = process.env.TRY_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service || !anon) return null;
  const link = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!verify.ok) return null;
  const s = (await verify.json()) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
  if (!s.access_token || !s.refresh_token) return null;
  const expiresAt = typeof s.expires_at === "number" ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000;
  return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt, email };
}

async function healthy(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** POST to the app with the user's token. Null: the app did not accept the token (or did not answer). */
async function app(base: string, token: string, path: string, body: unknown): Promise<Response | null> {
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

/** Refuses a new session when the plan's concurrent sandboxes are nearly used up. */
async function roomFor(name: string): Promise<boolean> {
  try {
    const all = await (await Sandbox.list({ ...credentials(), tags: TAG })).toArray();
    const running = all.filter((s) => s.status === "pending" || s.status === "running");
    return running.some((s) => s.name === name) || running.length < MAX_RUNNING;
  } catch {
    return true; // the create call reports a real limit itself
  }
}

const busyError = (error: unknown) => /quota|limit|concurren|capacity|429/i.test(error instanceof Error ? error.message : String(error));

/** Starts (or reuses) the user's sandbox, signs the app in as this user, and returns the address to open. */
export async function launchTryOnline(user: { id: string; email?: string | null }): Promise<{ url: string; resumed: boolean }> {
  if (!tryConfigured()) throw new TryError(503, "not_configured", "HumanStudy Hub online is not available yet.");
  const name = sandboxName(user.id);
  const token = sandboxToken(user.id);
  if (!(await roomFor(name))) throw BUSY();
  let base: string;
  let resumed = true;
  try {
    const sandbox = await Sandbox.getOrCreate({
      ...credentials(),
      name,
      source: { type: "snapshot", snapshotId: process.env.TRY_SNAPSHOT_ID! },
      ports: [PORT],
      timeout: SESSION_MS,
      resources: { vcpus: 2 },
      persistent: true,
      keepLastSnapshots: { count: 1, expiration: 0 },
      tags: TAG,
    });
    // A stopped sandbox has no session yet, so no route: `domain()` throws until runCommand resumes it.
    let current: string | null = null;
    try { current = sandbox.domain(PORT); } catch { /* stopped */ }
    // Running and accepting this token: reuse it (a second tab must not restart the app and its agent).
    const reuse = current !== null && (await healthy(current)) && (await app(current, token, "/__seed", {})) !== null;
    if (!reuse) {
      resumed = false;
      // TRY_APP_URL/TRY_APP_SHA256: a newer web build (a desktop release's humanstudy-web-<version>.tgz) that
      // start.sh installs first, since each user's sandbox keeps the app it was created with.
      const env: Record<string, string> = { HS_WEB_TOKEN: token };
      if (process.env.TRY_APP_URL && process.env.TRY_APP_SHA256) Object.assign(env, { HS_APP_URL: process.env.TRY_APP_URL, HS_APP_SHA256: process.env.TRY_APP_SHA256 });
      const started = await sandbox.runCommand({ cmd: "bash", args: [`${HS}/app/start.sh`], env });
      if (started.exitCode !== 0) throw FAILED();
    }
    base = sandbox.domain(PORT);
  } catch (error) {
    if (error instanceof TryError) throw error;
    console.error("try-online: sandbox", error);
    throw busyError(error) ? BUSY() : FAILED();
  }
  // Sign the app in: hosted model access (the user entered an invitation code to get here) and, when this
  // server can mint one, a Supabase session of its own, only if the app has none (each is long-lived).
  const seed: Record<string, unknown> = { desktopKey: mintDesktopKey(user.id) };
  if (user.email) {
    const status = await app(base, token, "/ipc/account:status", { args: [] });
    const body = (await status?.json().catch(() => null)) as { value?: { signedIn?: boolean } } | null;
    if (!body?.value?.signedIn) {
      const session = await sessionFor(user.email).catch(() => null);
      if (session) seed.session = session;
    }
  }
  await app(base, token, "/__seed", seed);
  return { url: `${base}/?t=${token}`, resumed };
}
