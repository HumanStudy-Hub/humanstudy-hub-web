import type { Metadata } from 'next';
import Account from '@/components/studio/account';
import { accountReturnTo } from '@/lib/studio/auth-policy';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Account · HumanStudy Hub', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <Account returnTo={accountReturnTo(params.returnTo)} logout={params.action === 'logout'} />;
}
