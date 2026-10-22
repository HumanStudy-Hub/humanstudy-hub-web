import { NextResponse } from 'next/server';
import { requireStudioUser } from '@/lib/studio/auth';
import { assertSameOrigin, readJsonBody, routeError, studioFetch, upstreamJson, StudioError } from '@/lib/studio/http';
import { researchAgreed } from '@/lib/research-data/consent-server';
import { RESEARCH_CONSENT_VERSION } from '@/lib/research-data/agreement';

export async function GET() {
  try {
    if (process.env.RESEARCH_COLLECTION_V1_ENABLED !== '1') return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
    const ctx = await requireStudioUser();
    return NextResponse.json({ enabled: true, userId: ctx.user.id, version: RESEARCH_CONSENT_VERSION, agreed: await researchAgreed(ctx) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return routeError(e); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (process.env.RESEARCH_COLLECTION_V1_ENABLED !== '1') throw new StudioError(503, 'research_collection_not_enabled');
    const ctx = await requireStudioUser();
    const body = await readJsonBody(request, 1024) as Record<string, unknown>;
    if (!body || body.accepted !== true || body.version !== RESEARCH_CONSENT_VERSION) throw new StudioError(400, 'invalid_consent');
    await upstreamJson(await studioFetch('/rest/v1/research_consents?on_conflict=owner_id,surface,version', {
      method: 'POST', token: ctx.accessToken, headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: { surface: 'web', version: RESEARCH_CONSENT_VERSION, usage: true, content: true, sources: true },
    }));
    return NextResponse.json({ agreed: true, version: RESEARCH_CONSENT_VERSION }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return routeError(e); }
}
