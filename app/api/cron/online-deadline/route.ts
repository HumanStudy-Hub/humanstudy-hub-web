import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { stopDueTryOnline } from '@/lib/try-online';
import { tryConfigured } from '@/lib/try-online-config';
export const runtime = 'nodejs';
export const maxDuration = 120;
/** The Hub's deadline stop for online workspaces. Needs a scheduler that calls it about once a minute. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get('authorization') || ''), expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!tryConfigured()) return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
  try { return NextResponse.json(await stopDueTryOnline(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'deadline_sweep_unavailable' }, { status: 502 }); }
}
