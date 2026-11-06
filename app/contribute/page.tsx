import type { Metadata } from "next";
import Link from "next/link";
import ContributeUploadForm from "@/components/ContributeUploadForm";
import styles from "@/components/folio-page.module.css";

export const metadata: Metadata = {
  title: "Contribute a study package | HumanStudy-Hub",
  description: "Upload an existing HumanStudy-Bench study package and open a contribution pull request.",
};

export default function ContributePage() {
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Contribute a study package</h1>
        <p className={styles.lede}>
          Contribute your research files. We check the sources and combine compatible improvements into the paper’s recommended version.
        </p>
        <p className="mt-4 max-w-3xl text-sm leading-6 text-[var(--site-muted)]">
          Starting from a published paper instead? The{" "}
          <Link href="/build" className="font-semibold text-[var(--site-accent)] hover:underline">HumanStudy desktop</Link>{" "}
          builds the study and exports its community contribution with the original source version.
        </p>
      </header>
      <div className={styles.formSheet}>
        <section aria-label="Study contribution">
          <ContributeUploadForm />
        </section>
        <p className="mt-6 text-sm text-[var(--site-muted)]">
          Prefer to open the pull request yourself?{" "}
          <a href="https://github.com/HumanStudy-Hub/HumanStudy-Bench/blob/main/docs/submit_study.md" target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--site-accent)] hover:underline">
            Contribute manually on GitHub
          </a>
          .
        </p>
      </div>
    </div>
  );
}
