"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type Submission = { id: string; paperKey: string; status: string; prUrl: string | null; createdAt: string };
type Receipt = { status: string; contributorId: string | null };
const labels: Record<string, string> = {
  queued: "Queued for submission", pr_open: "Review pending", checks_failed: "Checks need attention",
  changes_requested: "Changes requested", merged: "Merged · public credit pending verification", rejected: "Closed",
};

export default function MyContributions({ previewRows }: { previewRows?: Submission[] } = {}) {
  const preview = previewRows !== undefined;
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [rows, setRows] = useState<Submission[]>(previewRows?.slice(0, 25) ?? []);
  const [hasMore, setHasMore] = useState((previewRows?.length ?? 0) > 25);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void fetch(`/api/community/mine?page=${page}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "Your contributions could not be loaded.");
        setRows(body.contributions);
        setHasMore(body.hasMore === true);
      }).catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Your contributions could not be loaded.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, retry, preview]);

  function load(nextPage: number) {
    if (previewRows) {
      setRows(previewRows.slice((nextPage - 1) * 25, nextPage * 25));
      setHasMore(previewRows.length > nextPage * 25);
      setPage(nextPage);
      return;
    }
    setLoading(true);
    setError("");
    setPage(nextPage);
    setRetry(value => value + 1);
  }
  async function recheck(id: string) {
    if (busy) return;
    if (preview) {
      setReceipts(value => ({ ...value, [id]: { status: "merged", contributorId: "example" } }));
      return;
    }
    setBusy(id);
    setError("");
    try {
      const response = await fetch("/api/community/mine", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Contribution status is temporarily unavailable.");
      setReceipts(value => ({ ...value, [id]: body }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Contribution status is temporarily unavailable.");
    } finally { setBusy(null); }
  }

  return <section aria-labelledby="my-contributions" className="mt-10 border-t border-[var(--site-line)] pt-6 text-sm">
    <h2 id="my-contributions" className="text-lg font-semibold">My contributions</h2>
    {error && <p role="alert" className="mt-3">{error} <button type="button" onClick={() => load(page)} className="underline">Retry</button></p>}
    {loading ? <p role="status" className="mt-3">Loading contributions…</p> : !error && rows.length === 0 ? <p className="mt-3">No submissions on this page.</p> : null}
    {!loading && <ul className="divide-y divide-[var(--site-line)]">
      {rows.map(row => {
        const receipt = receipts[row.id];
        return <li key={row.id} className="space-y-2 py-4">
          <p className="break-words">{row.paperKey.replace(/^(?:doi:|title:)/, "")}</p>
          <p className="text-[var(--site-muted)]"><time dateTime={row.createdAt}>{row.createdAt.slice(0, 10)}</time> · <span role="status">{receipt?.contributorId ? "Public contribution credited" : labels[receipt?.status ?? row.status] ?? "Review pending"}</span></p>
          <div className="flex flex-wrap items-center gap-4 text-[var(--site-accent)]">
            {row.prUrl && <a href={row.prUrl} className="underline">View submission</a>}
            {receipt?.contributorId ? <Link href={preview ? "#contributor" : `/contributors/${receipt.contributorId}`} className="underline">View your public contribution credit</Link>
              : <button type="button" disabled={busy !== null} onClick={() => void recheck(row.id)} className="min-h-11 underline">{busy === row.id ? "Checking…" : "Check status"}</button>}
          </div>
        </li>;
      })}
    </ul>}
    <nav aria-label="Contribution pages" className="mt-3 flex items-center gap-4">
      <button type="button" disabled={loading || page === 1} onClick={() => load(page - 1)} className="min-h-11 underline disabled:opacity-40">Previous</button>
      <span>Page {page}</span>
      <button type="button" disabled={loading || !hasMore} onClick={() => load(page + 1)} className="min-h-11 underline disabled:opacity-40">Next</button>
    </nav>
  </section>;
}
