import Link from "next/link";
import CreditPagination from "./CreditPagination";
import { CREDIT_PAGE_SIZE, listCredits } from "@/lib/community-credit";
import CommunityCreditList from "./CommunityCreditList";
import { libraryAvailability, paperSource, readProtocol, researchContributorNames, type ResearchPaper, type ResearchProtocol } from "@/lib/research";
import { getPublishedProgram, publishedAssetUrl } from "@/lib/published-program";
import PublishedProgram from "./PublishedProgram";
import RunExperiment from "./RunExperiment";
import styles from "./folio-page.module.css";

const label: Record<string, string> = { "original-paper": "Original paper", "original-data-link": "Original data", "transcription-code": "Transcription code", "metadata": "Source reference", "claim-metadata": "Claim and analysis metadata" };
/** A source record links to its collection; name the link after it ("Psych-201") rather than the record type. */
const resourceLabel = (resource: { kind: string; url?: string }) =>
  resource.kind === "metadata" && /github\.com\/marcelbinz\/Psych-201\//.test(resource.url ?? "") ? "Psych-201"
    : resource.kind === "claim-metadata" && /github\.com\/tobihol\/agentic-reproducibility\//.test(resource.url ?? "") ? "Agentic Reproducibility"
    : label[resource.kind] || resource.kind;
