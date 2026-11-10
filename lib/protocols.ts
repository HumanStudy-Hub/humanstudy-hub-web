// Private v0.8 protocols (V080-PLATFORM §3.3, PR W3). Server only: import it from route
// handlers and lib code, never from a client component.
//
// Reads the private protocols store's index.json (repo from HUMANSTUDY_PROTOCOLS_REPO) through the GitHub API with
// HUMANSTUDY_PROTOCOLS_TOKEN and hands out METADATA ONLY (title, authors, year, arms,
// runnable, fidelity). protocol.json, study texts and states never leave the runner.
//
// Off unless PRIVATE_PROTOCOLS_ENABLED=1. Blocked on: P1 (the store and its build_index.py,
// which fixes index.json's shape) and the owner's "allowed users" rule for the access gate.
import "server-only";
import { Octokit } from "@octokit/rest";
import { readProtocol, type ResearchProtocol } from "@/lib/research";

export type PrivateProtocolEntry = {
  slug: string;
  title: string;
  authors: string[];
  year: number | null;
  protocol: ResearchProtocol;
};

// owner/name of the private store. Deliberately no default: the name is not written in this public repo.
const repo = () => {
  const value = process.env.HUMANSTUDY_PROTOCOLS_REPO || "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("HUMANSTUDY_PROTOCOLS_REPO is not configured.");
  return value;
};

export const privateProtocolsEnabled = () =>
  process.env.PRIVATE_PROTOCOLS_ENABLED === "1" && Boolean(process.env.HUMANSTUDY_PROTOCOLS_TOKEN)
  && Boolean(process.env.HUMANSTUDY_PROTOCOLS_REPO);

/**
 * Whitelist projection of one private index entry. Assumes the entry carries study.json's
 * public fields (slug, paper{title,authors,year}, schema_version, hsenv, fidelity, arms);
 * anything else, including any text, is dropped here.
 */
export function projectPrivateEntry(value: unknown): PrivateProtocolEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  const paper = e.paper && typeof e.paper === "object" ? e.paper as Record<string, unknown> : {};
  const fidelity = e.fidelity && typeof e.fidelity === "object" ? e.fidelity as Record<string, unknown> : {};
  const protocol = readProtocol({ protocol: {
    slug: e.slug, schemaVersion: e.schema_version ?? e.schemaVersion, hsenv: e.hsenv,
    fidelity: { verdict: fidelity.verdict, signedBy: fidelity.signed_by ?? fidelity.signedBy },
    arms: Array.isArray(e.arms) ? e.arms.map((a) => a && typeof a === "object"
      ? { id: (a as Record<string, unknown>).id, runnable: (a as Record<string, unknown>).runnable } : null) : [],
  } });
  const title = typeof paper.title === "string" ? paper.title.trim().slice(0, 300) : "";
  if (!protocol || !title) return null;
  const year = Number(paper.year);
  return {
    slug: protocol.slug, title,
    authors: (Array.isArray(paper.authors) ? paper.authors : []).filter((a): a is string => typeof a === "string").map((a) => a.slice(0, 120)).slice(0, 30),
    year: Number.isInteger(year) ? year : null,
    protocol,
  };
}

function api() {
  return new Octokit({ auth: process.env.HUMANSTUDY_PROTOCOLS_TOKEN });
}

async function readIndex(ref: string) {
  const [owner, name] = repo().split("/");
  const result = await api().repos.getContent({ owner, repo: name, path: "index.json", ref });
  if (Array.isArray(result.data) || !("content" in result.data)) throw new Error("Private protocol index unreadable.");
  const parsed = JSON.parse(Buffer.from(result.data.content, "base64").toString("utf8"));
  const studies: unknown[] = Array.isArray(parsed?.studies) ? parsed.studies : [];
  return studies.map(projectPrivateEntry).filter((x): x is PrivateProtocolEntry => Boolean(x));
}

/** Runnable private studies, metadata only. The caller must already have passed the access gate. */
export async function listPrivateProtocols(): Promise<PrivateProtocolEntry[]> {
  if (!privateProtocolsEnabled()) return [];
  try {
    return (await readIndex("main")).filter((entry) => entry.protocol.arms.some((arm) => arm.runnable));
  } catch {
    return [];
  }
}

/** Pin a private study for a run: store commit now, path studies/<slug>. */
export async function resolvePrivateProtocol(slug: string) {
  if (!privateProtocolsEnabled()) throw new Error("Private protocols are not enabled on this deployment.");
  const [owner, name] = repo().split("/");
  const ref = await api().git.getRef({ owner, repo: name, ref: "heads/main" });
  const commit = ref.data.object.sha;
  const entry = (await readIndex(commit)).find((item) => item.slug === slug);
  if (!entry) throw new Error("This private study is not available.");
  return { protocol: entry.protocol, pin: { store: "protocols" as const, path: `studies/${entry.slug}`, commit } };
}
