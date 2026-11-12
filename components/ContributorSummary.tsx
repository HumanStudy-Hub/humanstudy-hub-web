import type { Contributor } from "@/lib/community-credit";
import styles from "@/components/folio-page.module.css";

export default function ContributorSummary({ person, heading = "h1" }: { person: Contributor; heading?: "h1" | "h2" }) {
  const Heading = heading;
  return <header className={styles.heading}>
    <Heading>{person.display_name}</Heading>
    <p className={styles.lede}>{person.helpful} helpful {person.helpful === 1 ? "vote" : "votes"} received · {person.contributions} accepted</p>
  </header>;
}
