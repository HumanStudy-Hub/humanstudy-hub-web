import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import CommunityCreditList from "@/components/CommunityCreditList";
import ContributorSummary from "@/components/ContributorSummary";
import MyContributions from "@/components/MyContributions";
import styles from "@/components/folio-page.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Community UI review | HumanStudy-Hub", robots: { index: false, follow: false } };

export default function CommunityReviewPage() {
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const person = { id: "example", display_name: "Example Contributor", helpful: 12, contributions: 1 };
  const entry = { id: "example-submission", paper_id: "example-paper", paper_title: "An example study of decision framing",
    revision: "example-revision", contributor_id: person.id, display_name: person.display_name, helpful: 12 };
  return <div className={styles.page}>
    <header className={styles.heading}>
      <h1>Community UI review</h1>
      <p className={styles.lede}>Example data. Try the controls; nothing is saved or submitted.</p>
      <p className="mt-3 text-sm text-[var(--site-muted)]">This page is available only on preview deployments. Votes and status checks below stay in your browser and reset on reload.</p>
    </header>
    <nav aria-label="Review sections" className="flex flex-wrap gap-5 text-sm text-[var(--site-accent)] underline">
      <a href="#paper-credit">Paper credit</a><a href="#contributor">Contributor profile</a><a href="#submissions">My contributions</a>
    </nav>
    <section id="paper-credit" className={styles.section} aria-label="Paper credit example">
      <h2>{entry.paper_title}</h2>
      <p className="mt-2 text-sm text-[var(--site-muted)]">Original paper authors: Example Author · 2025</p>
      <CommunityCreditList entries={[entry]} showPaper={false} allowVote preview />
      <p className="text-sm text-[var(--site-muted)]">Helpful is community feedback, not scientific validation.</p>
    </section>
    <section id="contributor" className={styles.section} aria-label="Contributor profile example">
      <ContributorSummary person={person} heading="h2" />
      <h3 className="font-semibold">Accepted contributions</h3>
      <CommunityCreditList entries={[entry]} preview />
    </section>
    <section id="submissions" aria-label="Submission history example">
      <MyContributions previewRows={[{ id: "example-submission", paperKey: entry.paper_title, status: "merged", prUrl: null, createdAt: "2026-11-11T00:00:00Z" }]} />
    </section>
    <section className={styles.section} aria-label="Explore real pages">
      <h2>Explore the rest of the site</h2>
      <div className="mt-4 flex flex-wrap gap-5 text-[var(--site-accent)] underline">
        <Link href="/forum">Forum</Link><Link href="/studies">Study Library</Link><Link href="/contribute">Submit a study</Link>
      </div>
      <p className="mt-3 text-sm text-[var(--site-muted)]">Sign in to HumanStudy Hub to submit a study.</p>
    </section>
  </div>;
}
