import Link from "next/link";
import styles from "./folio-page.module.css";

type Choice = {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  steps: string[];
  action: string;
};

export default function WorkspaceChoice({ title, description, choices }: { title: string; description: string; choices: Choice[] }) {
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>{title}</h1>
        <p className={styles.lede}>{description}</p>
      </header>
      <div className="grid max-w-4xl gap-8">
        {choices.map((choice, index) => (
          <section key={choice.href} className="flex flex-col border-t border-[var(--site-line)] py-8">
            <p className="text-xs font-semibold uppercase text-[var(--site-accent)]">{choice.eyebrow}</p>
            <h2 className="mt-3 font-serif text-2xl font-bold text-[var(--foreground)]">{choice.title}</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--site-muted)]">{choice.description}</p>
            <ol className="mt-6 flex-1 space-y-3 border-l border-[var(--site-line)]">
              {choice.steps.map((step, stepIndex) => (
                <li key={step} className="relative pl-6 text-sm leading-6 text-[var(--site-muted)]">
                  <span className="absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--site-line)] bg-[var(--background)] text-[11px] font-bold text-[var(--foreground)]">{stepIndex + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <Link href={choice.href} className={`mt-7 inline-flex h-10 items-center justify-center px-5 text-sm font-semibold ${index === 0 ? "bg-[var(--site-accent)] text-white hover:bg-[var(--site-accent)]" : "border border-[var(--site-line)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--site-accent)] hover:text-[var(--site-accent)]"}`}>{choice.action}</Link>
          </section>
        ))}
      </div>
    </div>
  );
}
