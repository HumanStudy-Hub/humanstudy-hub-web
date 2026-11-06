import styles from "@/components/folio-page.module.css";

export default function CitationPage() {
  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <h1>Citation</h1>
      <p className={styles.lede}>Citation content will appear here.</p>
    </div>
  );
}
