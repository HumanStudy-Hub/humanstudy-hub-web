import type { Metadata } from "next";
import ResetPassword from "@/components/studio/reset-password";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Reset password · HumanStudy Hub",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const changeMode = params.mode === "change";
  const tokenHash = typeof params.token_hash === "string" && /^[a-f0-9]{40,128}$/i.test(params.token_hash) ? params.token_hash : undefined;
  const invalid = Boolean(params.token_hash && !tokenHash) || Boolean(tokenHash && params.type !== "recovery") || Boolean(params.error || params.error_code);
  return <ResetPassword tokenHash={invalid ? undefined : tokenHash} invalid={invalid} changeMode={changeMode} />;
}
