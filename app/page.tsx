import PartnerUniversities from "@/components/PartnerUniversities";
import DesktopPreview from "@/components/DesktopPreview";
import ResearchScene from "@/components/ResearchScene";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.home}>
      <header className={styles.opening}>
        <h1 className={styles.title}>
          Open infrastructure for <em>human-study research</em>
        </h1>
        <p className={styles.introduction}>
          Turn human studies into programs you and others can run, reuse and build on
        </p>
      </header>

      <ResearchScene />

      <section className={styles.workspace} aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">From paper to protocol</h2>
        <DesktopPreview />
      </section>

      <section className={styles.community} aria-labelledby="community-heading">
        <h2 id="community-heading">Used by researchers at</h2>
        <PartnerUniversities label="Institutions of researchers who use HumanStudy-Hub" />
      </section>
    </div>
  );
}
