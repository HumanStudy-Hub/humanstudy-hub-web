import Image from "next/image";
import Link from "next/link";

const sections = [
  {
    heading: "A study as a program",
    body: [
      "Interviews, surveys, and lab experiments share one structure: they present information, collect responses, and use procedural logic to decide what happens next. HumanStudy Program writes that structure as code. Show presents information to participants, Ask collects their responses, and ordinary Python carries everything in between.",
      "In Nagel's four-round p-Beauty Contest, each participant picks a number from 0 to 100, and whoever is closest to p times the group mean wins. The tool traces each step from the paper to a reviewed procedure, then to the program that runs it.",
    ],
    figure: {
      src: "/research/program/beauty-contest.jpg",
      width: 2000,
      height: 902,
      alt: "Three panels: highlighted passages from Nagel's paper, the reviewed procedure as structured steps, and the procedure graph with its Python implementation using Show and Ask.",
      caption:
        "From the original paper to a reviewed procedure to procedure.py. Green marks participant actions, yellow marks study operations, and each step keeps its page in the paper.",
    },
  },
  {
    heading: "Missing details stay visible",
    body: [
      "Papers often leave out details a study needs to run. Instead of filling them with plausible defaults, the tool links what it found to its source and flags what it could not read, so the researcher fills the gap before approving the package.",
    ],
    figure: {
      src: "/research/program/missing-information.jpg",
      width: 2000,
      height: 902,
      alt: "An anchoring paper with the passage that defines the anchors, a review screen flagging two anchor values that need researcher input, and the approved values recorded as verbatim from Table 1.",
      caption:
        "In an anchoring study, the tool finds how the anchors were set but cannot read two values from a scanned table. The researcher enters them, and the package records each as verbatim from Table 1.",
    },
  },
  {
    heading: "Configure silicon participants",
    body: [
      "Because the procedure does not depend on how a participant is implemented, researchers can vary the participants while keeping the protocol fixed: choose a model, write a specification, form population groups, and assign them to conditions.",
    ],
    figure: {
      src: "/research/program/silicon-participants.jpg",
      width: 2000,
      height: 826,
      alt: "Playground configuration: a silicon participant with model, specification template, and memory settings; population groups built from saved participants; and groups assigned to the gain and loss conditions of a framing study.",
      caption: "Configure a participant, build population groups from it, and assign the groups to study conditions.",
    },
  },
  {
    heading: "From findings to individual responses",
    body: [
      "Each run produces structured records. Researchers can start from study-level findings, move to condition-level distributions, and open any single response with its raw output, parsed values, and audit log.",
    ],
    figure: {
      src: "/research/program/multilevel-results.jpg",
      width: 2000,
      height: 543,
      alt: "Three linked result views: a study-level summary with effects by condition, condition-level distributions and item patterns, and a response-level record with output, parsed values, source, and audit log.",
      caption: "Study, condition, and response levels of the same run.",
    },
  },
];

export default function ProgramArticle() {
  return (
    <div className="mt-20">
      <aside className="mb-14 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-[2px] bg-[var(--site-surface)] px-6 py-6 sm:px-8">
        <p className="max-w-[62ch] font-[family-name:var(--site-font-serif)] text-[18px] leading-[1.6]">
          We built an app that turns a paper into a study program, with a more capable study agent than the one in the paper.
        </p>
        <Link href="/download" className="inline-flex min-h-11 items-center border-b border-current text-sm text-[var(--site-accent)] hover:text-[var(--foreground)]">
          Get the app →
        </Link>
      </aside>
      {sections.map((section) => (
        <section key={section.heading} className="border-t border-[var(--site-line)] py-14">
          <h2 className="!text-[28px] !leading-[1.25]">{section.heading}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph.slice(0, 24)} className="mt-4 font-[family-name:var(--site-font-serif)] text-[18px] leading-[1.75]">
              {paragraph}
            </p>
          ))}
          <figure className="mt-8">
            <div className="rounded-[2px] bg-white p-3 sm:p-6">
              <Image
                src={section.figure.src}
                alt={section.figure.alt}
                width={section.figure.width}
                height={section.figure.height}
                sizes="(max-width: 1184px) 100vw, 1100px"
                className="h-auto w-full"
              />
            </div>
            <figcaption className="mt-3 text-[13px] leading-6 text-[var(--site-muted)]">{section.figure.caption}</figcaption>
          </figure>
        </section>
      ))}

      <section className="border-t border-[var(--site-line)] pt-14">
        <h2 className="!text-[28px] !leading-[1.25]">What researchers did with it</h2>
        <p className="mt-4 font-[family-name:var(--site-font-serif)] text-[18px] leading-[1.75]">
          In a hands-on review, 12 social science researchers each completed the workflow from paper to results. They saw
          uses in understanding published protocols, prototyping new studies, and examining AI behavior.
        </p>
      </section>
    </div>
  );
}
