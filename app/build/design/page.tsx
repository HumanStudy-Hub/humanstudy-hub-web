import DesignReview from '@/components/studio/design-review';
import { programView } from '@/lib/studio/program-views';

export const metadata = { title: 'Human Program · Design review', robots: { index: false, follow: false } };

export default async function ProgramDesignPage({ searchParams }: { searchParams: Promise<{ view?: string; case?: string }> }) {
  const params = await searchParams;
  return <DesignReview initialView={programView(params.view)} initialCase={params.case}/>;
}
