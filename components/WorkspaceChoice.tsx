import Link from "next/link";

type Choice = {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  steps: string[];
  action: string;
};

export default function WorkspaceChoice({ title, description, choices }: { title: string; description: string; choices: Choice[] }) {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <p className="text-xs font-semibold uppercase text-cyan-700">Choose a workflow</p>
          <h1 className="mt-3 max-w-3xl font-serif text-4xl font-bold text-gray-950">{title}</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">{description}</p>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-5 px-5 py-9 sm:px-8 md:grid-cols-2">
        {choices.map((choice, index) => (
          <section key={choice.href} className="flex min-h-[22rem] flex-col border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase text-cyan-700">{choice.eyebrow}</p>
            <h2 className="mt-3 font-serif text-2xl font-bold text-gray-950">{choice.title}</h2>
            <p className="mt-3 text-sm leading-6 text-gray-600">{choice.description}</p>
            <ol className="mt-6 flex-1 space-y-3 border-l border-gray-200">
              {choice.steps.map((step, stepIndex) => (
                <li key={step} className="relative pl-6 text-sm leading-6 text-gray-600">
                  <span className="absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-[11px] font-bold text-gray-700">{stepIndex + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <Link href={choice.href} className={`mt-7 inline-flex h-10 items-center justify-center px-5 text-sm font-semibold ${index === 0 ? "bg-cyan-700 text-white hover:bg-cyan-600" : "border border-gray-400 bg-white text-gray-800 hover:border-cyan-700 hover:text-cyan-800"}`}>{choice.action}</Link>
          </section>
        ))}
      </main>
    </div>
  );
}
