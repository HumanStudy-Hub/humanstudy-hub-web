// "Try online": HumanStudy Hub desktop, the same app, running for one signed-in user in their own Vercel
// Sandbox. The sandbox runs the desktop main process (humanstudy-desktop app/web), the agent kernel and
// the research runtime; the browser talks to it directly at its *.vercel.run address.
//
// One persistent sandbox per user, named after the user id: Vercel saves its filesystem when it stops
// and restores it on the next visit, so projects, conversations and the sign-in carry over. The base
// image is a snapshot made with app/web/image/setup.sh (TRY_SNAPSHOT_ID).
import { createHmac } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { mintDesktopKey } from "./desktop-access";

const PORT = 3000;
const HS = "/vercel/sandbox/hs";
/** Session length (Hobby allows at most 45 minutes). Reopening /try extends a running session. */
const SESSION_MS = Number(process.env.TRY_SESSION_MINUTES || 45) * 60_000;

export class TryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function tryConfigured(): boolean {
  return Boolean(process.env.TRY_SNAPSHOT_ID && tokenSecret());
}

function tokenSecret(): string {
  return process.env.TRY_TOKEN_SECRET || process.env.ACCESS_COOKIE_SECRET || process.env.PROMO_CODE || "";
}

const sandboxName = (userId: string) => `try-${userId}`;
/** The secret that admits the browser to this user's sandbox. Stable, so a second tab does not restart it. */
const sandboxToken = (userId: string) => createHmac("sha256", tokenSecret()).update(`try-online:v1:${userId}`).digest("hex");

/** A Supabase session of the sandbox's own, so the app's token refreshes never sign the website out. */
async function sessionFor(email: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; email: string } | null> {
  const url = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !service || !anon) return null;
  const link = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
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
    signal: AbortSignal.timeout(15_000),
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

/** On Vercel the SDK authenticates with the project's OIDC token; elsewhere (tests) with these. */
function credentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const token = process.env.TRY_VERCEL_TOKEN, teamId = process.env.TRY_VERCEL_TEAM_ID, projectId = process.env.TRY_VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

async function openSandbox(userId: string): Promise<Sandbox> {
  const snapshotId = process.env.TRY_SNAPSHOT_ID!;
  return Sandbox.getOrCreate({
    ...credentials(),
    name: sandboxName(userId),
    source: { type: "snapshot", snapshotId },
    ports: [PORT],
    timeout: SESSION_MS,
    resources: { vcpus: 2 },
    persistent: true,
    keepLastSnapshots: { count: 1, expiration: 0 },
    tags: { app: "try-online" },
  });
}

/**
 * Starts (or reuses) the user's sandbox, signs the app in as this user, and returns the address the
 * browser opens. `hostedAccess`: the user may use the hosted models (same rule as /api/desktop/key).
 */
export async function launchTryOnline(user: { id: string; email?: string | null }, hostedAccess: boolean): Promise<{ url: string; resumed: boolean }> {
  if (!tryConfigured()) throw new TryError(503, "not_configured", "Trying HumanStudy Hub online is not available yet.");
  const token = sandboxToken(user.id);
  let sandbox: Sandbox;
  try {
    sandbox = await openSandbox(user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|limit|concurren/i.test(message)) throw new TryError(503, "busy", "Too many people are trying HumanStudy Hub right now. Please try again in a few minutes.");
    throw new TryError(502, "sandbox_failed", "HumanStudy Hub could not start. Please try again.");
  }
  let base = sandbox.domain(PORT);
  let resumed = true;
  if (await healthy(base)) {
    await sandbox.extendTimeout(SESSION_MS).catch(() => undefined); // capped by the plan
  } else {
    resumed = false;
    // Resumes a stopped sandbox on the way; start.sh returns once the server answers.
    const started = await sandbox.runCommand({ cmd: "bash", args: [`${HS}/app/start.sh`], env: { HS_WEB_TOKEN: token } });
    if (started.exitCode !== 0) throw new TryError(502, "start_failed", "HumanStudy Hub could not start. Please try again.");
    base = sandbox.domain(PORT);
  }
  const seed: Record<string, unknown> = {};
  if (user.email) {
    const session = await sessionFor(user.email).catch(() => null);
    if (session) seed.session = session;
  }
  if (hostedAccess) seed.desktopKey = mintDesktopKey(user.id);
  if (Object.keys(seed).length) {
    await fetch(`${base}/__seed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(seed),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
  return { url: `${base}/?t=${token}`, resumed };
}
