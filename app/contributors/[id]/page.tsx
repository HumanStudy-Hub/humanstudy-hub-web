import Link from "next/link";
import { notFound } from "next/navigation";
import CreditPagination from "@/components/CreditPagination";
import CommunityCreditList from "@/components/CommunityCreditList";
import styles from "@/components/folio-page.module.css";
import { CREDIT_PAGE_SIZE, creditPage, getContributor, listCredits, UUID } from "@/lib/community-credit";

export const dynamic = "force-dynamic";

export default async function ContributorProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const page = creditPage((await searchParams).page);
  const profile = await Promise.all([getContributor(id), listCredits({ by: "profile", id }, page)]).catch(() => null);
  if (!profile) return <div className={styles.page}>
    <Link href="/community?view=contributors" className={styles.back}>← Contributors</Link>
    <h1>Contributor profile</h1>
    <p className="mt-4 text-sm text-[var(--site-muted)]">This contributor profile is temporarily unavailable.</p>
  </div>;
  const [person, entries] = profile;
  if (!person) notFound();
  return <div className={styles.page}>
    <Link href="/community?view=contributors" className={styles.back}>← Contributors</Link>
    <header className={styles.heading}>
      <h1>{person.display_name}</h1>
      <p className={styles.lede}>{person.helpful} helpful {person.helpful === 1 ? "vote" : "votes"} received · {person.contributions} accepted</p>
    </header>
    <section className={styles.section}>
      <h2>Accepted contributions</h2>
      <CommunityCreditList entries={entries.slice(0, CREDIT_PAGE_SIZE)} allowVote />
      <CreditPagination page={page} hasNext={entries.length > CREDIT_PAGE_SIZE} base={`/contributors/${id}?page=`} />
    </section>
  </div>;
}
