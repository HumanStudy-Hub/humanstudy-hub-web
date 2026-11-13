import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireStudioUser } from "@/lib/studio/auth";
import { hasAccess, TRY_ACCESS_COOKIE } from "@/lib/try-online";
import { trySettings } from "@/lib/try-online-config";
import { paperWorkspace, paperWorkspaceSignIn } from "@/lib/paper-workspace";
import { getResearchPaper } from "@/lib/research";
import styles from "@/components/folio-page.module.css";
import TryLauncher from "./launcher";

export const metadata: Metadata = {
  title: "HumanStudy Hub online",
  description: "Open HumanStudy Hub in your browser.",
  robots: { index: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function TryPage({ searchParams }: { searchParams: Promise<{ paper?: string; revision?: string; intent?: string }> }) {
  const params = await searchParams;
  const target = paperWorkspace(params);
  const paper = target ? await getResearchPaper(target.paper) : null;
  if ((params.paper || params.revision || params.intent) && (!target || !paper || paper.currentRevision !== target.revision)) {
    return <div className={`${styles.page} ${styles.narrow}`}>
      <h1>This paper version is unavailable</h1>
      <p className={styles.lede}>Return to the library to open the current published version. Your projects have not changed.</p>
      <Link href={paper ? `/studies/${paper.id}` : "/studies"}>Back to the paper library</Link>
    </div>;
  }
  const config = trySettings();
  if (!config) return <div className={`${styles.page} ${styles.narrow}`}>
    <h1>HumanStudy Hub online</h1>
    <p className={styles.lede}>Online workspaces are unavailable on this deployment.</p>
    <Link href="/download" className={styles.back}>Get the desktop app</Link>
  </div>;
  let userId: string;
  try {
    userId = (await requireStudioUser()).user.id;
  } catch {
    redirect(paperWorkspaceSignIn(target));
  }
  const needsCode = !hasAccess(userId, (await cookies()).get(TRY_ACCESS_COOKIE)?.value);
  return <TryLauncher needsCode={needsCode} sessionMinutes={config.sessionMinutes} target={target} paperTitle={paper?.title} />;
}
