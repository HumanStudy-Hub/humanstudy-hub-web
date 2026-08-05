import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden bg-[#f8fbfb]">
      <Image
        src="/logo.png"
        alt="Human studies represented as reusable, connected experimental systems"
        fill
        priority
        className="object-cover object-center opacity-72"
      />
      {/* <div className="absolute inset-0 bg-white/35" /> */}
      <main className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl items-end px-6 pb-14 pt-20 sm:px-10 sm:pb-20">
        <div className="max-w-3xl [text-shadow:0_1px_12px_rgba(255,255,255,0.9)]">
          <p className="text-xs font-bold uppercase text-cyan-800">Open infrastructure for human-study research</p>
          <h1 className="mt-3 font-serif text-4xl font-bold leading-tight text-gray-950 sm:text-6xl">HumanStudy-Hub</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-gray-700 sm:text-lg">
            Turn published human studies into reusable datasets and runnable experiments for AI agents.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/dataset" className="bg-cyan-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700">Explore datasets</Link>
            <Link href="/pipeline" className="border border-gray-400 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:border-cyan-700 hover:text-cyan-800">Build a study</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
