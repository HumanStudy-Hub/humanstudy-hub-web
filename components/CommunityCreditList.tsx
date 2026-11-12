import Link from "next/link";
import type { CommunityCredit } from "@/lib/community-credit";
import HelpfulVote from "./HelpfulVote";

export default function CommunityCreditList({ entries, showPaper = true, allowVote = false, preview = false }: {
  entries: CommunityCredit[]; showPaper?: boolean; allowVote?: boolean; preview?: boolean;
}) {
  return <ul className="divide-y divide-[var(--site-line)]">
    {entries.map(entry => <li key={entry.id} className="space-y-1 py-4">
      {showPaper && <Link href={preview ? "#paper-credit" : `/studies/${entry.paper_id}`} className="font-medium text-[var(--site-accent)] underline">{entry.paper_title}</Link>}
      <p className="text-sm">
        Contributed by <Link href={preview ? "#contributor" : `/contributors/${entry.contributor_id}`} className="text-[var(--site-accent)] underline">{entry.display_name}</Link>
        <span className="text-[var(--site-muted)]"> · User submitted</span>
      </p>
      {!preview && <a href={`https://github.com/HumanStudy-Hub/HumanStudy-Bench/tree/main/community/${entry.paper_id}/revisions/${entry.revision}`}
        className="text-sm text-[var(--site-accent)] underline">View accepted revision</a>}
      {allowVote ? <HelpfulVote id={entry.id} revision={entry.revision} count={entry.helpful} preview={preview} />
        : <p className="text-sm text-[var(--site-muted)]">{entry.helpful} helpful</p>}
    </li>)}
  </ul>;
}
