import type { Metadata } from "next";
import Link from "next/link";
import ContributeUploadForm from "@/components/ContributeUploadForm";
import { getResearchPaper } from "@/lib/research";
import styles from "@/components/folio-page.module.css";

export const metadata: Metadata = {
  title: "Contribute a study package | HumanStudy-Hub",
  description: "Upload an existing HumanStudy-Bench study package and open a contribution pull request.",
};

export default async function ContributePage({ searchParams }: { searchParams: Promise<{ paper?: string }> }) {
  const { paper: requested } = await searchParams;
  const paper = typeof requested === "string" && /^paper_[a-f0-9]{24}$/.test(requested)
    ? await getResearchPaper(requested) : null;
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Contribute a study package</h1>
        <p className={styles.lede}>
          Submit a Human Study Program or a Program with a draft protocol for review.
        </p>
        <p className="mt-4 max-w-3xl text-sm leading-6 text-[var(--site-muted)]">
          Export a community contribution from your HumanStudy project. A Program-only ZIP contributes the reading document and public sources.
          A paired ZIP also includes a draft protocol and its source manifest. Paired drafts go to maintainer review before they can be recommended or marked Validated.
        </p>
        <p className="mt-3 text-sm text-[var(--site-muted)]">
          Need to prepare a study first? <Link href="/download" className="text-[var(--site-accent)] underline">Get HumanStudy Desktop</Link>{" "}
          or <Link href="/try" className="text-[var(--site-accent)] underline">open HumanStudy Online</Link>.
        </p>
      </header>
      <div className={styles.formSheet}>
        <section aria-label="Study contribution">
          {requested && !paper && <p role="alert" className="mb-4 text-sm">The selected paper could not be found. Choose a paper in the Study Library or upload a contribution without a selection.</p>}
          <ContributeUploadForm paper={paper ? { id: paper.id, title: paper.title, doi: typeof paper.doi === "string" ? paper.doi : undefined } : undefined} />
        </section>
        <p className="mt-6 text-sm text-[var(--site-muted)]">
          Prefer to open the pull request yourself?{" "}
          <a href="https://github.com/HumanStudy-Hub/HumanStudy-Bench/blob/main/docs/submit_study.md" target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--site-accent)] hover:underline">
            Contribute manually on GitHub
          </a>
          .
        </p>
      </div>
    </div>
  );
}
