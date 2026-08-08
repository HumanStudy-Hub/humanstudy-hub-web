import PlaygroundStudio, { type StudyOption } from "@/components/PlaygroundStudio";
import { getStudies } from "@/lib/studies";

export const metadata = {
  title: "Playground — HumanStudy-Hub",
  description: "Run an AI agent through a published human study and compare it against the original participants.",
};

export default async function PlaygroundPage() {
  const studies = await getStudies();
  const options: StudyOption[] = studies.map((study) => ({
    study_id: study.study_id,
    title: study.title,
    year: study.year,
  }));

  return <PlaygroundStudio studies={options} />;
}
