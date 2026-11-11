import Link from "next/link";
import CommunityCreditList from "@/components/CommunityCreditList";
import styles from "@/components/folio-page.module.css";
import { listContributors, listCredits, type CommunityCredit, type Contributor } from "@/lib/community-credit";

export const dynamic = "force-dynamic";

export default async function CommunityLeaderboard({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const people = (await searchParams).view === "contributors";
  let contributions: CommunityCredit[] = [];
  let contributors: Contributor[] = [];
  let unavailable = false;
  try {
    if (people) contributors = await listContributors();
    else contributions = await listCredits();
  } catch {
    unavailable = true;
  }

  return <div className={styles.page}>
    <header className={styles.heading}>
      <h1>Community leaderboard</h1>
      <p className={styles.lede}>Top 50 study contributions or contributors, ranked by helpful votes.</p>
    </header>
    <nav aria-label="Leaderboard views" className="flex flex-wrap gap-5 text-sm">
      <Link href="/community" aria-current={!people ? "page" : undefined} className="text-[var(--site-accent)] underline">Study contributions</Link>
      <Link href="/community?view=contributors" aria-current={people ? "page" : undefined} className="text-[var(--site-accent)] underline">Contributors</Link>
    </nav>
    <section className={styles.section} aria-label={people ? "Ranked contributors" : "Ranked study contributions"}>
      {unavailable ? <p>Community rankings are temporarily unavailable.</p>
        : people ? contributors.length ? (
          <ol className="list-decimal divide-y divide-[var(--site-line)] pl-6">
            {contributors.map(person => <li key={person.id} className="py-4">
              <Link href={`/contributors/${person.id}`} className="font-medium text-[var(--site-accent)] underline">{person.display_name}</Link>
              <p className="text-sm text-[var(--site-muted)]">{person.helpful} helpful · {person.contributions} accepted</p>
            </li>)}
          </ol>
        ) : <p>No credited contributors yet.</p>
        : contributions.length ? <CommunityCreditList entries={contributions} ranked /> : <p>No accepted contributions yet.</p>}
    </section>
  </div>;
}
