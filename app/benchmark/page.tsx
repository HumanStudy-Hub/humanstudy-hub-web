import fs from "fs";
import path from "path";
import ReactMarkdown from "react-markdown";
import styles from "@/components/folio-page.module.css";

export default function BenchmarkPage() {
  const filePath = path.join(process.cwd(), "content/benchmark.md");
  const content = fs.readFileSync(filePath, "utf-8");

  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <header className={styles.heading}>
        <h1>Benchmark overview</h1>
      </header>
      <article className={`prose ${styles.markdown}`}>
        <ReactMarkdown>{content}</ReactMarkdown>
      </article>
    </div>
  );
}
