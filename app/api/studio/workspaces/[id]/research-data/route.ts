import { NextResponse } from 'next/server';
import { requireStudioUser } from '@/lib/studio/auth';
import { getWorkspaceMetadata } from '@/lib/studio/store';
import { isUuid, routeError, studioFetch, StudioError, upstreamJson } from '@/lib/studio/http';

export const runtime = 'nodejs';
type RecordRow = { revision?: number; created_at?: string; id?: string } & Record<string, unknown>;

/** Paginated research export. Ownership and RLS apply to both datasets. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireStudioUser(), { id } = await params;
    const workspace = await getWorkspaceMetadata(ctx, id);
    if (!workspace) throw new StudioError(404, 'not_found');
    const url = new URL(request.url), dataset = url.searchParams.get('dataset');
    if (dataset !== 'use' && dataset !== 'knowledge') throw new StudioError(400, 'invalid_dataset');
    // Scientific records can include complete models; keep each response bounded.
    const pageSize = dataset === 'use' ? 100 : 1;
    const after = url.searchParams.get('after');
    if (after && after.length > 512) throw new StudioError(400, 'invalid_cursor');
    const filter = new URLSearchParams({ workspace_id: `eq.${id}`, owner_id: `eq.${ctx.user.id}`, limit: String(pageSize + 1) });
    if (dataset === 'knowledge') {
      filter.set('select', 'workspace_id,revision,recorded_at,capture_kind,knowledge');
      filter.set('order', 'revision.asc');
      if (after) {
        if (!/^[1-9][0-9]{0,9}$/.test(after)) throw new StudioError(400, 'invalid_cursor');
        filter.set('revision', `gt.${after}`);
      }
    } else {
      filter.set('select', 'id,session_id,event_type,occurred_at,created_at,target,x,y,duration_ms,metadata,workspace_revision,display_revision');
      filter.set('order', 'created_at.asc,id.asc');
      if (after) {
        let cursor;
        try { cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); } catch { throw new StudioError(400, 'invalid_cursor'); }
        if (!cursor || !isUuid(cursor.id) || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))) throw new StudioError(400, 'invalid_cursor');
        // Preserve Postgres microseconds: rounding to JS milliseconds repeats rows at page boundaries.
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(cursor.at)) throw new StudioError(400, 'invalid_cursor');
        filter.set('or', `(created_at.gt.${cursor.at},and(created_at.eq.${cursor.at},id.gt.${cursor.id}))`);
      }
    }
    const table = dataset === 'use' ? 'studio_events' : 'studio_research_history';
    const rows = await upstreamJson<RecordRow[]>(await studioFetch(`/rest/v1/${table}?${filter}`, { token: ctx.accessToken }));
    if (!Array.isArray(rows)) throw new StudioError(502, 'invalid_service_response');
    const records = rows.slice(0, pageSize), last = records.at(-1);
    const nextCursor = rows.length > pageSize && last ? dataset === 'knowledge' ? String(last.revision) : Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url') : null;
    return NextResponse.json({ dataset, workspaceId: id, records, nextCursor, mapping: dataset === 'use' ? 'display_revision is client-observed; workspace_revision is server revision at receipt. Join to the latest knowledge record at or before that revision.' : 'Each record preserves committed scientific content. Draft-only changes are omitted. Baseline records do not reconstruct earlier history.' }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return routeError(error); }
}
