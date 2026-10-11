import DesignReview from '@/components/studio/design-review';

export const metadata = { title: 'Human Program · Design review', robots: { index: false, follow: false } };

export default async function ProgramDesignPage({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  const params = await searchParams;
  return <DesignReview initialCase={params.case}/>;
}
