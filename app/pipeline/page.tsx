import type { Metadata } from "next";
import PipelineStudio from "@/components/PipelineStudio";
import WorkspaceChoice from "@/components/WorkspaceChoice";

export const metadata: Metadata = {
  title: "Study Builder | HumanStudy-Hub",
  description: "Turn a paper and its research materials into a reviewable, runnable study.",
};

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  if (mode === "existing") return <PipelineStudio />;
  return <WorkspaceChoice title="What are you building from?" description="Published studies and new study ideas need different evidence, review, and outputs. Choose the starting point that matches your work." choices={[
    { href: "/pipeline?mode=existing", eyebrow: "Paper to runnable study", title: "Build an existing study", description: "Convert a published study into a reviewed package for agent experiments and, when appropriate, benchmark contribution.", steps: ["Check study eligibility", "Upload the paper and open materials", "Review and export the runnable package"], action: "Build from a paper" },
    { href: "/playground?mode=prototype", eyebrow: "Idea to protocol", title: "Prototype a new study", description: "Start without published human results. Shape the design, test whether agents understand it, and save a report for further iteration.", steps: ["Describe your research idea", "Get structured design feedback", "Preview synthetic responses"], action: "Open prototype workspace" },
  ]} />;
}
