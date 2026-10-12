// Supabase access for community publishing. Writes use the service role (RLS has no write
// policies on these tables), so this module is server-only and never takes a user token.

export type ContributionStatus = "queued" | "pr_open" | "checks_failed" | "changes_requested" | "merged" | "rejected";
export type ContributionRow = {
  id: string;
  owner_id: string;
  paper_key: string;
  folder: string;
  slug: string;
  status: ContributionStatus;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type GithubIdentity = { owner_id: string; login: string; token_encrypted: string; scopes: string; connected_at: string };

export function storeConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function rest<T>(path: string, init: RequestInit = {}, prefer?: string): Promise<T> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    cache: "no-store",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status}).`);
  const text = await response.text();
  return (text ? JSON.parse(text) : []) as T;
}

const eq = (v: string | number) => `eq.${encodeURIComponent(String(v))}`;

export async function countRecentContributions(ownerId: string, sinceIso: string): Promise<number> {
  const rows = await rest<{ id: string }[]>(`contributions?select=id&owner_id=${eq(ownerId)}&created_at=gte.${encodeURIComponent(sinceIso)}`);
  return rows.length;
}

export async function insertContribution(row: Omit<ContributionRow, "created_at" | "updated_at">): Promise<void> {
  await rest("contributions", { method: "POST", body: JSON.stringify(row) }, "return=minimal");
}

export async function listMine(ownerId: string): Promise<ContributionRow[]> {
  return rest<ContributionRow[]>(`contributions?select=*&owner_id=${eq(ownerId)}&order=created_at.desc&limit=100`);
}

export async function listOpenForPaper(paperKey: string): Promise<ContributionRow[]> {
  return rest<ContributionRow[]>(`contributions?select=*&paper_key=${eq(paperKey)}&status=in.(queued,pr_open,checks_failed,changes_requested)&order=created_at.desc&limit=50`);
}

export async function updateStatus(match: { prNumber?: number; branch?: string }, patch: { status: ContributionStatus; error?: string | null }): Promise<number> {
  const filters: string[] = [];
  if (match.prNumber !== undefined) filters.push(`pr_number=${eq(match.prNumber)}`);
  else if (match.branch) filters.push(`branch=${eq(match.branch)}`);
  else return 0;
  // A merged or rejected contribution is final; later events (a late failed check) must not undo it.
  filters.push("status=not.in.(merged,rejected)");
  const rows = await rest<{ id: string }[]>(
    `contributions?${filters.join("&")}`,
    { method: "PATCH", body: JSON.stringify({ status: patch.status, error: patch.error ?? null, updated_at: new Date().toISOString() }) },
    "return=representation",
  );
  return rows.length;
}

export async function getIdentity(ownerId: string): Promise<GithubIdentity | null> {
  const rows = await rest<GithubIdentity[]>(`github_identities?select=*&owner_id=${eq(ownerId)}`);
  return rows[0] ?? null;
}

export async function saveIdentity(identity: Omit<GithubIdentity, "connected_at">): Promise<void> {
  await rest("github_identities?on_conflict=owner_id", { method: "POST", body: JSON.stringify({ ...identity, connected_at: new Date().toISOString() }) }, "resolution=merge-duplicates,return=minimal");
}

export async function deleteIdentity(ownerId: string): Promise<void> {
  await rest(`github_identities?owner_id=${eq(ownerId)}`, { method: "DELETE" }, "return=minimal");
}
