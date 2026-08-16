import PlaygroundStudio, { type StudyOption } from "@/components/PlaygroundStudio";
import PrototypeStudio from "@/components/PrototypeStudio";
import WorkspaceChoice from "@/components/WorkspaceChoice";
import { listBufferStudies } from "@/lib/github-jobs";
import { getStudies } from "@/lib/studies";

export const metadata = {
  title: "Playground — HumanStudy-Hub",
  description: "Run an AI agent through a published human study and compare it against the original participants.",
};

export default async function PlaygroundPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  if (mode === "prototype") return <PrototypeStudio />;
  const [studies, buffer] = await Promise.all([
    getStudies(),
    listBufferStudies().catch(() => []),
  ]);
  const options: StudyOption[] = [
    ...buffer.map((entry) => ({
      study_id: entry.studyId,
      title: `${entry.title} · buffer`,
      year: null,
      source: "buffer" as const,
      jobId: entry.jobId,
      packageSlug: entry.packageSlug,
    })),
    ...studies.map((study) => ({
      study_id: study.study_id,
      title: study.title,
      year: study.year,
      source: "benchmark" as const,
    })),
  ];

  if (mode === "reproduce") return <PlaygroundStudio studies={options} />;
  return <WorkspaceChoice title="What do you want to learn?" description="Use a published study when you need a human comparison. Start a new prototype when you are still shaping the research question." choices={[
    { href: "/playground?mode=reproduce", eyebrow: "Published evidence", title: "Reproduce an existing study", description: "Run an agent through a study already available in HumanStudy-Hub and compare its responses with published human findings.", steps: ["Choose a runnable study", "Configure the model and participants", "Review effects and download a report"], action: "Choose an existing study" },
    { href: "/playground?mode=prototype", eyebrow: "Early-stage research", title: "Prototype a new study", description: "Develop an idea with design feedback, then preview how synthetic participants interpret the protocol. No human comparison is implied.", steps: ["Name and describe your idea", "Refine the protocol with the design agent", "Run a synthetic response preview"], action: "Start a new prototype" },
  ]} />;
}
