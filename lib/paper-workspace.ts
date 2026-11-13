export type PaperWorkspace = { paper: string; revision: string; intent: "read" | "run" };

/** A catalog identity only: never a download URL, path, prompt or executable command. */
export function paperWorkspace(input: { paper?: unknown; revision?: unknown; intent?: unknown }): PaperWorkspace | null {
  if (typeof input.paper !== "string" || !/^paper_[a-f0-9]{24}$/.test(input.paper)
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)
    || (input.intent !== undefined && input.intent !== "read" && input.intent !== "run")) return null;
  return { paper: input.paper, revision: input.revision, intent: input.intent === "run" ? "run" : "read" };
}

export function paperWorkspacePath(target: PaperWorkspace): string {
  return `/try?${new URLSearchParams(target)}`;
}

export function paperWorkspaceSignIn(target?: PaperWorkspace | null): string {
  return `/account?returnTo=${encodeURIComponent(target ? paperWorkspacePath(target) : "/try")}`;
}

export function workspacePaperUrl(url: string, target?: PaperWorkspace | null): string {
  if (!target) return url;
  const next = new URL(url);
  for (const [key, value] of Object.entries(target)) next.searchParams.set(key, value);
  return next.href;
}
