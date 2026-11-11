"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { HelpfulState } from "@/lib/community-credit";

async function voteRequest(id: string, revision: string, helpful?: boolean) {
  const response = await fetch(`/api/community/credits/${id}/helpful`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, helpful }),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Helpful votes are temporarily unavailable.");
  return await response.json() as HelpfulState;
}

export default function HelpfulVote({ id, revision, count }: { id: string; revision: string; count: number }) {
  const [state, setState] = useState<HelpfulState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void voteRequest(id, revision).then(result => {
      if (active) setState(result);
    }).catch(() => {
      if (active) setError("Helpful votes are temporarily unavailable.");
    }).finally(() => {
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, [id, revision]);

  async function toggle() {
    if (!state?.canVote || busy) return;
    setBusy(true);
    setError("");
    try {
      setState(await voteRequest(id, revision, !state.voted));
    } catch {
      setError("The vote could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-x-3 text-sm">
    <span aria-live="polite">{state?.helpful ?? count} helpful</span>
    {state?.canVote && <button type="button" aria-pressed={state.voted} disabled={busy} onClick={toggle}
      className="min-h-11 cursor-pointer text-[var(--site-accent)] underline">
      {state.voted ? "Remove helpful vote" : "Helpful"}
    </button>}
    {loaded && !state && !error && <Link href="/account" className="text-[var(--site-accent)] underline">Sign in to vote</Link>}
    {error && <span role="status" className="text-[var(--site-muted)]">{error}</span>}
  </div>;
}
