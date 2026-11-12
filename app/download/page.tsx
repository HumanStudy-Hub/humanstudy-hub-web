import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "@/components/folio-page.module.css";
import { DESKTOP_RELEASES_URL, formatSize, getDesktopRelease, type DesktopAsset, type DesktopRelease } from "@/lib/desktop-release";
import { tryListed } from "@/lib/try-online-config";

// Release links are read from GitHub at request time and cached for five minutes.
export const revalidate = 300;

const description =
  "Explore research papers, reproduce study procedures with AI participants, and design new experiments.";

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

const SIGN_UP = "/account";
const CONTACT = "/collaboration";

function releaseDate(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function DownloadLink({ asset, fallback, label, primary, windows }: { asset: DesktopAsset | null; fallback: string; label: string; primary?: boolean; windows?: boolean }) {
  const size = asset ? formatSize(asset.size) : "";
  return (
    <a
      href={asset?.url ?? fallback}
      {...(asset ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      className={`inline-flex max-w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--site-accent)] ${
        primary
          ? "bg-[var(--site-accent)] text-white hover:bg-[var(--site-accent)]"
          : "border border-[var(--site-line)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--site-accent)] hover:text-[var(--site-accent)]"
      }`}
    >
      {!windows && <AppleMark />}
      <span className={windows ? "whitespace-nowrap" : undefined}>{label}</span>
      {size && <span className={`shrink-0 whitespace-nowrap font-normal ${primary ? "text-white/75" : "text-[var(--site-muted)]"}`}>{size}</span>}
    </a>
  );
}

function AppleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 shrink-0 fill-current">
      <path d="M11.2 8.5c0-1.6 1.3-2.4 1.4-2.4-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6C4.4 4.8 3.3 5.5 2.7 6.6c-1.2 2.1-.3 5.2.9 6.9.6.8 1.2 1.7 2.1 1.7.8 0 1.2-.5 2.2-.5s1.3.5 2.2.5c.9 0 1.5-.8 2-1.7.6-.9.9-1.8.9-1.9 0 0-1.8-.7-1.8-3.1ZM9.6 3.6c.4-.6.8-1.3.7-2.1-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2 .8.1 1.5-.4 2-.9Z" />
    </svg>
  );
}

function Downloads({ release, tryOnline }: { release: DesktopRelease; tryOnline: boolean }) {
  const date = releaseDate(release.publishedAt);
  const hasBuild = Boolean(release.macArm64 || release.macX64);
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <DownloadLink asset={release.macArm64} fallback={release.pageUrl} label="Download for Mac (Apple Silicon)" primary />
        <DownloadLink asset={release.macX64} fallback={release.pageUrl} label="Mac (Intel)" />
        {release.windows ? (
          <DownloadLink asset={release.windows} fallback={release.pageUrl} label="Windows (preview)" windows />
        ) : (
          <button
            type="button"
            disabled
            className="cursor-not-allowed border border-dashed border-[var(--site-line)] bg-[var(--background)] px-4 py-2.5 text-sm font-semibold text-[var(--site-muted)]"
          >
            Windows: coming soon
          </button>
        )}
        {tryOnline && (
          <Link
            href="/try"
            className="inline-flex items-center gap-2 border border-[var(--site-line)] bg-[var(--background)] px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] hover:border-[var(--site-accent)] hover:text-[var(--site-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--site-accent)]"
          >
            Open in browser
          </Link>
        )}
      </div>
      <p className="mt-3 text-sm text-[var(--site-muted)]">
        {hasBuild && release.version ? (
          <>
            Version {release.version.replace(/^v/, "")}
            {release.prerelease ? " (beta)" : ""}
            {date ? `, released ${date}. ` : ". "}
            <a href={release.pageUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-[var(--site-line)] underline-offset-2 hover:text-[var(--foreground)]">
              Release notes
            </a>
          </>
        ) : (
          <>
            Release coming soon. Builds will appear on the{" "}
            <a href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-[var(--site-line)] underline-offset-2 hover:text-[var(--foreground)]">
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
    <div className="overflow-hidden rounded-md border border-[var(--site-line)] bg-[var(--background)] shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <Image src={src} alt={alt} width={width} height={height} priority={priority} sizes="(min-width: 1024px) 64rem, 100vw" className="block h-auto w-full" />
    </div>
  );
}

const faq: [string, React.ReactNode][] = [
  [
    "Who can use the app?",
    <>Access is by invitation. Create a HumanStudy Hub account and sign in with an invitation code from the team.</>,
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
    "Can I use it without installing anything?",
    <>Yes: “Open in browser” opens the same app in your browser. It runs in a workspace of your own in the cloud, which keeps your projects between visits. It needs your HumanStudy-Hub account and an invitation code. The launcher shows the session limit. You can resume your workspace later.</>,
  ],
  [
    "Is there a Windows version?",
    <>A Windows preview is available. It has not been tested on many machines yet and the installer is not code-signed, so Windows SmartScreen will warn on first run: choose “More info”, then “Run anyway”. Please tell us what breaks.</>,
  ],
  [
    "I started a study in the web builder. Where did it go?",
    <>
      Projects made in the browser are still in{" "}
      <Link href="/build/projects" className="underline decoration-[var(--site-line)] underline-offset-2 hover:text-[var(--foreground)]">your web workspace</Link>.
    </>,
  ],
];

export default async function DownloadPage() {
  const release = await getDesktopRelease();

  return (
    <div className={styles.page}>
      <section>
        <div className="max-w-4xl">
          <h1>HumanStudy Hub desktop app</h1>
          <p className={styles.lede}>
            {description}
          </p>
          <div className="mt-8">
            <Downloads release={release} tryOnline={tryListed() || process.env.VERCEL_ENV === "preview"} />
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
          <figcaption className="mt-3 text-sm text-[var(--site-muted)]">
            An example of comparing a study document with its original paper.
          </figcaption>
        </figure>
      </section>

      <section className="mt-16">
        <div className="grid gap-12 border-t border-[var(--site-line)] pt-14 lg:grid-cols-2">
          <div>
            <h2 className="font-serif text-2xl font-bold sm:text-3xl">Getting access</h2>
            <p className="mt-4 text-base leading-7 text-[var(--foreground)]">
              Access is by invitation. You need a HumanStudy Hub account and an invitation code.
            </p>
            <ol className="mt-6 space-y-5">
              {[
                <>
                  <Link href={SIGN_UP} className="font-semibold text-[var(--site-accent)] underline decoration-[var(--site-accent)]/30 underline-offset-2 hover:text-[var(--site-accent)]">Create a HumanStudy-Hub account</Link>{" "}
                  and confirm your email address.
                </>,
                <>
                  Ask the team for an invitation code. Contact details are on the{" "}
                  <Link href={CONTACT} className="font-semibold text-[var(--site-accent)] underline decoration-[var(--site-accent)]/30 underline-offset-2 hover:text-[var(--site-accent)]">Partnerships page</Link>.
                </>,
                <>Install the app, sign in with your account, enter the code and accept the research-data agreement.</>,
              ].map((step, i) => (
                <li key={i} className="grid grid-cols-[2rem_1fr] gap-2 text-base leading-7 text-[var(--foreground)]">
                  <span className="font-serif text-xl font-bold text-[var(--site-accent)]">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h2 className="font-serif text-2xl font-bold sm:text-3xl">Requirements</h2>
            <dl className="mt-6 divide-y divide-[var(--site-line)] border-y border-[var(--site-line)] text-base">
              {[
                ["System", "macOS 12 Monterey or later, on Apple Silicon or Intel. Windows 10/11 (64-bit) as a preview."],
                ["First launch", "Downloads the study assistant, about 170 MB, once."],
                ["Models", "Hosted. No API keys or model accounts needed."],
                ["Sign-in", "HumanStudy-Hub account, invitation code and research-data agreement."],
              ].map(([term, detail]) => (
                <div key={term} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <dt className="font-semibold text-[var(--foreground)]">{term}</dt>
                  <dd className="leading-7 text-[var(--foreground)]">{detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="mt-16 max-w-3xl">
        <h2 className="font-serif text-2xl font-bold sm:text-3xl">Questions</h2>
        <div className="mt-6 divide-y divide-[var(--site-line)] border-y border-[var(--site-line)]">
          {faq.filter(([question]) => tryListed() || !question.startsWith("Can I use it without installing")).map(([question, answer]) => (
            <details key={question} className="group py-4">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-semibold text-[var(--foreground)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--site-accent)]">
                {question}
                <span aria-hidden="true" className="mt-0.5 text-[var(--site-accent)] transition-transform group-open:rotate-45">+</span>
              </summary>
              <div className="mt-3 text-base leading-7 text-[var(--foreground)]">{answer}</div>
            </details>
          ))}
        </div>
        <div className="mt-12">
          <Downloads release={release} tryOnline={tryListed() || process.env.VERCEL_ENV === "preview"} />
        </div>
      </section>
    </div>
  );
}
