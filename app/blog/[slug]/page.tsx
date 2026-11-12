import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import folio from "@/components/folio-page.module.css";
import { blogArticles } from "@/lib/blog";
import styles from "../page.module.css";

type BlogPageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return blogArticles.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: BlogPageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = blogArticles.find(entry => entry.slug === slug);
  return article ? { title: `${article.title} | HumanStudy Hub`, description: article.description } : {};
}

export default async function BlogArticlePage({ params }: BlogPageProps) {
  const { slug } = await params;
  const article = blogArticles.find(entry => entry.slug === slug);
  if (!article) notFound();

  return (
    <article className={`${folio.page} ${folio.narrow}`}>
      <header className={folio.heading}>
        <Link href="/blog" className={folio.back}>← Blog</Link>
        <h1>{article.title}</h1>
        <p className={styles.byline}>
          HumanStudy Hub Team
        </p>
      </header>
      <div className={styles.articleBody}>
        {article.sections.map(section => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          </section>
        ))}
      </div>
      <footer className={styles.articleSources}>
        <p>Adapted from <a href={article.source.url}>Xuan Liu’s original article</a>, published <time dateTime={article.source.date}>{article.source.dateLabel}</time>.</p>
        {article.furtherReading && <p>Further reading <a href={article.furtherReading.url}>{article.furtherReading.title}</a></p>}
      </footer>
    </article>
  );
}
