import Link from "next/link";
import styles from "@/components/folio-page.module.css";

export default function NotFound() {
  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <h1>Page not found.</h1>
      <p className={styles.lede}>This page is unavailable. Return to the library to explore published studies.</p>
      <div className={styles.actions}>
        <Link href="/studies" className={styles.button}>Explore studies →</Link>
        <Link href="/">Back to home</Link>
      </div>
    </div>
  );
}
