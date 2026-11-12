export const CONTRIBUTION_METADATA = "CONTRIBUTION.json";
export const CONTRIBUTION_PROGRAM = "program.json";
export const CONTRIBUTION_PROTOCOL = "protocol.json";
export const CONTRIBUTION_STUDY = "study.json";
export const CONTRIBUTION_SOURCES = "sources/SOURCE.json";
export const MAX_CONTRIBUTION_ZIP_BYTES = 40 * 1024 * 1024;

const privateParts = new Set([
  ".env", ".git", ".opencode", ".humanstudy", "node_modules", "__pycache__", "threads",
  "conversations", "chat", "chats", "credentials", "account.json", "settings.json",
  "human-data", "runs", "original-text", "rehydrated", "restored", "researcher",
  "private", "quarantine",
]);

export function ignorableContributionPath(name: string): boolean {
  return name.startsWith("__MACOSX/") || name.split("/").at(-1) === ".DS_Store";
}

export function contributionPathProblem(name: string, includesPdf: boolean, paired = false): string | null {
  const parts = name.split("/");
  const normalised = name.normalize("NFKC");
  if (/[\\:\x00-\x1f\x7f]/.test(normalised) || normalised.split("/").some(part => !part || part === "." || part === "..")) {
    return `The zip contains a file path that is not allowed (${JSON.stringify(name)}). Paths must stay inside the contribution folder.`;
  }
  const lower = normalised.toLowerCase().split("/");
  const filename = lower.at(-1)!;
  const simulationReport = lower[0] === "artifacts" && lower[1] === "simulations"
    && ["report.md", "summary.md"].includes(filename);
  const simulationData = lower.includes("simulations") && !simulationReport;
  if (lower.some(part => privateParts.has(part) || part.startsWith(".env.")) || simulationData
      || /(?:\.annotations\.json|\.jsonl|\.ndjson|\.log|\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar))$/.test(filename)
      || /^(?:records|responses|raw[-_](?:data|responses|records)|(?:participant|human)[-_](?:data|responses|records))\./.test(filename)) {
    return `${name} is a private project file or raw record and is not published.`;
  }
  const root = name === CONTRIBUTION_PROGRAM || name === CONTRIBUTION_METADATA;
  const allowed = paired
    ? root || [CONTRIBUTION_PROTOCOL, CONTRIBUTION_STUDY, CONTRIBUTION_SOURCES].includes(name)
      || name.startsWith("sources/open/") || parts[0] === "artifacts" && parts.length > 1
    : root || parts.length > 1 && ["package", "artifacts", "sources"].includes(parts[0]);
  if (!allowed) {
    return paired
      ? `${name} is outside the paired contribution files. Include the program, draft study, projected protocol, licensed sources and shareable artifacts.`
      : `${name} is outside the contribution files. Include program.json, package/, sources/, research artifacts and CONTRIBUTION.json.`;
  }
  if (/\.pdf$/.test(filename) && !includesPdf) {
    return `${name} is a PDF. Include a paper PDF only when you have permission to publish it.`;
  }
  return null;
}

export function contributionPathKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}
