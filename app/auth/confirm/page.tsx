import type { Metadata } from "next";
import ConfirmEmail from "@/components/studio/confirm-email";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Confirm email · HumanStudy Hub",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ConfirmEmailPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tokenHash = typeof params.token_hash === "string" && /^[a-f0-9]{40,128}$/i.test(params.token_hash) ? params.token_hash : undefined;
  const invalid = Boolean(params.token_hash && !tokenHash) || Boolean(tokenHash && params.type !== "email") || Boolean(params.error || params.error_code);
  return <ConfirmEmail tokenHash={invalid ? undefined : tokenHash} invalid={invalid} />;
}
