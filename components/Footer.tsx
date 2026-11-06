"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isStudioEditorRoute } from "@/lib/studio/editor-route";
import styles from "./site-chrome.module.css";

export default function Footer() {
  if (isStudioEditorRoute(usePathname())) return null;
  return (
    <footer className={styles.footer} data-site-footer>
      <div className={styles.footerInner}>
        <p>
          &copy; 2026 HumanStudy-Hub Team. All rights reserved.
        </p>
        <nav aria-label="Footer navigation" className={styles.footerLinks}>
          <Link href="/forum">Forum</Link>
          <Link href="/download">Desktop app</Link>
          <Link href="/collaboration">Contact</Link>
        </nav>
      </div>
    </footer>
  );
}
