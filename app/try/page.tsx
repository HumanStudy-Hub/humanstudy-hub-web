import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStudioUser } from "@/lib/studio/auth";
import { accountPath } from "@/lib/studio/auth-policy";
import TryLauncher from "./launcher";

export const metadata: Metadata = {
  title: "Try online | HumanStudy-Hub",
  description: "Use the HumanStudy Hub desktop app in your browser, with no installation.",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function TryPage() {
  try {
    await requireStudioUser();
  } catch {
    redirect(accountPath("https://humanstudy-hub.com/try"));
  }
  return <TryLauncher />;
}
