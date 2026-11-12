type BlogArticle = {
  slug: string;
  title: string;
  description: string;
  sections: { heading: string; paragraphs: string[] }[];
  source: { url: string; date: string; dateLabel: string };
  furtherReading?: { title: string; url: string };
};

export const blogArticles: readonly BlogArticle[] = [
  {
    slug: "reproducible-human-studies",
    title: "From papers to reusable experiments",
    description: "What it takes to turn a published finding into a study package another researcher can inspect, run, and adapt.",
    sections: [
      {
        heading: "Keep the experiment connected to its sources",
        paragraphs: [
          "A published finding is only a starting point for reuse. Researchers still need to reconstruct the instructions, conditions, measures, and analysis before they can examine how an experiment works or try a variation.",
          "HumanStudy Hub aims to bring those pieces together in a study package that stays connected to its sources. Showing missing materials and uncertain details helps researchers inspect the design, prepare a runnable draft, and decide what to verify before using it.",
        ],
      },
      {
        heading: "Use simulated participants to pilot the procedure",
        paragraphs: [
          "AI participants offer another way to explore the package. They can help pilot a procedure and show how model behavior changes across conditions. Human replication still requires collecting data from people.",
          "Each reconstruction can give the next researcher a clearer starting point.",
        ],
      },
    ],
    source: {
      url: "https://xuanl17.github.io/blog/reproducible-human-studies.html",
      date: "2026-03-10",
      dateLabel: "March 10, 2026",
    },
  },
  {
    slug: "implicit-agent-behavior",
    title: "Making agent behavior measurable",
    description: "How framing experiments can help researchers test whether model behavior matches the role they assigned.",
    sections: [
      {
        heading: "Test what an assigned role changes",
        paragraphs: [
          "Different models can interpret the same role differently. A researcher might expect an AI participant described as an economist to make particular choices, yet the model's interpretation of that role still needs testing.",
          "Xuan Liu's discussion of framing experiments illustrates this problem. Changing a participant description did not consistently produce the expected behavioral change across models.",
        ],
      },
      {
        heading: "Compare observable decisions",
        paragraphs: [
          "For social simulation, researchers can specify the behavior they expect, choose a task that measures it, and check the responses. They can then use the same procedure to compare models, prompts, or participant settings.",
          "This approach motivates tools such as CoBRA and reusable experimental packages. Both give researchers a way to examine behavior through observable decisions.",
        ],
      },
    ],
    source: {
      url: "https://xuanl17.github.io/blog/implicit-agent-behavior.html",
      date: "2025-09-16",
      dateLabel: "September 16, 2025",
    },
    furtherReading: { title: "CoBRA", url: "https://doi.org/10.1145/3772318.3790804" },
  },
];
