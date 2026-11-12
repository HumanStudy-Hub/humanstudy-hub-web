import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import folio from "@/components/folio-page.module.css";
import { forumPosts, forumPostUrl, readForumPost } from "@/lib/forum-posts";
import styles from "../page.module.css";

type ForumPostProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: ForumPostProps): Promise<Metadata> {
  const { slug } = await params;
  const post = forumPosts.find(entry => entry.slug === slug);
  return post ? {
    title: `${post.title} | HumanStudy Hub`,
    description: post.description,
    alternates: { canonical: forumPostUrl(post) },
  } : {};
}

export default async function ForumPostPage({ params }: ForumPostProps) {
  const { slug } = await params;
  const post = forumPosts.find(entry => entry.slug === slug);
  if (!post) notFound();

  const source = forumPostUrl(post);
  const markdown = await readForumPost(post);
  return (
    <article className={`${folio.page} ${folio.narrow}`}>
      <header className={folio.heading}>
        <Link href="/forum" className={folio.back}>← Forum</Link>
        <h1>{post.title}</h1>
        <p className={styles.byline}>{post.author} · <time dateTime={post.date}>{post.dateLabel}</time></p>
      </header>
      {markdown ? (
        <div className={`prose ${styles.articleBody}`}>
          <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => {
            const safe = defaultUrlTransform(url);
            if (!safe || safe.startsWith("#")) return safe;
            try {
              const absolute = new URL(safe, source);
              return (absolute.protocol === "https:" || absolute.protocol === "mailto:")
                && !absolute.username && !absolute.password ? absolute.href : "";
            } catch {
              return "";
            }
          }}>
            {markdown}
          </Markdown>
        </div>
      ) : <p>The post could not be loaded here. You can read it on the HumanStudy Forum.</p>}
      <footer className={styles.articleSources}>
        <a href={source}>Original post and discussion on the HumanStudy Forum</a>
      </footer>
    </article>
  );
}
