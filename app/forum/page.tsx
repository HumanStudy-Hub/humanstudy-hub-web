import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import folio from "@/components/folio-page.module.css";
import { forumPosts } from "@/lib/forum-posts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Forum | HumanStudy Hub",
  description: "Discuss human behavior, research methods, and AI with the HumanStudy community.",
  alternates: { canonical: "/forum" },
};

export default function ForumPage() {
  return (
    <div className={folio.page}>
      <section aria-labelledby="forum-title">
        <header className={styles.forumHeader}>
          <div>
            <h1 id="forum-title">Community forum</h1>
            <p className={folio.lede}>Ask questions, share findings, and discuss human behavior, research methods, and AI.</p>
          </div>
          <a className={folio.button} href="https://forum.humanstudy-hub.com/">
            Open the forum <ArrowRight />
          </a>
        </header>
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

      <section aria-labelledby="featured-title" className={folio.section}>
        <h2 id="featured-title">Featured posts</h2>
        <div className={styles.articles}>
          {forumPosts.map(post => (
            <article key={post.slug} className={styles.article}>
              <h3><Link href={`/forum/${post.slug}`}>{post.title} <ArrowRight /></Link></h3>
              <p className={styles.byline}>{post.author} · <time dateTime={post.date}>{post.dateLabel}</time></p>
              <p className={styles.description}>{post.description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
