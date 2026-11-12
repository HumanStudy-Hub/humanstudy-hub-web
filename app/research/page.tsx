import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "@/components/folio-page.module.css";
import { papers } from "./papers";

export const metadata: Metadata = {
  title: "Research · HumanStudy-Hub",
  description: "The papers behind HumanStudy-Hub: executable human study programs and HumanStudy-Bench.",
};

function Visual({ slug }: { slug: string }) {
  if (slug === "humanstudy-program") {
    return (
      <div className="rounded-[2px] bg-white p-3 sm:p-4">
        <Image
          src="/research/humanstudy-program.jpg"
          alt="HumanStudy Program overview: Build Study reconstructs materials, participants, procedure, response, and analysis from a paper into a study program; Playground configures silicon participants, runs the program, and analyzes results."
          width={2000}
          height={929}
          sizes="(max-width: 1024px) 100vw, 600px"
          className="h-auto w-full"
        />
      </div>
    );
  }
  return (
    // Column widths follow each figure's aspect ratio so both render at the same height.
    <div className="grid grid-cols-[1.14fr_1.1fr] items-center gap-3 rounded-[2px] bg-white p-3 sm:gap-4 sm:p-4">
      <Image
        src="/research/humanstudy-bench.jpg"
        alt={BENCH_FIGURE_ALT}
        width={1600}
        height={1404}
        sizes="(max-width: 1024px) 50vw, 300px"
        className="h-auto w-full"
      />
      <Image
        src="/research/humanstudy-bench-pas.jpg"
        alt={BENCH_PAS_ALT}
        width={997}
        height={905}
        sizes="(max-width: 1024px) 50vw, 300px"
        className="h-auto w-full"
      />
    </div>
  );
}

const BENCH_PAS_ALT =
  "Violin plots of test-level Probability Alignment Score (PAS) from 0 to 1 for Mistral Nemo, GPT-5n, DeepSeek, and Claude H.4.5, with medians around 0.43 to 0.61.";

const BENCH_FIGURE_ALT =
  "Scatter plot of human effect sizes against agent effect sizes, colored by whether the agent result is significant and sized by replication power, with marginal distributions; r = 0.390.";

export default function ResearchPage() {
  return (
    <div className={styles.page}>
      <h1 className="sr-only">Research</h1>
      <ul className="grid gap-6">
        {papers.map((paper) => (
          <li key={paper.slug}>
            <article className="grid items-center gap-8 rounded-[2px] bg-[var(--site-surface)] p-5 sm:p-8 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-12">
              <div className="min-w-0">
                <Visual slug={paper.slug} />
              </div>
              <div className="px-1 pb-2 lg:px-0 lg:pb-0">
                <div className="flex flex-wrap gap-x-3 text-[13px] text-[var(--site-muted)]">
                  <span className="text-[var(--site-accent)]">{paper.tag}</span>
                  <span aria-hidden="true">·</span>
                  <time>{paper.date}</time>
                </div>
                <h2 className="mt-4 !text-[26px] !leading-[1.25] tracking-[-0.01em] sm:!text-[30px]">
                  <Link href={`/research/${paper.slug}`} className="hover:text-[var(--site-accent)]">
                    {paper.title}
                  </Link>
                </h2>
                <p className="mt-4 font-[family-name:var(--site-font-serif)] text-[17px] leading-[1.65] text-[var(--site-muted)]">
                  {paper.summary}
                </p>
                <Link
                  href={`/research/${paper.slug}`}
                  aria-label={`Read more about ${paper.title}`}
                  className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm text-[var(--site-accent)] underline-offset-4 hover:underline"
                >
                  Read more <span aria-hidden="true">→</span>
                </Link>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
