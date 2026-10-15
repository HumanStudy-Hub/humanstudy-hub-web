import { redirect } from "next/navigation";
import type { Metadata } from "next";
import PipelineStudio from "@/components/PipelineStudio";
import WorkspaceChoice from "@/components/WorkspaceChoice";

export const metadata: Metadata = {
  title: "Study Builder | HumanStudy-Hub",
  description: "Turn a paper and its research materials into a reviewable, runnable study.",
};

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ mode?: string; job?: string; legacy?: string }> }) {
  const { mode, job, legacy } = await searchParams;
  if (job || legacy === "1") return <PipelineStudio />;
  if (mode === "existing") redirect("/download");
  return <WorkspaceChoice title="What are you building from?" description="Published studies and new study ideas need different evidence, review, and outputs. Choose the starting point that matches your work." choices={[
    { href: "/download", eyebrow: "Paper to study document", title: "Build an existing study", description: "Use the HumanStudy Hub desktop app to reconstruct a published study from its paper and check each item against the PDF.", steps: ["Open the paper in the desktop app", "Review what the paper does and does not state", "Chart the design and run simulated participants"], action: "Get the desktop app" },
    { href: "/playground?mode=prototype", eyebrow: "Idea to protocol", title: "Prototype a new study", description: "Start without published human results. Shape the design, test whether agents understand it, and save a report for further iteration.", steps: ["Describe your research idea", "Get structured design feedback", "Preview synthetic responses"], action: "Open prototype workspace" },
  ]} />;
}
