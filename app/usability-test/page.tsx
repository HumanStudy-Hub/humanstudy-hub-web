import type { Metadata } from "next";
import UsabilityTestStudio from "@/components/UsabilityTestStudio";
import { getStudies } from "@/lib/studies";

export const metadata: Metadata = {
  title: "Usability Test | HumanStudy-Hub",
  description: "A study-testing workspace with prepared extraction results for the 12 benchmark papers.",
};

export default async function UsabilityTestPage() {
  const studies = (await getStudies())
    .filter((study) => /^study_0(0[1-9]|1[0-2])$/.test(study.study_id))
    .map(({ study_id, title, authors, year }) => ({ study_id, title, authors, year }));

  return <UsabilityTestStudio studies={studies} />;
}
