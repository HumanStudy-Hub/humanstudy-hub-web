import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError, studioFetch, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import type { StudioEvent } from "@/lib/studio/types";

type Context = { params: Promise<{ id: string }> };
const eventTypes = new Set(["click", "pointer", "scroll", "selection", "visibility", "chat", "review", "layout"]);
const metadataKeys = new Set(["action", "area", "mode", "status", "sourceId", "conversationId", "entityId", "reviewId", "page", "count", "selectionLength", "button", "direction"]);

function validateEvent(input: unknown, workspaceId: string, ownerId: string, workspaceRevision: number): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StudioError(400, "invalid_event");
  const event = input as Partial<StudioEvent>;
  if (!isUuid(event.id) || typeof event.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(event.sessionId) ||
      !eventTypes.has(event.type || "") || typeof event.at !== "string") throw new StudioError(400, "invalid_event");
  if(event.displayRevision !== undefined && (!Number.isSafeInteger(event.displayRevision) || event.displayRevision < 1 || event.displayRevision > workspaceRevision)) throw new StudioError(400,"invalid_event");
  const at = Date.parse(event.at);
  if (!Number.isFinite(at) || at < Date.now() - 30 * 86400_000 || at > Date.now() + 300_000) throw new StudioError(400, "invalid_event");
  if (event.target !== undefined && (typeof event.target !== "string" || !/^[a-zA-Z0-9_.:/#\[\]-]{1,160}$/.test(event.target))) {
    throw new StudioError(400, "invalid_event");
  }
  for (const coordinate of [event.x, event.y]) {
    if (coordinate !== undefined && (typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < -100_000 || coordinate > 100_000)) {
      throw new StudioError(400, "invalid_event");
    }
  }
  if (event.durationMs !== undefined && (!Number.isInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 86_400_000)) {
    throw new StudioError(400, "invalid_event");
  }
  const metadata = event.metadata || {};
  if (typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).length > 16) throw new StudioError(400, "invalid_event");
  for (const [key, value] of Object.entries(metadata)) {
    if (!metadataKeys.has(key) || !(typeof value === "boolean" ||
      (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000) ||
      (typeof value === "string" && /^[a-zA-Z0-9_.:/#-]{1,80}$/.test(value)))) {
      throw new StudioError(400, "invalid_event");
    }
  }
  return {
    id: event.id, workspace_id: workspaceId, owner_id: ownerId, workspace_revision: workspaceRevision,
    ...(event.displayRevision === undefined ? {} : { display_revision:event.displayRevision }),
    session_id: event.sessionId, event_type: event.type, occurred_at: new Date(at).toISOString(),
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(event.x === undefined ? {} : { x: event.x }),
    ...(event.y === undefined ? {} : { y: event.y }),
    ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }),
    metadata,
  };
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const { id } = await context.params;
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    const body = await readJsonBody(request, 128_000);
    if (!body || typeof body !== "object" || !Array.isArray((body as { events?: unknown }).events)) throw new StudioError(400, "invalid_events");
    const events = (body as { events: unknown[] }).events;
    if (events.length < 1 || events.length > 100) throw new StudioError(400, "invalid_events");
    const rows = events.map(event => validateEvent(event, id, ctx.user.id, workspace.revision));
    const response = await studioFetch("/rest/v1/studio_events?on_conflict=id", {
      method: "POST", token: ctx.accessToken,
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: rows,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new StudioError(401, "unauthorized");
      throw new StudioError(response.status >= 500 ? 502 : 400, response.status >= 500 ? "service_unavailable" : "invalid_events");
    }
    return NextResponse.json({ accepted: rows.length });
  } catch (error) { return routeError(error); }
}
