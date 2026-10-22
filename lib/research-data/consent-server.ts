import { requireStudioUser, type StudioContext } from '../studio/auth';
import { studioFetch, upstreamJson, StudioError } from '../studio/http';
import { RESEARCH_CONSENT_VERSION } from './agreement';

export async function researchAgreed(ctx: StudioContext, surface = 'web'): Promise<boolean> {
  const response = await studioFetch(`/rest/v1/research_consents?owner_id=eq.${ctx.user.id}&surface=eq.${surface}&version=eq.${RESEARCH_CONSENT_VERSION}&select=version&limit=1`, { token: ctx.accessToken });
  const rows = await upstreamJson<Array<{ version: number }>>(response);
  return Array.isArray(rows) && rows.some(r => r.version === RESEARCH_CONSENT_VERSION);
}

/** Use for study data, not login, password reset or the agreement endpoint itself. */
export async function requireStudioResearchUser(): Promise<StudioContext> {
  const ctx = await requireStudioUser();
  // Deploy code before enabling the schema-dependent collection on the shared service.
  if (process.env.RESEARCH_COLLECTION_V1_ENABLED !== '1') return ctx;
  if (!await researchAgreed(ctx)) throw new StudioError(403, 'research_agreement_required');
  return ctx;
}
