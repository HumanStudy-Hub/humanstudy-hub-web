import type { Metadata } from "next";
import PipelineStudio from "@/components/PipelineStudio";

export const metadata: Metadata = {
  title: "Study Builder | HumanStudy-Hub",
  description: "Turn a paper and its research materials into a reviewable, runnable study.",
};

export default function PipelinePage() {
  return <PipelineStudio />;
}
