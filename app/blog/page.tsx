import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import folio from "@/components/folio-page.module.css";
import { blogArticles } from "@/lib/blog";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Blog | HumanStudy Hub",
  description: "Research notes on reproducible human studies and agent behavior from HumanStudy Hub.",
};

export default function BlogPage() {
  return (
    <div className={folio.page}>
      <header className={folio.heading}>
        <h1>Blog</h1>
        <p className={folio.lede}>Ideas, methods, and updates from HumanStudy Hub and our collaborators.</p>
      </header>

      <section aria-label="Research articles" className={styles.articles}>
        {blogArticles.map(article => (
          <article key={article.slug} className={styles.article}>
            <p className={styles.byline}>
              HumanStudy Hub Team
            </p>
            <h2>
              <Link href={`/blog/${article.slug}`}>
                {article.title} <ArrowRight />
              </Link>
            </h2>
            <p className={styles.description}>{article.description}</p>
          </article>
        ))}
      </section>

      <section className={folio.section} aria-labelledby="forum-title">
        <div className={styles.forumHeader}>
          <div>
            <h2 id="forum-title">Community forum</h2>
            <p className={styles.description}>A meeting place for social scientists, AI researchers, and builders. Ask questions, share findings, and discuss human behavior, research methods, and AI. There is room for disagreement and careful replication.</p>
          </div>
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
