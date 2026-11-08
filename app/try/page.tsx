import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireStudioUser } from "@/lib/studio/auth";
import { accountPath } from "@/lib/studio/auth-policy";
import { hasAccess, TRY_ACCESS_COOKIE } from "@/lib/try-online";
import TryLauncher from "./launcher";

export const metadata: Metadata = {
  title: "Try online | HumanStudy-Hub",
  description: "Use the HumanStudy Hub desktop app in your browser, with no installation.",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function TryPage() {
  let userId: string;
  try {
    userId = (await requireStudioUser()).user.id;
  } catch {
    redirect(accountPath("https://humanstudy-hub.com/try"));
  }
  const needsCode = !hasAccess(userId, (await cookies()).get(TRY_ACCESS_COOKIE)?.value);
  return <TryLauncher needsCode={needsCode} />;
}
