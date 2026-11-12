import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import LeaderboardTable from "@/components/LeaderboardTable";
import styles from "@/components/folio-page.module.css";
import ProgramArticle from "../ProgramArticle";
import { papers } from "../papers";

export function generateStaticParams() {
  return papers.map((paper) => ({ slug: paper.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const paper = papers.find((item) => item.slug === slug);
  return paper ? { title: `${paper.tag} · Research · HumanStudy-Hub`, description: paper.summary } : {};
}

export default async function ResearchPaperPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const paper = papers.find((item) => item.slug === slug);
  if (!paper) notFound();

  return (
    <div className={styles.page}>
      <article>
        <Link href="/research" className={styles.back}>← Research</Link>
        <header className="mt-6">
          <div className="flex flex-wrap gap-x-3 text-[13px] text-[var(--site-muted)]">
            <span className="text-[var(--site-accent)]">{paper.tag}</span>
            <span aria-hidden="true">·</span>
            <time>{paper.date}</time>
          </div>
          <h1 className="mt-4 !max-w-none">{paper.title}</h1>
          <p className="mt-8 font-[family-name:var(--site-font-serif)] text-[21px] leading-[1.7]">{paper.summary}</p>
          <a href={paper.href} target="_blank" rel="noopener noreferrer" className={`${styles.button} mt-8`}>
            Read the paper · {paper.arxiv}
          </a>
        </header>

        {paper.slug === "humanstudy-program" && <ProgramArticle />}
      </article>

      {paper.slug === "humanstudy-bench" && (
        <div className="mt-16">
          <LeaderboardTable />
        </div>
      )}
    </div>
  );
}
