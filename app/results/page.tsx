import Link from "next/link";
import EffectSizePlot from "@/components/EffectSizePlot";
import LeaderboardTable from "@/components/LeaderboardTable";

export default function ResultsPage() {
  return (
    <div className="min-h-screen bg-[#f7f9fa]">
      <section className="border-b border-cyan-200 bg-cyan-50">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-5 px-6 py-6 sm:px-8">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase text-cyan-800">Playground</p>
            <h2 className="mt-2 font-serif text-2xl font-bold text-gray-950">Run your AI agent on one of these studies</h2>
            <p className="mt-2 text-sm leading-6 text-cyan-950">
              Choose a study and a base model, design the prompt your agent takes into the experiment, and see where it
              matched the original participants and where it did not.
            </p>
          </div>
          <Link href="/playground" className="inline-flex h-10 items-center bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600">Open the playground</Link>
        </div>
      </section>

      <section className="border-b border-gray-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-6 py-10 sm:px-8 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-center lg:py-12">
          <header>
            <p className="text-xs font-bold uppercase text-cyan-800">HumanStudy-Bench</p>
            <h1 className="mt-3 font-serif text-4xl font-bold leading-tight text-gray-950">Agent Evaluations</h1>
            <p className="mt-4 text-base leading-7 text-gray-600">
              See how AI agents reproduce human behavioral effects.
            </p>
            <a href="https://arxiv.org/abs/2602.00685" target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex text-sm font-semibold text-cyan-800 hover:underline">Read the HumanStudy-Bench paper →</a>
          </header>
          <div className="min-w-0 lg:border-l lg:border-gray-200 lg:pl-8">
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <h2 className="font-serif text-lg font-bold text-gray-900">Effect consistency</h2>
              <span className="text-[11px] text-gray-400">Illustrative model results</span>
            </div>
            <div className="h-[400px]"><EffectSizePlot /></div>
          </div>
        </div>
      </section>
      <LeaderboardTable />
    </div>
  );
}
