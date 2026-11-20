'use client';
import { useEffect, useState } from 'react';

type Allowance = { available: boolean; percentLeft: number; requestsLeft: number; revoked: boolean; expired: boolean };

/** One line with the signed-in account's hosted model allowance. Renders nothing until loaded or when the account has no grant. */
export function ModelAllowance({ className, strongLabel = false }: { className?: string; strongLabel?: boolean }) {
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/desktop/allowance', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(response => response.ok ? response.json() as Promise<Allowance> : null)
      .then(result => { if (!controller.signal.aborted) setAllowance(result?.available ? result : null); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!allowance) return null;
  const left = `${allowance.percentLeft}% left`;
  return <p className={className}>{strongLabel ? <><strong>Model allowance</strong> {left}</> : `Model allowance: ${left}`}</p>;
}
