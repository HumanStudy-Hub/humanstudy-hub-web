'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { PipelineProgress } from '@/lib/github-jobs';
import type { StudioDocument, StudioSource } from '@/lib/studio/types';
import { isPaper } from '@/lib/studio/resources';
import s from './build-start.module.css';

const labels = {
  building_package: 'Extracting the study',
  validating_package: 'Checking the package',
  ready_for_review: 'Opening Human Program',
  timed_out: 'The build reached its time limit',
  failed: 'The build stopped',
};

export default function BuildStart({ id, document, stage, resources, primaryPaper, onPaper, onBuild, onRetry, onCheck, onNavigate, busy, message, error, job }: {
  id: string; document: StudioDocument; stage: 'intake' | 'processing'; resources: ReactNode;
  primaryPaper?: StudioSource; onPaper: (id: string) => void; onBuild: (instructions: string) => void;
  onRetry: () => void; onCheck: () => void; onNavigate: (href:string) => void; busy: boolean; message?: string; error?: string;
  job?: { status: string; message: string; progress?: PipelineProgress } | null;
}) {
  const [instructions, setInstructions] = useState('');
  const [stalledJob,setStalledJob] = useState<string>();
  const jobId=document.pipeline?.jobId, updatedAt=document.pipeline?.updatedAt;
  useEffect(()=>{if(!jobId||!updatedAt)return;const timer=setTimeout(()=>setStalledJob(jobId),Math.max(0,Date.parse(updatedAt)+300000-Date.now()));return()=>clearTimeout(timer);},[jobId,updatedAt]);
  const progress = job?.progress;
  const status = document.pipeline?.status === 'failed' ? 'failed' : job?.status || document.pipeline?.status;
  const failed = status === 'failed' || progress?.phase === 'timed_out' || progress?.phase === 'failed';
  const stalled = status === 'queued' && stalledJob === jobId;
  const papers = document.sources.filter(source => isPaper(source) && source.includeInBuild !== false);
  const checking = progress?.phase === 'validating_package' || progress?.phase === 'ready_for_review';
  return <div className={s.start} data-studio-workspace={id}>
    <header><Link href="/" className={s.brand} onClick={event=>{event.preventDefault();onNavigate("/");}}>HumanStudy-Hub</Link><Link href="/build" data-event="build.studies" onClick={event=>{event.preventDefault();onNavigate("/build");}}>Your studies</Link></header>
    <main>
      <div className={s.heading}><span>Build study</span><h1>{document.title}</h1></div>
      {stage === 'intake' ? <section className={s.intake}>
        <h2>Add your paper and materials</h2>
        <div data-event="build.resources">{resources}</div>
        {papers.length > 1 && <label>Primary paper<select value={primaryPaper?.id || ''} onChange={event => onPaper(event.target.value)}>{papers.map(paper => <option key={paper.id} value={paper.id}>{paper.name}</option>)}</select></label>}
        <label>Anything the agent should know?<textarea maxLength={12000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Optional research question or instructions" /></label>
        <button type="button" className={s.primary} data-event="build.start" disabled={busy || !primaryPaper} onClick={() => onBuild(instructions)}>{busy ? 'Preparing…' : 'Build study'}</button>
      </section> : <div className={s.processing}>
        <ol aria-label="Build workflow"><li className={!checking && !failed ? s.current : ''}>Read sources</li><li className={!checking && !failed ? s.current : ''}>Build Human Program</li><li className={checking && !failed ? s.current : ''}>Check package</li><li>Review together</li></ol>
        <section aria-live="polite" aria-busy={!failed}>
          <h2>{failed ? 'Build interrupted' : progress ? labels[progress.phase] : status === 'queued' ? 'Waiting for the study agent' : 'Preparing your study'}</h2>
          <p>{message || job?.message || document.pipeline?.message}</p>
          {!failed && <div className={s.activity} aria-hidden="true" />}
          {progress && <p>{progress.completedRequired} / {progress.totalRequired} required files</p>}
          {stalled && <p>The runner has not started. Your uploaded materials are saved.</p>}
          {(failed || stalled) && <button type="button" className={s.primary} disabled={busy} data-event="build.retry" onClick={onRetry}>Restart build</button>}
          {error && !failed && <button type="button" disabled={busy} data-event="build.check" onClick={onCheck}>Try loading the result</button>}
          {!failed && <p className={s.hint}>Human Program will open when the result is ready. You can leave and return to this study.</p>}
          <details><summary>Materials ({document.sources.length})</summary><ul>{document.sources.map(source => <li key={source.id}>{source.name}{source.includeInBuild === false ? ' · excluded' : ''}</li>)}</ul></details>
        </section>
      </div>}
      {error && <p className={s.error} role="alert">{error}</p>}
    </main>
  </div>;
}
