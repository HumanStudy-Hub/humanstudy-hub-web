import Link from "next/link";
import type { CommunityCredit } from "@/lib/community-credit";
import HelpfulVote from "./HelpfulVote";

export default function CommunityCreditList({ entries, showPaper = true, allowVote = false, ranked = false }: {
  entries: CommunityCredit[]; showPaper?: boolean; allowVote?: boolean; ranked?: boolean;
}) {
  const List = ranked ? "ol" : "ul";
  return <List className={`divide-y divide-[var(--site-line)]${ranked ? " list-decimal pl-6" : ""}`}>
    {entries.map(entry => <li key={entry.id} className="space-y-1 py-4">
      {showPaper && <Link href={`/studies/${entry.paper_id}`} className="font-medium text-[var(--site-accent)] underline">{entry.paper_title}</Link>}
      <p className="text-sm">
        Contributed by <Link href={`/contributors/${entry.contributor_id}`} className="text-[var(--site-accent)] underline">{entry.display_name}</Link>
        <span className="text-[var(--site-muted)]"> · User submitted</span>
      </p>
      <a href={`https://github.com/HumanStudy-Hub/HumanStudy-Bench/tree/main/community/${entry.paper_id}/revisions/${entry.revision}`}
        className="text-sm text-[var(--site-accent)] underline">View accepted revision</a>
      {allowVote ? <HelpfulVote id={entry.id} revision={entry.revision} count={entry.helpful} />
        : <p className="text-sm text-[var(--site-muted)]">{entry.helpful} helpful</p>}
    </li>)}
  </List>;
}
