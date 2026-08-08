import type { Metadata } from "next";
import Link from "next/link";
import ContributeUploadForm from "@/components/ContributeUploadForm";

export const metadata: Metadata = {
  title: "Contribute a study package | HumanStudy-Hub",
  description: "Upload an existing HumanStudy-Bench study package and open a contribution pull request.",
};

export default function ContributePage() {
  return (
    <div className="min-h-screen bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-12 sm:px-8 sm:py-16">
          <p className="text-xs font-bold uppercase text-cyan-800">HumanStudy-Bench</p>
          <h1 className="mt-3 font-serif text-4xl font-bold text-gray-950 sm:text-5xl">Contribute a study package</h1>
          <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
            Already have a study package? Upload the ZIP and we will validate it and open a pull request against the benchmark on your behalf.
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-gray-500">
            Starting from a published paper instead? The{" "}
            <Link href="/pipeline" className="font-semibold text-cyan-700 hover:underline">Study Builder</Link>{" "}
            extracts the study for you and produces a package you can download and review.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10 sm:px-8">
        <section className="border border-gray-200 bg-white p-6 shadow-sm">
          <ContributeUploadForm />
        </section>
        <p className="mt-6 text-sm text-gray-500">
          Prefer to open the pull request yourself?{" "}
          <a href="https://github.com/HumanStudy-Hub/HumanStudy-Bench/blob/main/docs/submit_study.md" target="_blank" rel="noopener noreferrer" className="font-semibold text-cyan-700 hover:underline">
            Contribute manually on GitHub
          </a>
          .
        </p>
      </main>
    </div>
  );
}
