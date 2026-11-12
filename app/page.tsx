import Image from "next/image";
import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import styles from "./page.module.css";

const actions = [
  { href: "/download", label: "Get the desktop app" },
  { href: "/forum", label: "Join the forum" },
  { href: "/collaboration", label: "Work with us" },
  { href: "/studies", label: "Explore studies" },
] as const;

export default function Home() {
  return (
    <div className={styles.home}>
      <section className={styles.opening} aria-labelledby="home-title">
        <h1 id="home-title" className={styles.title}>
          Open infrastructure for <em>human-study research</em>
        </h1>
        <p className={styles.introduction}>
          Turn published human studies into executable programs that others can reuse and build upon.
        </p>
        <nav className={styles.actions} aria-label="Explore HumanStudy Hub">
          {actions.map((action) => (
            <Link href={action.href} prefetch={action.href === "/forum" ? false : undefined} className={styles.textLink} key={action.href}>
              {action.label} <ArrowRight />
            </Link>
          ))}
        </nav>
      </section>

      <figure className={styles.cover}>
        <Image
          src="/images/folio-bridge.jpg"
          alt="A paper bridge connects researchers with study materials, charts and participant figures."
          width={1774}
          height={887}
          sizes="(max-width: 1280px) 100vw, 1280px"
          priority
          className={styles.coverImage}
        />
      </figure>

    </div>
  );
}
