import CollaborationMap from "@/components/CollaborationMap";
import styles from "@/components/folio-page.module.css";

export default function CollaborationPage() {
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Research, together.</h1>
        <p className={styles.lede}>
          We partner with researchers and institutions worldwide to develop AI tools for social science. For research partnerships, institutional support or sponsorship, contact{" "}
          <a href="mailto:xul049@ucsd.edu" className="text-[var(--site-accent)] underline underline-offset-4">xul049@ucsd.edu</a>.
        </p>
      </header>
      <section className={styles.section} aria-labelledby="collaborators-title">
        <h2 id="collaborators-title">Our research community</h2>
        <CollaborationMap />
      </section>
    </div>
  );
}
