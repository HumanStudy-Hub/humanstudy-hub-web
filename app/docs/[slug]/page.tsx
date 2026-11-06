import { promises as fs } from "fs";
import path from "path";
import { notFound } from "next/navigation";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import styles from "@/components/folio-page.module.css";

const DOCS_DIR = path.join(process.cwd(), "..", "docs");

const docsMeta: Record<
  string,
  { title: string; description: string; order: number }
> = {
  what_to_submit: {
    title: "What Should I Submit?",
    description: "The big picture — what goes in a study folder",
    order: 1,
  },
  extract_from_paper: {
    title: "How to Extract Data from a Paper",
    description: "Turn a PDF into structured, replicable data",
    order: 2,
  },
  build_study_files: {
    title: "How to Build Your Study Files",
    description: "Schemas, code, and contracts for every file",
    order: 3,
  },
  submit_study: {
    title: "How to Submit Your Study",
    description: "Fork, verify, push, and ship it",
    order: 4,
  },
};

const CALLOUT_ICONS = {
  tip: '<svg class="callout-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" /></svg>',
  info: '<svg class="callout-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>',
  warning: '<svg class="callout-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>',
  note: '<svg class="callout-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>',
};

function stripAdmonitions(md: string): string {
  return md.replace(
    /^!!! (\w+)(?: "([^"]*)")?\n((?:    .*\n?)*)/gm,
    (_match, type, title, body) => {
      const content = body.replace(/^    /gm, "").trim();
      const normalizedType = type === "note" ? "info" : type;
      const label = title || type.charAt(0).toUpperCase() + type.slice(1);
      const icon =
        CALLOUT_ICONS[normalizedType as keyof typeof CALLOUT_ICONS] ||
        CALLOUT_ICONS.info;
      
      return `\n<div class="callout callout-${normalizedType}">\n<span class="callout-icon" aria-hidden="true">${icon}</span>\n<div class="callout-body">\n<strong>${label}</strong>\n\n${content}\n\n</div>\n</div>\n\n`;
    }
  );
}

function fixInternalLinks(md: string): string {
  return md.replace(
    /\[([^\]]+)\]\((?!https?:\/\/)([a-z_]+)\.md(?:#([a-z_-]+))?\)/g,
    (_match, text, slug, anchor) => {
      const href = anchor ? `/docs/${slug}#${anchor}` : `/docs/${slug}`;
      return `[${text}](${href})`;
    }
  );
}

export async function generateStaticParams() {
  return Object.keys(docsMeta).map((slug) => ({ slug }));
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const meta = docsMeta[slug];
  if (!meta) notFound();

  let content = "";
  try {
    const raw = await fs.readFile(path.join(DOCS_DIR, `${slug}.md`), "utf8");
    const withoutH1 = raw.replace(/^# .+\n/, "");
    content = fixInternalLinks(stripAdmonitions(withoutH1));
  } catch {
    notFound();
  }

  const allDocs = Object.entries(docsMeta).sort((a, b) => a[1].order - b[1].order);
  const currentIdx = allDocs.findIndex(([s]) => s === slug);
  const prev = currentIdx > 0 ? allDocs[currentIdx - 1] : null;
  const next =
    currentIdx < allDocs.length - 1 ? allDocs[currentIdx + 1] : null;

  return (
    <div className={`${styles.page} ${styles.docs}`}>
      <aside className={styles.sidebar}>
        <p>Contributor Tutorial</p>
        <nav aria-label="Contributor guides">
          {allDocs.map(([docSlug, doc]) => (
            <Link
              key={docSlug}
              href={`/docs/${docSlug}`}
              aria-current={docSlug === slug ? "page" : undefined}
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <Link href="/contribute#documentation" className={styles.back}>← Contribute</Link>
        <header className={styles.heading}>
          <h1>{meta.title}</h1>
          <p className={styles.lede}>{meta.description}</p>
        </header>
        <article className={`prose ${styles.markdown}`}>
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight, rehypeRaw]}>
            {content}
          </Markdown>
        </article>
        <nav aria-label="Guide pages" className={styles.pagination}>
          {prev ? <Link href={`/docs/${prev[0]}`}>← {prev[1].title}</Link> : <span />}
          {next && <Link href={`/docs/${next[0]}`}>{next[1].title} →</Link>}
        </nav>
      </div>
    </div>
  );
}
