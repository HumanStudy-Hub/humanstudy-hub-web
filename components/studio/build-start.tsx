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
  primaryPaper?: StudioSource; onPaper: (id: string) => void; onBuild: (instructions: string) => Promise<boolean> | void;
  onRetry: () => void; onCheck: () => void; onNavigate: (href:string) => void; busy: boolean; message?: string; error?: string;
  job?: { status: string; message: string; progress?: PipelineProgress } | null;
}) {
  const [instructions, setInstructions] = useState('');
  const [stalledJob,setStalledJob] = useState<string>();
  // The text is cleared only once the build request was accepted, so a rejected start keeps it.
  async function send() { if (await onBuild(instructions) !== false) setInstructions(''); }
  const jobId=document.pipeline?.jobId, updatedAt=document.pipeline?.updatedAt;
  useEffect(()=>{if(!jobId||!updatedAt)return;const timer=setTimeout(()=>setStalledJob(jobId),Math.max(0,Date.parse(updatedAt)+300000-Date.now()));return()=>clearTimeout(timer);},[jobId,updatedAt]);
  const progress = job?.progress;
  const status = document.pipeline?.status === 'failed' ? 'failed' : job?.status || document.pipeline?.status;
  const failed = status === 'failed' || progress?.phase === 'timed_out' || progress?.phase === 'failed';
  const stalled = status === 'queued' && stalledJob === jobId;
  const papers = document.sources.filter(source => isPaper(source) && source.includeInBuild !== false);
  const checking = progress?.phase === 'validating_package' || progress?.phase === 'ready_for_review';
  // When the agent stopped to ask for something, its reply is saved into the build's conversation.
  const reply = document.pipeline?.status === 'failed' && document.pipeline.resultMessageId
    ? document.conversations.flatMap(c => c.messages).find(m => m.id === document.pipeline?.resultMessageId && m.role === 'agent')?.text
    : undefined;
  return <div className={s.start} data-studio-workspace={id}>
    <header><Link href="/" className={s.brand} onClick={event=>{event.preventDefault();onNavigate("/");}}>HumanStudy-Hub</Link><Link href="/build/projects" data-event="build.studies" onClick={event=>{event.preventDefault();onNavigate("/build/projects");}}>Your studies</Link></header>
    <div data-workspace-content>
      <div className={s.heading}><span>Build study</span><h1>{document.title}</h1></div>
      {stage === 'intake' ? <section className={s.intake}>
        <h2>Add your paper and materials</h2>
        <div data-event="build.resources">{resources}</div>
        {papers.length > 1 && <label>Primary paper<select value={primaryPaper?.id || ''} onChange={event => onPaper(event.target.value)}>{papers.map(paper => <option key={paper.id} value={paper.id}>{paper.name}</option>)}</select></label>}
        <label>Anything the agent should know?<textarea maxLength={12000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Optional research question or instructions" /></label>
        <button type="button" className={s.primary} data-event="build.start" disabled={busy || !primaryPaper} onClick={() => void send()}>{busy ? 'Preparing…' : 'Build study'}</button>
      </section> : <div className={s.processing}>
        <ol aria-label="Build workflow"><li className={!checking && !failed ? s.current : ''}>Read sources</li><li className={!checking && !failed ? s.current : ''}>Build Human Program</li><li className={checking && !failed ? s.current : ''}>Check package</li><li>Review together</li></ol>
        <section>
          <div aria-live="polite" aria-busy={!failed}>
          <h2>{failed ? 'Build interrupted' : progress ? labels[progress.phase] : status === 'queued' ? 'Waiting for the study agent' : 'Preparing your study'}</h2>
          <p>{message || (reply ? 'The agent needs something from you before it can finish the study.' : job?.message || document.pipeline?.message)}</p>
          {reply && <div className={s.reply} data-studio-agent-reply>{reply}</div>}
          </div>
          {!failed && <div className={s.activity} aria-hidden="true" />}
          {progress && <p>{progress.completedRequired} / {progress.totalRequired} required files</p>}
          {stalled && <p>The runner has not started. Your uploaded materials are saved.</p>}
          {/* The agent asked for something: the researcher adds it here and builds again as a new request,
              which carries the new materials and the agent's reply. Other failures restart as before. */}
          {failed && reply ? <div className={s.followup}>
            <div data-event="build.resources">{resources}</div>
            {papers.length > 1 && <label>Primary paper<select value={primaryPaper?.id || ''} onChange={event => onPaper(event.target.value)}>{papers.map(paper => <option key={paper.id} value={paper.id}>{paper.name}</option>)}</select></label>}
            <label>Anything the agent should know?<textarea maxLength={12000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Optional answer or instructions" /></label>
            <button type="button" className={s.primary} data-event="build.start" disabled={busy || !primaryPaper} onClick={() => void send()}>{busy ? 'Preparing…' : 'Build study'}</button>
          </div> : (failed || stalled) && <button type="button" className={s.primary} disabled={busy} data-event="build.retry" onClick={onRetry}>Restart build</button>}
          {error && !failed && <button type="button" disabled={busy} data-event="build.check" onClick={onCheck}>Try loading the result</button>}
          {!failed && <p className={s.hint}>Human Program will open when the result is ready. You can leave and return to this study.</p>}
          <details><summary>Materials ({document.sources.length})</summary><ul>{document.sources.map(source => <li key={source.id}>{source.name}{source.includeInBuild === false ? ' · excluded' : ''}</li>)}</ul></details>
        </section>
      </div>}
      {error && <p className={s.error} role="alert">{error}</p>}
    </div>
  </div>;
}
