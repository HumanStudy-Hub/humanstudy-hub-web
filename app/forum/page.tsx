import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Forum | HumanStudy-Hub",
  description: "A place to discuss human studies and connect with other researchers. Opening soon.",
};

export default function ForumPage() {
  return (
    <div className="min-h-[70vh] bg-[#f7f9fa]">
      <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8">
        <p className="text-xs font-bold uppercase text-cyan-800">HumanStudy-Hub community</p>
        <h1 className="mt-3 font-serif text-4xl font-bold text-gray-950">Forum</h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-gray-600">
          A place to discuss human studies, share questions, and connect with other researchers.
        </p>
        <div className="mt-10 border border-gray-200 bg-white p-6 sm:p-8">
          <h2 className="font-serif text-xl font-bold text-gray-950">Opening soon</h2>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            The forum is being prepared. Posting and discussions are not available yet.
            In the meantime, explore the study library or learn about the desktop app.
          </p>
          <div className="mt-6 flex flex-wrap gap-4 text-sm font-semibold text-cyan-800">
            <Link href="/dataset" className="hover:underline">Explore studies →</Link>
            <Link href="/download" className="hover:underline">Get the desktop app →</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
