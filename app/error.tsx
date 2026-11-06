"use client";

import Link from "next/link";
import styles from "@/components/folio-page.module.css";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className={`${styles.page} ${styles.narrow}`} role="alert">
      <h1>This page could not load.</h1>
      <p className={styles.lede}>Try again, or return to the study library.</p>
      <div className={styles.actions}>
        <button type="button" onClick={reset} className={styles.button}>Try again</button>
        <Link href="/studies">Explore studies</Link>
      </div>
    </div>
  );
}
