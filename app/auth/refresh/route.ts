import { NextResponse } from 'next/server';
import { clearStudioSession, migrateStudioSession, requireStudioUser } from '@/lib/studio/auth';
import { accountPath, accountReturnTo } from '@/lib/studio/auth-policy';
import { routeError, StudioError } from '@/lib/studio/http';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = accountReturnTo(url.searchParams.get('returnTo'));
  if (!returnTo) return NextResponse.json({ error: 'invalid_return_to' }, { status: 400 });
  try {
    await requireStudioUser();
    await migrateStudioSession();
    return NextResponse.redirect(returnTo, { status: 307, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof StudioError && error.status === 401) {
      await clearStudioSession();
      return NextResponse.redirect(new URL(accountPath(returnTo), url), { status: 307, headers: { 'Cache-Control': 'no-store' } });
    }
    if (error instanceof StudioError && error.status >= 500) return NextResponse.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return routeError(error);
  }
}
