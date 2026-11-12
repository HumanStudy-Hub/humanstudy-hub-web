export type Paper = {
  slug: string;
  tag: string;
  date: string;
  title: string;
  arxiv: string;
  href: string;
  summary: string;
};

export const papers: Paper[] = [
  {
    slug: "humanstudy-program",
    tag: "HumanStudy Program",
    date: "November 2026",
    title: "Executable Human Study Programs with Silicon Participants",
    arxiv: "arXiv 2611.11969",
    href: "https://arxiv.org/abs/2611.11969",
    summary:
      "Reconstructs a human study from its paper as an executable program that researchers can inspect, modify, and run with silicon participants — to understand a published study, prototype a new one, or study agent behavior.",
  },
  {
    slug: "humanstudy-bench",
    tag: "HumanStudy Bench",
    date: "February 2026",
    title: "HumanStudy-Bench: Towards AI Agent Design for Participant Simulation",
    arxiv: "arXiv 2602.00685",
    href: "https://arxiv.org/abs/2602.00685",
    summary:
      "Replays published human-subject experiments with AI agents and scores how closely they match the human findings, to compare models and agent designs.",
  },
];
