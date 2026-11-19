import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { codeEquals } from "@/lib/desktop-access";
import {
  ACCESS_SECRET,
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  PROMO_CODE,
  TOKEN_MESSAGE,
} from "@/lib/access";

function tokenFor(secret: string): string {
  return createHmac("sha256", secret || "").update(TOKEN_MESSAGE).digest("hex");
}

export async function POST(request: Request) {
  if (!PROMO_CODE) {
    return NextResponse.json(
      { ok: false, error: "not_configured" },
      { status: 503 }
    );
  }

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    code = typeof body?.code === "string" ? body.code.trim() : "";
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_request" },
      { status: 400 }
    );
  }

  if (!code) {
    return NextResponse.json(
      { ok: false, error: "bad_request" },
      { status: 400 }
    );
  }

  // Same trimmed, case-insensitive constant-time check as the invitation code.
  const match = codeEquals(code, PROMO_CODE);

  if (!match) {
    return NextResponse.json({ ok: false, error: "invalid_code" }, { status: 403 });
  }

  const token = tokenFor(ACCESS_SECRET);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return response;
}
