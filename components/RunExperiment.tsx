import Link from "next/link";
import type { ResearchPaper, ResearchProtocol } from "@/lib/research";
import type { HumanProgram } from "@/lib/studio/human-program";
import CopyStudyId from "./CopyStudyId";
import { paperWorkspace, paperWorkspacePath } from "@/lib/paper-workspace";

export default function RunExperiment({
  paper, program, protocol, validated, runnable,
}: {
  paper: ResearchPaper;
  program: HumanProgram | null;
  protocol: ResearchProtocol | null;
  validated: boolean;
  runnable: boolean;
}) {
  const canRunProtocol = protocol?.schemaRunnable && protocol.arms.some(arm => arm.runnable);
  const scope = canRunProtocol ? protocol.arms.filter(arm => arm.runnable).map(arm => arm.label) : [];
  const issues = program?.issues.filter(issue => issue.severity === "blocking" || issue.severity === "decision") ?? [];
  const run = (paper.studyCapabilities as {
    run?: { status?: string; reason?: string; excluded?: { what?: string; reason?: string }[] };
  } | undefined)?.run;
  const runGap = !protocol && (run?.status === "no" || run?.status === "partial") ? run.reason : null;
  const excluded = (protocol?.runExcluded ?? run?.excluded ?? []).filter(item => item.what || item.reason);
  const source = program?.source.filename;
  const files = paper.assetFiles ?? [];
  const online = paperWorkspace({ paper: paper.id, revision: paper.currentRevision, intent: "run" });
  const paperPaths = new Set(program?.evidence.filter(item => item.sourceId === "paper").map(item => item.path));
  const sourceAvailable = files.some(file => /\.pdf$/i.test(file.path) && (
    paperPaths.has(file.path) || file.path === source
  )) || (source
    ? files.filter(file => file.path.endsWith("/" + source) && /\.pdf$/i.test(file.path)).length === 1
    : files.some(file => /^sources\/.+\.pdf$/i.test(file.path)));

  return <section id="run-experiment" className="mt-9 scroll-mt-24 border-t border-[var(--site-line)] pt-6">
    <h2 className="text-xl font-semibold font-serif">Run experiment</h2>
    {validated && <p className="mt-2 text-sm text-[var(--site-accent)]">Validated protocol · {scope.join(", ")}</p>}
    {canRunProtocol ? (
      <p className="mt-2 text-sm">Open the study workspace to review its supported conditions.</p>
    ) : program ? (
      <p className="mt-2 text-sm">{runnable
        ? "A runnable draft is included. Review its conditions before running."
        : "Prepare and review an experiment from this paper with the agent."}</p>
    ) : (
      <p className="mt-2 text-sm">{protocol
        ? "The published protocol has no conditions supported for running here."
        : "The published study document could not be loaded. You can still try importing it in Desktop."}</p>
    )}
    {online && <Link href={paperWorkspacePath(online)} className="mt-4 inline-block text-[var(--site-accent)] underline">Open experiment workspace →</Link>}
    {program && !sourceAvailable && (
      <p className="mt-3 text-sm">
        {source ? <>The release does not identify an included copy of <code>{source}</code>.</> : "The release has no paper PDF."}
        {" "}Check the sources below and attach your copy in the workspace if needed.
      </p>
    )}
    {runGap && <p className="mt-3 text-sm">{runGap}</p>}
    {(excluded.length > 0 || issues.length > 0) && <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-medium">Missing materials and decisions to review</summary>
      <ul className="mt-2 list-disc space-y-2 pl-5">
        {excluded.map(({ what, reason }, i) => <li key={i}>{[what, reason].filter(Boolean).join(" — ")}</li>)}
        {issues.map(issue => <li key={issue.id}><strong>{issue.title}</strong> {issue.reason}</li>)}
      </ul>
    </details>}
    <details className="mt-4"><summary className="cursor-pointer text-sm">Use the desktop app</summary>
    <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
      <li>In HumanStudy Desktop, open <strong>Studies</strong> and search for this study ID.</li>
      <li>Open the study and select <strong>Fork to my projects</strong>.</li>
      {(program?.studies.filter(study => study.type === "empirical").length ?? 0) > 1 && !canRunProtocol && (
        <li>Open <strong>Study</strong> and select the experiment you want to run.</li>
      )}
      <li>Open <strong>Simulation</strong>. If a draft is needed, select <strong>Build the study first</strong> or <strong>Prepare a runnable protocol</strong>.</li>
      <li>When available, select <strong>Check readiness</strong> and resolve any missing materials or decisions.</li>
      <li>When the checks pass, review the conditions and select <strong>Run simulation</strong>.</li>
    </ol>
    <CopyStudyId id={paper.id} />
    <Link href="/download" className="mt-3 inline-block text-sm text-[var(--site-accent)] underline">Get HumanStudy Desktop</Link>
    </details>
  </section>;
}
