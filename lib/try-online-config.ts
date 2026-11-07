// Whether "Try online" is set up; a separate module so pages can ask without loading the sandbox SDK.

/** A secret of its own (32+ characters): never a shared code, since it admits the browser to a user's sandbox. */
export function tokenSecret(): string {
  const s = process.env.TRY_TOKEN_SECRET || "";
  return s.length >= 32 ? s : "";
}

export function tryConfigured(): boolean {
  return Boolean(process.env.TRY_SNAPSHOT_ID && tokenSecret());
}

/** Whether /download offers it (TRY_LISTED=1). /try itself works once configured, for testing before that. */
export function tryListed(): boolean {
  return tryConfigured() && process.env.TRY_LISTED === "1";
}
