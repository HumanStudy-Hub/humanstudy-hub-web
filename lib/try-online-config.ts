// Deployment checks are available without importing the sandbox SDK.
export const TRY_SIGN_IN = "/account?returnTo=%2Ftry";

export function tokenSecret(): string {
  const s = process.env.TRY_TOKEN_SECRET || "";
  return s.length >= 32 ? s : "";
}

export function tryServiceKey() {
  return process.env.TRY_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

export function trySettings() {
  const sessionMinutes = Number(process.env.TRY_SESSION_MINUTES || 45);
  const maxRunning = Number(process.env.TRY_MAX_RUNNING || 6);
  const snapshotId = process.env.TRY_SNAPSHOT_ID || "";
  const appUrl = process.env.TRY_APP_URL || "";
  const appSha = process.env.TRY_APP_SHA256 || "";
  const build = { version: process.env.TRY_APP_VERSION || "", gitsha: process.env.TRY_APP_GIT_SHA || "", packhash: process.env.TRY_APP_PACK_SHA256 || "" };
  if (!/^snap_[\w-]+$/.test(snapshotId) || !tokenSecret() || !tryServiceKey() || !process.env.PROMO_CODE
    || !process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY
    || !Number.isSafeInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 1440
    || !Number.isSafeInteger(maxRunning) || maxRunning < 1
    || !build.version || !/^[a-f0-9]{40}$/.test(build.gitsha) || !/^[a-f0-9]{64}$/.test(build.packhash)
    || Boolean(appUrl) !== Boolean(appSha) || (appSha && !/^[a-f0-9]{64}$/i.test(appSha))) return null;
  try {
    const url = new URL(process.env.SUPABASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (appUrl) {
      const artifact = new URL(appUrl);
      if (artifact.protocol !== "https:" || artifact.username || artifact.password) return null;
    }
    return { sessionMinutes, maxRunning, snapshotId, appUrl, appSha, build, supabaseOrigin: url.origin };
  } catch {
    return null;
  }
}

export function tryConfigured(): boolean {
  return trySettings() !== null;
}

/** Whether the public download page advertises a configured online workspace. */
export function tryListed(): boolean {
  return tryConfigured() && process.env.TRY_LISTED === "1";
}
