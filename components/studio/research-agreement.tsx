'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { RESEARCH_AGREEMENT, RESEARCH_CONSENT_VERSION } from '@/lib/research-data/agreement';
import s from './projects.module.css';
import {ResearchCollectionContext} from '@/lib/research-data/collection-context';

/** Keep the actual editor unmounted until consent is checked, so effects cannot capture early. */
export function ResearchAgreement({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false), [needed, setNeeded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [enabled,setEnabled]=useState(false);
  const check = useCallback(async () => {
    setReady(false); setError('');
    try {
      const r = await fetch('/api/studio/research-consent', { cache: 'no-store' });
      if (r.status === 401) { setEnabled(true); setNeeded(false); setReady(true); return; }
      if (!r.ok) throw new Error('Could not check the research agreement. Please retry.');
      const data = await r.json(); setEnabled(data.enabled === true); setNeeded(data.enabled !== false && data.agreed !== true); setReady(data.enabled === false || data.agreed === true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not check the agreement.'); }
  }, []);
  useEffect(() => { void check(); const changed = () => void check(); window.addEventListener('studio-auth-changed', changed); return () => window.removeEventListener('studio-auth-changed', changed); }, [check]);
  async function agree() {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/studio/research-consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: RESEARCH_CONSENT_VERSION, accepted: true }) });
      if (!r.ok) throw new Error('Could not save your agreement. Please retry.');
      await check();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your agreement.'); }
    finally { setBusy(false); }
  }
  if (ready) return <ResearchCollectionContext.Provider value={enabled}>{children}</ResearchCollectionContext.Provider>;
  return <div className={s.hub}><header className={s.hubHeader}><Link href="/">HumanStudy-Hub</Link></header><main className={s.authLayout}><section className={s.authCard} aria-labelledby="research-agreement-title">
    <h1 id="research-agreement-title">Research data agreement</h1>
    {needed ? <>{RESEARCH_AGREEMENT.map(p => <p key={p}>{p}</p>)}<button className={s.primary} disabled={busy} onClick={() => void agree()}>{busy ? 'Saving…' : 'I agree'}</button><Link href="/">Not now</Link></> : !error && <p role="status">Checking your agreement…</p>}
    {error && <><p role="alert" className={s.error}>{error}</p><button onClick={() => void check()}>Retry</button></>}
  </section></main></div>;
}
