import CollaborationMap from "@/components/CollaborationMap";

const institutions = [
  "University of California San Diego",
  "Massachusetts Institute of Technology",
  "Carnegie Mellon University",
  "The University of Hong Kong",
  "IRIDeS, Tohoku University",
];

export default function CollaborationPage() {
  const tickerItems = [...institutions, ...institutions];

  return (
    <div className="min-h-screen bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-12 sm:px-8 sm:py-16">
          <p className="text-xs font-bold uppercase text-cyan-800">HumanStudy-Hub</p>
          <h1 className="mt-3 font-serif text-4xl font-bold text-gray-950 sm:text-5xl">Research Projects</h1>
          <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
            We help social-science teams design and implement the AI components of ongoing research projects.
          </p>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-7xl px-4 pt-6 sm:px-8 sm:pt-10">
          <CollaborationMap />
        </section>

        <div className="partner-ticker border-y border-cyan-200 bg-cyan-50/60">
          <div className="partner-ticker-track">
            {tickerItems.map((institution, index) => (
              <span key={`${institution}-${index}`} className="inline-flex items-center gap-6 whitespace-nowrap text-xs font-semibold text-cyan-800">
                {institution}<span className="h-1 w-1 rounded-full bg-cyan-500" />
              </span>
            ))}
          </div>
        </div>

        <section className="bg-white">
          <div className="mx-auto max-w-6xl px-6 py-12 text-center sm:px-8">
            <p className="text-xs font-bold uppercase text-cyan-800">Sponsorship & support</p>
            <h2 className="mt-2 font-serif text-2xl font-bold text-gray-950">Support open human-study infrastructure</h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-gray-600">
              For research collaboration, project support, or sponsorship, contact:
            </p>
            <a href="mailto:xul049@ucsd.edu" className="mt-3 inline-block text-base font-semibold text-cyan-800 hover:underline">xul049@ucsd.edu</a>
          </div>
        </section>
      </main>
    </div>
  );
}
