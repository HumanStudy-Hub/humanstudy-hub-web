import Link from "next/link";
import type { ResearchPaper, ResearchProtocol } from "@/lib/research";
import CopyStudyId from "./CopyStudyId";
import { paperWorkspace, paperWorkspacePath } from "@/lib/paper-workspace";

export default function RunExperiment({
  paper, hasProgram, protocol, validated,
}: {
  paper: ResearchPaper;
  hasProgram: boolean;
  protocol: ResearchProtocol | null;
  validated: boolean;
}) {
  const online = paperWorkspace({ paper: paper.id, revision: paper.currentRevision, intent: "run" });
  if (hasProgram && online) return (
    <Link id="run-experiment" href={paperWorkspacePath(online)}
      className="mt-6 inline-flex min-h-11 scroll-mt-24 items-center rounded-md bg-[var(--site-accent)] px-4 text-sm font-semibold text-white">
      Run experiment
    </Link>
  );

  const canRunProtocol = protocol?.schemaRunnable && protocol.arms.some(arm => arm.runnable);
  const scope = canRunProtocol ? protocol.arms.filter(arm => arm.runnable).map(arm => arm.label) : [];
  const run = (paper.studyCapabilities as {
    run?: { status?: string; reason?: string; excluded?: { what?: string; reason?: string }[] };
  } | undefined)?.run;
  const runGap = !protocol && (run?.status === "no" || run?.status === "partial") ? run.reason : null;
  const excluded = (protocol?.runExcluded ?? run?.excluded ?? []).filter(item => item.what || item.reason);

  return <section id="run-experiment" className="mt-9 scroll-mt-24 border-t border-[var(--site-line)] pt-6">
    <h2 className="text-xl font-semibold font-serif">Run experiment</h2>
    {validated && <p className="mt-2 text-sm text-[var(--site-accent)]">Validated protocol · {scope.join(", ")}</p>}
    {canRunProtocol ? (
      <p className="mt-2 text-sm">Open the study workspace to review its supported conditions.</p>
    ) : (
      <p className="mt-2 text-sm">{protocol
        ? "The published protocol has no conditions supported for running here."
        : "The published study document could not be loaded. You can still try importing it in Desktop."}</p>
    )}
    {online && <Link href={paperWorkspacePath(online)} className="mt-4 inline-block text-[var(--site-accent)] underline">Open experiment workspace →</Link>}
    {runGap && <p className="mt-3 text-sm">{runGap}</p>}
    {excluded.length > 0 && <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-medium">Missing materials and decisions to review</summary>
      <ul className="mt-2 list-disc space-y-2 pl-5">
        {excluded.map(({ what, reason }, i) => <li key={i}>{[what, reason].filter(Boolean).join(" — ")}</li>)}
      </ul>
    </details>}
    <details className="mt-4"><summary className="cursor-pointer text-sm">Use the desktop app</summary>
    <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
      <li>In HumanStudy Desktop, open <strong>Studies</strong> and search for this study ID.</li>
      <li>Open the study and select <strong>Fork to my projects</strong>.</li>
      <li>Open <strong>Simulation</strong>. If a draft is needed, select <strong>Build the study first</strong> or <strong>Prepare a runnable protocol</strong>.</li>
      <li>When available, select <strong>Check readiness</strong> and resolve any missing materials or decisions.</li>
      <li>When the checks pass, review the conditions and select <strong>Run simulation</strong>.</li>
    </ol>
    <CopyStudyId id={paper.id} />
    <Link href="/download" className="mt-3 inline-block text-sm text-[var(--site-accent)] underline">Get HumanStudy Desktop</Link>
    </details>
  </section>;
}
