import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.redirect("https://forum.humanstudy-hub.com", 307);
}
