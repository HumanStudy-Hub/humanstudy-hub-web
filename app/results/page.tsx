import EffectSizePlot from "@/components/EffectSizePlot";
import LeaderboardTable from "@/components/LeaderboardTable";
import styles from "@/components/folio-page.module.css";

export default function ResultsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Human findings.<br />Agent behavior.</h1>
        <p className={styles.lede}>See how AI agents reproduce human behavioral effects.</p>
      </header>
      <section className={styles.split}>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-4">
            <h2>Effect consistency</h2>
            <span className="text-xs text-[var(--site-muted)]">Illustrative model results</span>
          </div>
          <div className={styles.chart}><EffectSizePlot /></div>
        </div>
        <aside className={styles.note}>
          <h2>Read with the study.</h2>
          <p>Use the same materials and measures when comparing human findings with agent responses.</p>
          <a href="https://arxiv.org/abs/2602.00685" target="_blank" rel="noopener noreferrer">
            Read the HumanStudy-Bench paper →
          </a>
        </aside>
      </section>
      <LeaderboardTable />
    </div>
  );
}
