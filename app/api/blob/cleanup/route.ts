import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 60;

// Blob is staging, not storage. The runner commits the paper into the job branch
// within seconds of starting, and the contribution route reads its zip during the
// request, so nothing here is needed for long. The window only has to outlive the
// signed links handed out at job creation, which last a day.
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// Vercel Cron sends the project's CRON_SECRET. Without one configured this route
// would let anyone empty the store, so refuse instead.
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  const deleted: string[] = [];
  let kept = 0;
  let cursor: string | undefined;
  try {
    do {
      const page = await list({ cursor, limit: 1000 });
      const stale = page.blobs.filter((blob) => blob.uploadedAt.getTime() < cutoff);
      kept += page.blobs.length - stale.length;
      if (stale.length > 0) {
        await del(stale.map((blob) => blob.pathname));
        deleted.push(...stale.map((blob) => blob.pathname));
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cleanup failed.", deleted: deleted.length },
      { status: 500 },
    );
  }
  return NextResponse.json({ deleted: deleted.length, kept, cutoff: new Date(cutoff).toISOString() });
}
