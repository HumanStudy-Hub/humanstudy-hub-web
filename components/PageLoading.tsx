import styles from "@/components/folio-page.module.css";

export default function PageLoading() {
  return (
    <div className={styles.page} role="status" aria-live="polite">
      <h1>Loading…</h1>
      <p className={styles.lede}>Preparing this page.</p>
    </div>
  );
}