const safeUrl = (value?: string) => { try { const url = new URL(value || ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } };

type Part = { status?: string; reason?: string | null; detail?: string; what?: string };
type StudyCapabilities = {
  read?: Part; run?: Part & { excluded?: Part[] }; humanData?: Part & { missing?: Part[]; key?: { sample?: string | null } | null };
  authorCode?: Part; reproduced?: { package?: string | null; detail?: string };
};
const STATUS: Record<string, string> = { yes: "Yes", partial: "Partly", no: "No", unknown: "Not checked", pass: "Yes", fail: "No" };

/** What a study can do, each answer with its reason (capabilities.json, desktop #45). */
function Capabilities({ caps }: { caps: StudyCapabilities }) {
  const sample = caps.humanData?.key?.sample;
  const rows: [string, string | null | undefined, string | null | undefined][] = [
    ["Read and search the study", caps.read?.status, caps.read?.reason],
    ["Run AI participants", caps.run?.status, caps.run?.reason],
    ["Original human data", caps.humanData?.status, [sample && sample !== "original" ? `${sample} sample, not the paper's own participants` : null, caps.humanData?.reason].filter(Boolean).join("; ")],
    ["Paper's results recovered from the human data", caps.reproduced?.package ?? "unknown", caps.reproduced?.package ? caps.reproduced?.detail?.split(" (")[0] : "Not checked"],
    ["Authors' analysis code", caps.authorCode?.status, caps.authorCode?.reason],
  ];
  const notes = [...(caps.run?.excluded ?? []).map(x => ({ ...x, kind: "Not runnable" })), ...(caps.humanData?.missing ?? []).map(x => ({ ...x, kind: "Not in the human data" }))];
  return <section className="mt-10">
    <h2 className="text-lg font-semibold font-serif">What you can do with it</h2>
    <dl className="mt-3 divide-y divide-[var(--site-line)] text-sm">
      {rows.map(([label, status, reason]) => <div key={label} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[16rem_5rem_1fr]">
        <dt className="text-[var(--foreground)]">{label}</dt>
        <dd className="font-medium text-[var(--foreground)]">{STATUS[status ?? "unknown"] ?? status}</dd>
        <dd className="text-[var(--site-muted)]">{reason}</dd>
      </div>)}
    </dl>
    {notes.length > 0 && <ul className="mt-3 space-y-1 text-sm text-[var(--site-muted)]">
      {notes.map((n, i) => <li key={i}><span className="text-[var(--site-muted)]">{n.kind}:</span> {n.what}: {n.reason}</li>)}
    </ul>}
  </section>;
}

/** Displays fidelity only for the independently reviewed published revision. */
function Protocol({ protocol, validated }: { protocol: ResearchProtocol; validated: boolean }) {
  const runnable = protocol.arms.filter(a => a.runnable).length;
  return <section className="mt-10">
    <h2 className="text-lg font-semibold font-serif">Protocol</h2>
    <dl className="mt-3 divide-y divide-[var(--site-line)] text-sm">
      {validated && <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[16rem_1fr]">
        <dt className="text-[var(--foreground)]">Quality level</dt>
        <dd className="text-[var(--site-muted)]"><span className="font-medium text-[var(--foreground)]">High fidelity</span> · signed by {protocol.fidelity.signedBy.join(", ")}</dd>
      </div>}
      <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[16rem_1fr]">
        <dt className="text-[var(--foreground)]">Conditions</dt>
        <dd className="text-[var(--site-muted)]">{protocol.arms.length
          ? `${runnable} of ${protocol.arms.length} runnable: ` + protocol.arms.map(a => `${a.label}${a.nPaper ? ` (n = ${a.nPaper} in the paper)` : ""}${a.runnable ? "" : " — not runnable"}`).join("; ")
          : "None listed"}</dd>
      </div>
      {protocol.effects !== null && <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[16rem_1fr]">
        <dt className="text-[var(--foreground)]">Effects scored against the paper</dt>
        <dd className="text-[var(--site-muted)]">{protocol.effects}</dd>
      </div>}
    </dl>
    {protocol.runExcluded.length > 0 && <ul className="mt-3 space-y-1 text-sm text-[var(--site-muted)]">
      {protocol.runExcluded.map((x, i) => <li key={i}>Not run: {x.what}{x.reason ? `: ${x.reason}` : ""}</li>)}
    </ul>}
    {!protocol.schemaKnown && <p className="mt-3 text-sm text-[var(--site-muted)]">This protocol uses a newer format than this site reads, so some details may be missing.</p>}
  </section>;
}

export default async function ResearchPaperDetail({ paper, contributionPage = 1 }: { paper: ResearchPaper; contributionPage?: number }) {
  // Catalog documents from different sources omit empty lists.
  const authors = paper.authors ?? [], resources = paper.resources ?? [];
  const repository = paper.assetRoot && /^(studies\/study_\d+|community\/[A-Za-z0-9_.-]+\/revisions\/[a-f0-9]{64})$/.test(paper.assetRoot)
    ? `https://github.com/HumanStudy-Hub/HumanStudy-Bench/tree/main/${paper.assetRoot}` : null;
  const protocol = readProtocol(paper);
  const availability = libraryAvailability(paper);
  const [program, credits] = await Promise.all([
    getPublishedProgram(paper),
    paper.currentRevision ? listCredits({ by: "paper", id: paper.id, revision: paper.currentRevision }, contributionPage).catch(() => []) : [],
  ]);
  const contributors = researchContributorNames(paper, credits.map(credit => credit.display_name));
  const programSource = program ? publishedAssetUrl(paper, program.source.filename) : null;
  return <div className={`${styles.page} ${styles.narrow}`}>
    <div>
      <Link href="/studies" className={styles.back}>← Study Library</Link>
      <h1>{paper.title}</h1>
      <p className="mt-3 text-sm text-[var(--site-muted)]">{[authors.join(", "), paper.year, paperSource(paper)].filter(Boolean).join(" · ")}</p>
      <p className="mt-6 whitespace-pre-wrap leading-7 text-[var(--foreground)]">{paper.description}</p>
      {availability.inDevelopment && <p className="mt-6 text-sm text-[var(--site-muted)]">
        {paper.developmentStage === "draft" ? "In development · protocol draft exists." : "In development · study materials are being prepared."}
      </p>}
      {availability.userSubmitted && <p className="mt-3 text-sm text-[var(--site-muted)]">User submitted</p>}
      {!program && !availability.inDevelopment && <p className="mt-6 text-sm text-[var(--site-muted)]">{availability.publicProtocol ? "A published protocol is available for this study." : paper.currentRevision ? "This paper has a published research package." : paper.legacyStudyId ? "Study materials are available. Source coverage and execution need to be checked for your research." : "This paper is indexed in the Study Library."}</p>}
      <div className="mt-6 flex flex-wrap gap-4 text-sm text-[var(--site-accent)]">
        {program && <a href="#paper-program">Interact with paper</a>}
        {(availability.program || availability.publicProtocol)
          ? <a href="#run-experiment">Run experiment</a>
          : <Link href="/pipeline">Build a study</Link>}
      </div>
      {contributors.length > 0 && <p className="mt-2 text-sm text-[var(--site-muted)]">Contributed by {contributors.join(", ")}</p>}
      {(programSource || repository || protocol?.preview) && <div className="mt-4 flex flex-wrap gap-4 text-sm text-[var(--site-accent)]">
        {programSource && <a href={programSource} target="_blank" rel="noreferrer">Original paper ↗</a>}
        {repository && <a href={repository} target="_blank" rel="noopener noreferrer">Research files ↗</a>}
        {protocol?.preview && <a href={protocol.preview} target="_blank" rel="noopener noreferrer">Participant view ↗</a>}
      </div>}
      {(availability.program || availability.publicProtocol) && <RunExperiment
        paper={paper}
        program={program}
        protocol={availability.publicProtocol ? protocol : null}
        validated={availability.validated}
        runnable={availability.runnable}
      />}
      {program ? <PublishedProgram paper={paper} program={program} /> : availability.program && (
        <p id="paper-program" className="mt-9 scroll-mt-24 text-sm text-[var(--site-muted)]">
          The published study document could not be loaded. Try refreshing the page.
        </p>
      )}
      {protocol && availability.publicProtocol && <Protocol protocol={protocol} validated={availability.validated} />}
      {(credits.length > 0 || contributionPage > 1) && <section id="community-contributions" className="mt-10 scroll-mt-24">
        <h2 className="text-lg font-semibold font-serif">Community contributions</h2>
        <CommunityCreditList entries={credits.slice(0, CREDIT_PAGE_SIZE)} showPaper={false} allowVote />
        <CreditPagination page={contributionPage} hasNext={credits.length > CREDIT_PAGE_SIZE}
          base={`/studies/${paper.id}?creditPage=`} anchor="#community-contributions" />
      </section>}
      {paper.studyCapabilities ? <Capabilities caps={paper.studyCapabilities as StudyCapabilities} /> : null}
      {resources.length > 0 && <section className="mt-10">
        <h2 className="text-lg font-semibold font-serif">Sources</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {resources.map((resource, i) => {
            const url = safeUrl(resource.url);
            return <li key={`${resource.id}-${i}`}>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-[var(--site-accent)] underline">{resourceLabel(resource)} ↗</a> : <span>{resourceLabel(resource)}</span>}
              <span className="ml-2 text-[var(--site-muted)]">{resource.access === "unverified" ? "Availability not checked" : resource.access}</span>
            </li>;
          })}
        </ul>
      </section>}
    </div>
  </div>;
}
