import Link from "next/link";

export default function CreditPagination({ page, hasNext, base, anchor = "" }: {
  page: number; hasNext: boolean; base: string; anchor?: string;
}) {
  if (page === 1 && !hasNext) return null;
  return <nav aria-label="Contribution pages" className="flex gap-4 pt-4 text-sm text-[var(--site-accent)] underline">
    {page > 1 && <Link href={`${base}${page - 1}${anchor}`}>Previous contributions</Link>}
    {hasNext && <Link href={`${base}${page + 1}${anchor}`}>Next contributions</Link>}
  </nav>;
}
