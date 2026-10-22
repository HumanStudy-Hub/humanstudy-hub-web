import { NextResponse } from 'next/server';
import { bearer, verifyDesktopKey } from '@/lib/desktop-access';
export async function GET(request: Request) {
  const userId = verifyDesktopKey(bearer(request));
  return NextResponse.json(userId ? { userId } : { error: 'not_signed_in' }, { status: userId ? 200 : 401, headers: { 'Cache-Control': 'no-store' } });
}
