import type { Metadata } from "next";
import Image from "next/image";
import ArrowRight from "@/components/ArrowRight";
import folio from "@/components/folio-page.module.css";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Research & Discussion | HumanStudy Hub",
  description: "Read research notes on reproducible human studies and agent behavior, and join the HumanStudy Forum.",
};

const articles = [
  {
    url: "https://xuanl17.github.io/blog/reproducible-human-studies.html",
    title: "Making Human Studies as Reproducible as Open-Source Code",
    author: "Xuan Liu",
    date: "2026-03-10",
    dateLabel: "March 10, 2026",
    description: "A case for sharing experiment materials, procedures, and analysis together so others can rerun or adapt a study.",
  },
  {
    url: "https://xuanl17.github.io/blog/implicit-agent-behavior.html",
    title: "Can Implicit Language Reliably Control Agent Behavior?",
    author: "Xuan Liu",
    date: "2025-09-16",
    dateLabel: "September 16, 2025",
    description: "A framing-effect test found that the same character descriptions led to different behaviors across models. The article introduces CoBRA for specifying and calibrating behavior.",
  },
] as const;

export default function ForumPage() {
  return (
    <div className={folio.page}>
      <header className={folio.heading}>
        <h1>Research &amp; discussion</h1>
      </header>

      <section aria-label="Research articles" className={styles.articles}>
        {articles.map(article => (
          <article key={article.url} className={styles.article}>
            <p className={styles.byline}>
              {article.author} <span aria-hidden="true">·</span> <time dateTime={article.date}>{article.dateLabel}</time>
            </p>
            <h2>
              <a href={article.url}>
                {article.title} <ArrowRight />
              </a>
            </h2>
            <p className={styles.description}>{article.description}</p>
          </article>
        ))}
      </section>

      <section className={folio.section} aria-labelledby="forum-title">
        <div className={styles.forumHeader}>
          <h2 id="forum-title">Community forum</h2>
          <a className={folio.button} href="https://forum.humanstudy-hub.com/">
            Open the forum <ArrowRight />
          </a>
        </div>
        <a className={styles.previewLink} href="https://forum.humanstudy-hub.com/" aria-label="Open the HumanStudy Forum from its preview">
          <Image
            src="/images/forum-discussions.webp"
            alt="The HumanStudy Forum discussions page, showing recent posts and research categories."
            width={1440}
            height={648}
            sizes="(max-width: 1184px) 100vw, 1088px"
            className={styles.preview}
          />
        </a>
      </section>
    </div>
  );
}
