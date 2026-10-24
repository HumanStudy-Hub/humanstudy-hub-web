import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.redirect("https://humanstudy-forum.vercel.app", 307);
}
