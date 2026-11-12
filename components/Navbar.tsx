"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { KeyboardEvent, MouseEventHandler } from "react";
import { isStudioEditorRoute } from "@/lib/studio/editor-route";
import SiteLogo from "@/components/SiteLogo";
import styles from "./site-chrome.module.css";

const links = [
  { name: "Blog", href: "/blog" },
  { name: "Study Library", href: "/studies" },
  { name: "Desktop app", href: "/download" },
  { name: "Benchmark", href: "/results" },
  { name: "Partnerships", href: "/collaboration" },
  { name: "Account", href: "/account" },
] as const;

function NavigationLinks({
  pathname,
  onSelect,
}: {
  pathname: string;
  onSelect?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return links.map((link) => {
    const active = pathname === link.href || pathname.startsWith(`${link.href}/`);

    return (
      <li key={link.href}>
        <Link
          href={link.href}
          className={styles.navigationLink}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
        >
          {link.name}
        </Link>
      </li>
    );
  });
}

const closeMobileMenu: MouseEventHandler<HTMLAnchorElement> = (event) => {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
};

function dismissMobileMenu(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape") return;
  event.currentTarget.open = false;
  event.currentTarget.querySelector("summary")?.focus();
}

export default function Navbar() {
  const pathname = usePathname();
  if (isStudioEditorRoute(pathname)) return null;

  return (
    <nav aria-label="Main navigation" data-site-navigation className={styles.navbar}>
      <div className={styles.navbarInner}>
        <Link href="/" className={styles.brand} aria-label="HumanStudy-Hub home">
          <SiteLogo />
          <span>HumanStudy-Hub</span>
        </Link>
        <ul className={styles.desktopLinks}>
          <NavigationLinks pathname={pathname} />
        </ul>
        <details className={styles.mobileMenu} onKeyDown={dismissMobileMenu}>
          <summary className={styles.menuToggle}>
            Menu
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </summary>
          <ul className={styles.mobileLinks}>
            <NavigationLinks pathname={pathname} onSelect={closeMobileMenu} />
          </ul>
        </details>
      </div>
    </nav>
  );
}
