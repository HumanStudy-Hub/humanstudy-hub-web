import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyPendingContent } from '@/lib/research-data/verify-content';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get('authorization') || ''), expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (process.env.RESEARCH_COLLECTION_V1_ENABLED !== '1') return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'integrity_verifier_setup_required' }, { status: 503 });
  try { return NextResponse.json(await verifyPendingContent({ url, key }), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'integrity_verification_unavailable' }, { status: 502 }); }
}
