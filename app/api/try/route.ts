import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { grantHostedInvitation } from "@/lib/hosted-model-quota";
import { promoMatches } from "@/lib/desktop-access";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, isUuid, readJsonBody, routeError } from "@/lib/studio/http";
import { accessCookieFor, hasAccess, launchTryOnline, stopTryOnline, tryWorkspaceStatus, TRY_ACCESS_COOKIE, TRY_ACCESS_DAYS, TryError } from "@/lib/try-online";
import { tryConfigured } from "@/lib/try-online-config";

export const runtime = "nodejs";
export const maxDuration = 120;
const headers = { "Cache-Control": "no-store" };

function reply(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers });
}

function unavailable() {
  return reply({ error: "not_configured", message: "Online workspaces are unavailable on this deployment." }, 503);
}

function errorResponse(error: unknown) {
  if (error instanceof TryError) return reply({ error: error.code, message: error.message }, error.status);
  return routeError(error);
}

export async function GET() {
  if (!tryConfigured()) return unavailable();
  try {
    const { user } = await requireStudioUser();
    return reply({ status: await tryWorkspaceStatus(user.id) });
  } catch (error) { return errorResponse(error); }
}

/** Starts a workspace only after an explicit signed-in, invited request. */
export async function POST(request: Request) {
  if (!tryConfigured()) return unavailable();
  try {
    assertSameOrigin(request);
    const { user } = await requireStudioUser();
    const jar = await cookies();
    const body = (await readJsonBody(request, 4000)) as { code?: unknown; attempt?: unknown } | null;
    if (body?.attempt !== undefined && !isUuid(body.attempt)) return reply({ error: "invalid_attempt" }, 400);
    const alreadyInvited = hasAccess(user.id, jar.get(TRY_ACCESS_COOKIE)?.value);
    if (!alreadyInvited && !promoMatches(body?.code)) {
      return reply({ error: body?.code ? "invalid_code" : "code_required", message: body?.code ? "That code is not valid." : "Enter your invitation code." }, 403);
    }
    if (!(await grantHostedInvitation(user.id))) return reply({ error: "hosted_allowance_unavailable", message: "Hosted access could not be activated. Please try again later." }, 503);
    if (!alreadyInvited) {
      jar.set(TRY_ACCESS_COOKIE, accessCookieFor(user.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TRY_ACCESS_DAYS * 86_400 });
    }
    return reply(await launchTryOnline(user, body?.attempt as string | undefined));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  if (!tryConfigured()) return unavailable();
  try {
    assertSameOrigin(request);
    const { user } = await requireStudioUser();
    // Vercel can expose an empty stream for legacy clients that send a bodyless DELETE.
    const hasBody = request.headers.has("content-type") || Number(request.headers.get("content-length")) > 0;
    const body = hasBody ? (await readJsonBody(request, 4000)) as { attempt?: unknown } | null : null;
    if (body?.attempt !== undefined && !isUuid(body.attempt)) return reply({ error: "invalid_attempt" }, 400);
    const result = await stopTryOnline(user.id, body?.attempt as string | undefined);
    return reply(result, result.pending ? 202 : 200);
  } catch (error) { return errorResponse(error); }
}
