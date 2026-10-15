import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { DESKTOP_RELEASES_URL, formatSize, getDesktopRelease, type DesktopAsset, type DesktopRelease } from "@/lib/desktop-release";

// Release links are read from GitHub at request time and cached for five minutes.
export const revalidate = 300;

const description =
  "A desktop app that reads a published empirical paper, reconstructs the study as a structured study document, and marks what the paper does not state.";

export const metadata: Metadata = {
  title: "Desktop app | HumanStudy-Hub",
  description,
  alternates: { canonical: "/download" },
  openGraph: {
    title: "HumanStudy Hub desktop app",
    description,
    type: "website",
    url: "/download",
    images: [{ url: "/desktop/og.png", width: 1200, height: 630, alt: "A reconstructed study shown next to the original paper" }],
  },
  twitter: { card: "summary_large_image", title: "HumanStudy Hub desktop app", description, images: ["/desktop/og.png"] },
};

const SIGN_UP = "/build/projects";
const CONTACT = "/collaboration";

function releaseDate(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function DownloadLink({ asset, fallback, label, primary }: { asset: DesktopAsset | null; fallback: string; label: string; primary?: boolean }) {
  const size = asset ? formatSize(asset.size) : "";
  return (
    <a
      href={asset?.url ?? fallback}
      {...(asset ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 ${
        primary
          ? "bg-cyan-800 text-white hover:bg-cyan-700"
          : "border border-gray-400 bg-white text-gray-800 hover:border-cyan-700 hover:text-cyan-800"
      }`}
    >
      <AppleMark />
      {label}
      {size && <span className={`font-normal ${primary ? "text-cyan-100" : "text-gray-500"}`}>{size}</span>}
    </a>
  );
}

function AppleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M11.2 8.5c0-1.6 1.3-2.4 1.4-2.4-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6C4.4 4.8 3.3 5.5 2.7 6.6c-1.2 2.1-.3 5.2.9 6.9.6.8 1.2 1.7 2.1 1.7.8 0 1.2-.5 2.2-.5s1.3.5 2.2.5c.9 0 1.5-.8 2-1.7.6-.9.9-1.8.9-1.9 0 0-1.8-.7-1.8-3.1ZM9.6 3.6c.4-.6.8-1.3.7-2.1-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2 .8.1 1.5-.4 2-.9Z" />
    </svg>
  );
}

function Downloads({ release }: { release: DesktopRelease }) {
  const date = releaseDate(release.publishedAt);
  const hasBuild = Boolean(release.macArm64 || release.macX64);
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <DownloadLink asset={release.macArm64} fallback={release.pageUrl} label="Download for Mac (Apple Silicon)" primary />
        <DownloadLink asset={release.macX64} fallback={release.pageUrl} label="Mac (Intel)" />
        <button
          type="button"
          disabled
          className="cursor-not-allowed border border-dashed border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-400"
        >
          Windows — coming soon
        </button>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        {hasBuild && release.version ? (
          <>
            Version {release.version.replace(/^v/, "")}
            {release.prerelease ? " (beta)" : ""}
            {date ? `, released ${date}. ` : ". "}
            <a href={release.pageUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-gray-300 underline-offset-2 hover:text-gray-950">
              Release notes
            </a>
          </>
        ) : (
          <>
            Release coming soon. Builds will appear on the{" "}
            <a href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-gray-300 underline-offset-2 hover:text-gray-950">
              releases page
            </a>
            .
          </>
        )}{" "}
        macOS 12 or later.
      </p>
    </div>
  );
}

function Shot({ src, alt, width, height, priority }: { src: string; alt: string; width: number; height: number; priority?: boolean }) {
  return (
    <div className="overflow-hidden rounded-md border border-gray-300 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <Image src={src} alt={alt} width={width} height={height} priority={priority} sizes="(min-width: 1024px) 64rem, 100vw" className="block h-auto w-full" />
    </div>
  );
}

const features: { title: string; body: React.ReactNode; shot: { src: string; alt: string; width: number; height: number } }[] = [
  {
    title: "The study, rebuilt from the paper",
    body: (
      <>
        <p>
          Open a PDF and the study agent writes a twelve-section study document: research questions and hypotheses,
          participants, design and conditions, the procedure with its materials transcribed verbatim, measures, the
          analysis plan and the reported results.
        </p>
        <p>
          Each item carries the page it came from and how it was obtained: quoted verbatim, reported in the text, or
          derived from what the paper reports. Multi-study papers get one tab per study.
        </p>
      </>
    ),
    shot: { src: "/desktop/study-document.webp", alt: "Study document for Ross, Greene and House (1977) with sections for paper overview, research questions and studies", width: 1440, height: 848 },
  },
  {
    title: "What the paper leaves out is marked, not filled in",
    body: (
      <>
        <p>
          The question the app keeps asking is whether there is enough information to reproduce the study. Anything the
          paper does not state is shown in amber as not stated, with the decision it leaves open.
        </p>
        <p>
          The agent does not invent a plausible assignment rule or a missing item wording. You record the decision
          yourself, or discuss it with the agent and keep the reasoning next to the item.
        </p>
      </>
    ),
    shot: { src: "/desktop/gaps-amber.webp", alt: "Two conditions marked Not stated in the paper, with the assignment rule open for a decision", width: 1440, height: 848 },
  },
  {
    title: "Every item next to the page it came from",
    body: (
      <>
        <p>
          Compare source opens the original PDF beside the study document. Select an item and the quoted passage is
          boxed on its page.
        </p>
        <p>
          It works the other way too: select a passage in the paper and the app lists every study item that cites it,
          so you can check a hypothesis, a measure and an analysis against the same sentence.
        </p>
      </>
    ),
    shot: { src: "/desktop/cited-passage.webp", alt: "A passage selected on page 5 of the paper, listing the four study items that cite it", width: 1440, height: 848 },
  },
];

const faq: [string, React.ReactNode][] = [
  [
    "Who can use the app?",
    <>The app is in beta. Anyone can create a HumanStudy-Hub account, and signing in to the app also needs an invitation code from the team.</>,
  ],
  [
    "Do I need an API key or a model subscription?",
    <>No. The study agent runs on hosted models through your HumanStudy-Hub account. There is nothing to configure.</>,
  ],
  [
    "What happens to the papers and studies I work on?",
    <>
      When you first sign in, the app asks you to accept a research-data agreement. It explains what is kept from your
      sessions and how the team may use it for research. Read it before you accept; you can stop there if you do not agree.
    </>,
  ],
  [
    "Are simulated participants a substitute for human data?",
    <>
      No. Simulated responses come from language models and are always labelled as simulation. They are useful for
      checking that the materials and procedure make sense to a respondent, not for estimating what people would do.
    </>,
  ],
  [
    "Why is there a download on first launch?",
    <>The app fetches its study assistant, about 170 MB, the first time it opens. Later launches use the copy on your Mac.</>,
  ],
  [
    "Is there a Windows version?",
    <>Not yet. A Windows build is planned; it will appear on the releases page when it is ready.</>,
  ],
  [
    "I started a study in the web builder. Where did it go?",
    <>
      Projects made in the browser are still in{" "}
      <Link href={SIGN_UP} className="underline decoration-gray-300 underline-offset-2 hover:text-gray-950">your web workspace</Link>.
    </>,
  ],
];

export default async function DownloadPage() {
  const release = await getDesktopRelease();

  return (
    <div className="bg-white text-gray-950">
      <section className="mx-auto max-w-7xl px-4 pt-14 sm:px-8 sm:pt-20">
        <div className="max-w-4xl">
          <h1 className="font-serif text-4xl font-bold leading-tight sm:text-6xl">HumanStudy Hub for Mac</h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-gray-700">
            Rebuild a published study from its paper, see exactly which details the paper leaves out, and check every
            item against the original PDF.
          </p>
          <div className="mt-8">
            <Downloads release={release} />
          </div>
        </div>

        <figure className="mt-12 sm:mt-16">
          <Shot
            src="/desktop/study-and-paper.webp"
            alt="HumanStudy Hub with the study agent, the reconstructed study document and the original paper open side by side"
            width={1440}
            height={848}
            priority
          />
          <figcaption className="mt-3 text-sm text-gray-600">
            <span className="sm:hidden">
              Left to right: the study agent, the study document with page references, and the original paper with the
              cited sentence boxed.
            </span>
            <span className="hidden gap-4 sm:grid sm:grid-cols-[26fr_37fr_37fr]">
              <span>The study agent reads the paper and answers questions about it.</span>
              <span>The study document, with page references on every item.</span>
              <span>The original paper, with the cited sentence boxed.</span>
            </span>
          </figcaption>
        </figure>
      </section>

      <div className="mx-auto mt-20 max-w-7xl space-y-20 px-4 sm:mt-28 sm:space-y-28 sm:px-8">
        {features.map((feature, i) => (
          <section key={feature.title} className="grid items-start gap-8 lg:grid-cols-12 lg:gap-12">
            <div className={`lg:col-span-4 lg:pt-6 ${i % 2 ? "lg:order-2" : ""}`}>
              <h2 className="font-serif text-2xl font-bold leading-snug sm:text-3xl">{feature.title}</h2>
              <div className="mt-4 space-y-4 text-base leading-7 text-gray-700">{feature.body}</div>
            </div>
            <div className={`lg:col-span-8 ${i % 2 ? "lg:order-1" : ""}`}>
              <Shot {...feature.shot} />
            </div>
          </section>
        ))}

        <section>
          <div className="max-w-2xl">
            <h2 className="font-serif text-2xl font-bold leading-snug sm:text-3xl">Charts of the design and the reported results</h2>
            <p className="mt-4 text-base leading-7 text-gray-700">
              From the study document the app draws the sample flow, the procedure and the conditions, and charts the
              statistics the paper reports. Every value links back to its page. Spreads and counts the paper does not
              report are drawn as not reported rather than estimated.
            </p>
          </div>
          <div className="mt-8 grid items-start gap-6 md:grid-cols-2">
            <figure>
              <Shot src="/desktop/study-overview.webp" alt="Study overview for Study 1: sample sizes, a two-step procedure and four conditions, one step marked for checking" width={1200} height={1173} />
              <figcaption className="mt-2 text-sm text-gray-600">Study overview: sample, procedure and conditions.</figcaption>
            </figure>
            <figure>
              <Shot src="/desktop/results-chart.webp" alt="Reported results: headline statistics and a bar chart of consensus estimates by the rater's own choice" width={1200} height={944} />
              <figcaption className="mt-2 text-sm text-gray-600">Reported results, charted from Table 1 of the paper.</figcaption>
            </figure>
          </div>
        </section>

        <section className="grid gap-8 border-l-4 border-cyan-800 bg-cyan-50/60 px-6 py-8 sm:px-10 lg:grid-cols-12">
          <h2 className="font-serif text-2xl font-bold leading-snug sm:text-3xl lg:col-span-4">Simulated participants, labelled as simulation</h2>
          <div className="space-y-4 text-base leading-7 text-gray-700 lg:col-span-8">
            <p>
              Once the procedure is in place you can run it with LLM-simulated participants, each going through the
              materials in the order the paper describes. Use it to find instructions that read ambiguously or
              conditions that do not differ the way the paper intends.
            </p>
            <p>
              Simulated responses are labelled as simulation everywhere they appear and are kept apart from the
              paper&apos;s human results. They are not data about people.
            </p>
          </div>
        </section>
      </div>

      <section className="mx-auto mt-20 max-w-7xl px-4 sm:mt-28 sm:px-8">
        <div className="grid gap-12 border-t border-gray-200 pt-14 lg:grid-cols-2">
          <div>
            <h2 className="font-serif text-2xl font-bold sm:text-3xl">Getting access</h2>
            <p className="mt-4 text-base leading-7 text-gray-700">
              The app is in beta by invitation. You need a HumanStudy-Hub account and an invitation code.
            </p>
            <ol className="mt-6 space-y-5">
              {[
                <>
                  <Link href={SIGN_UP} className="font-semibold text-cyan-800 underline decoration-cyan-800/30 underline-offset-2 hover:text-cyan-700">Create a HumanStudy-Hub account</Link>{" "}
                  and confirm your email address.
                </>,
                <>
                  Ask the team for an invitation code. Contact details are on the{" "}
                  <Link href={CONTACT} className="font-semibold text-cyan-800 underline decoration-cyan-800/30 underline-offset-2 hover:text-cyan-700">Partnerships page</Link>.
                </>,
                <>Install the app, sign in with your account, enter the code and accept the research-data agreement.</>,
              ].map((step, i) => (
                <li key={i} className="grid grid-cols-[2rem_1fr] gap-2 text-base leading-7 text-gray-700">
                  <span className="font-serif text-xl font-bold text-cyan-800">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h2 className="font-serif text-2xl font-bold sm:text-3xl">Requirements</h2>
            <dl className="mt-6 divide-y divide-gray-200 border-y border-gray-200 text-base">
              {[
                ["System", "macOS 12 Monterey or later, on Apple Silicon or Intel. Windows is coming."],
                ["First launch", "Downloads the study assistant, about 170 MB, once."],
                ["Models", "Hosted. No API keys or model accounts needed."],
                ["Sign-in", "HumanStudy-Hub account, invitation code and research-data agreement."],
              ].map(([term, detail]) => (
                <div key={term} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt className="font-semibold text-gray-950">{term}</dt>
                  <dd className="leading-7 text-gray-700">{detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-3xl px-4 pb-24 sm:mt-28 sm:px-8">
        <h2 className="font-serif text-2xl font-bold sm:text-3xl">Questions</h2>
        <div className="mt-6 divide-y divide-gray-200 border-y border-gray-200">
          {faq.map(([question, answer]) => (
            <details key={question} className="group py-4">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-semibold text-gray-950 marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700">
                {question}
                <span aria-hidden="true" className="mt-0.5 text-cyan-800 transition-transform group-open:rotate-45">+</span>
              </summary>
              <div className="mt-3 text-base leading-7 text-gray-700">{answer}</div>
            </details>
          ))}
        </div>
        <div className="mt-12">
          <Downloads release={release} />
        </div>
      </section>
    </div>
  );
}
