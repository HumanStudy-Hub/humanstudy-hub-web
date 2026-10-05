import type { Metadata } from "next";
import BuildWorkspace from "./workspace";

export const metadata: Metadata = {
  title: "Build Study · Workspace Preview | HumanStudy-Hub",
  icons: { icon: "/build-preview/human-study-hub.svg" },
  robots: { index: false, follow: false },
};

export default function BuildPreviewPage() {
  return <BuildWorkspace />;
}
