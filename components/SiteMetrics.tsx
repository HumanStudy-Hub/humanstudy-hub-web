"use client";

import { usePathname } from "next/navigation";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/react";

export function filterAuthMetrics<T extends { url: string }>(event: T): T | null {
  try { return new URL(event.url, "https://local.invalid").pathname === "/auth/confirm" ? null : event; }
  catch { return null; }
}

export default function SiteMetrics() {
  const pathname = usePathname();
  // Email confirmation URLs can contain one-time credentials. Do not send
  // this page to website analytics or performance tracking.
  if (pathname === "/auth/confirm") return null;
  return <><SpeedInsights beforeSend={filterAuthMetrics} /><Analytics beforeSend={filterAuthMetrics} /></>;
}
