import type { StudioDocument, StudioSource, StudioWorkspace, StudioProjectSummary } from "./types";
import type { StudioContext } from "./auth";
import { isUuid, StudioError, studioFetch, upstreamJson } from "./http";
import { validStoredSource } from "./resources";

function assertId(id: string): void {
  if (!isUuid(id)) throw new StudioError(404, "not_found");
}

function assertSources(ctx: StudioContext, id: string, sources: StudioSource[]): void {
  if (!Array.isArray(sources) || sources.length > 100) throw new StudioError(400, "invalid_sources");
  const prefix = `${ctx.user.id}/${id}/`;
  const seen = new Set<string>();
  for (const source of sources) {
    if (!isUuid(source.id) || seen.has(source.id) || typeof source.name !== "string" ||
        !validStoredSource(source, ctx.user.id, id) || !source.path.startsWith(prefix)) {
      throw new StudioError(400, "invalid_sources");
    }
    seen.add(source.id);
  }
}

function assertDocument(ctx: StudioContext, id: string, document: StudioDocument): void {
  if (!document || typeof document !== "object" || typeof document.title !== "string" || document.title.trim().length < 1 || document.title.length > 160) {
    throw new StudioError(400, "invalid_document");
  }
  assertSources(ctx, id, document.sources);
}

export async function listWorkspaces(ctx: StudioContext): Promise<StudioProjectSummary[]> {
  const response = await studioFetch(`/rest/v1/studio_workspaces?owner_id=eq.${ctx.user.id}&select=id,title,revision,project:document->project,created_at,updated_at&order=updated_at.desc&limit=100`, { token: ctx.accessToken });
  const rows = await upstreamJson<StudioProjectSummary[]>(response);
  if (!Array.isArray(rows)) throw new StudioError(502, "invalid_service_response");
  return rows;
}

export async function getWorkspace(ctx: StudioContext, id: string): Promise<StudioWorkspace | null> {
  assertId(id);
  const response = await studioFetch(`/rest/v1/studio_workspaces?id=eq.${id}&owner_id=eq.${ctx.user.id}&select=id,title,revision,document,created_at,updated_at&limit=1`, { token: ctx.accessToken });
  const rows = await upstreamJson<StudioWorkspace[]>(response);
  if (!Array.isArray(rows)) throw new StudioError(502, "invalid_service_response");
  return rows[0] || null;
}

/** Frequent telemetry requests only need ownership and revision, not the complete study. */
export async function getWorkspaceMetadata(ctx: StudioContext, id: string): Promise<Pick<StudioWorkspace, 'id' | 'revision'> | null> {
  assertId(id);
  const response = await studioFetch(`/rest/v1/studio_workspaces?id=eq.${id}&owner_id=eq.${ctx.user.id}&select=id,revision&limit=1`, { token: ctx.accessToken });
  const rows = await upstreamJson<Pick<StudioWorkspace, 'id' | 'revision'>[]>(response);
  if (!Array.isArray(rows)) throw new StudioError(502, 'invalid_service_response');
  return rows[0] || null;
}

export async function createWorkspace(ctx: StudioContext, document: StudioDocument, id = crypto.randomUUID()): Promise<StudioWorkspace> {
  assertId(id);
  assertDocument(ctx, id, document);
  const response = await studioFetch("/rest/v1/studio_workspaces?select=id,title,revision,document,created_at,updated_at", {
    method: "POST", token: ctx.accessToken,
    headers: { Prefer: "return=representation" },
    body: { id, owner_id: ctx.user.id, title: document.title.trim(), document },
  });
  const rows = await upstreamJson<StudioWorkspace[]>(response);
  if (!Array.isArray(rows) || !rows[0]) throw new StudioError(502, "invalid_service_response");
  return rows[0];
}

export async function saveWorkspace(ctx: StudioContext, id: string, document: StudioDocument, expectedRevision: number): Promise<StudioWorkspace | { conflict: true; latest: StudioWorkspace | null }> {
  assertId(id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new StudioError(400, "invalid_revision");
  assertDocument(ctx, id, document);
  const response = await studioFetch("/rest/v1/rpc/studio_cas_workspace", {
    method: "POST", token: ctx.accessToken,
    body: { p_id: id, p_expected_revision: expectedRevision, p_document: document },
  });
  const rows = await upstreamJson<StudioWorkspace[]>(response);
  if (!Array.isArray(rows)) throw new StudioError(502, "invalid_service_response");
  if (rows[0]) return rows[0];
  return { conflict: true, latest: await getWorkspace(ctx, id) };
}
