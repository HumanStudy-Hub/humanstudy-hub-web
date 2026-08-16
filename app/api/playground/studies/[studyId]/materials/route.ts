import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";

export const runtime = "nodejs";

type MaterialItem = { id: string; label: string };
type Material = { id: string; label: string; items: MaterialItem[] };

function repo() {
  const [owner, name] = (process.env.GITHUB_PIPELINE_REPO || "HumanStudy-Hub/HumanStudy-Bench").split("/");
  return { owner, repo: name };
}

function itemId(item: Record<string, unknown>) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
  for (const value of [item.id, item.item_id, item.name, item.label, metadata.id, metadata.label]) {
    const key = String(value || "").trim();
    if (/^[a-zA-Z0-9_.:-]+$/.test(key)) return key;
  }
  return "";
}

function itemLabel(item: Record<string, unknown>, fallback: string) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
  const key = itemId(item);
  const explicit = String(item.label || item.name || metadata.label || "").trim();
  if (explicit && explicit !== key) return explicit.slice(0, 180);
  if (key) return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return String(item.question || item.prompt || fallback).trim().slice(0, 180);
}

export async function GET(_request: Request, context: { params: Promise<{ studyId: string }> }) {
  try {
    const { studyId } = await context.params;
    if (!/^study_[a-zA-Z0-9_-]+$/.test(studyId)) return NextResponse.json({ error: "Invalid study id." }, { status: 400 });
    const api = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const target = repo();
    const branch = process.env.GITHUB_PIPELINE_REF || "main";
    const ref = await api.git.getRef({ ...target, ref: `heads/${branch}` });
    const tree = await api.git.getTree({ ...target, tree_sha: ref.data.object.sha, recursive: "true" });
    const paths = tree.data.tree
      .map((entry) => entry.path || "")
      .filter((path) => path.startsWith(`studies/${studyId}/`) && /\/materials\/[^/]+\.json$/.test(path))
      .slice(0, 40);
    const loaded = await Promise.all(paths.map(async (path): Promise<Material | null> => {
      const file = await api.repos.getContent({ ...target, path, ref: branch });
      if (Array.isArray(file.data) || !("content" in file.data)) return null;
      const parsed = JSON.parse(Buffer.from(file.data.content, "base64").toString("utf8"));
      const id = path.split("/").pop()?.replace(/\.json$/, "") || "";
      const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
      const items = rawItems.slice(0, 250).flatMap((item: unknown, index: number) => {
        if (!item || typeof item !== "object") return [];
        const key = itemId(item as Record<string, unknown>);
        return key ? [{ id: key, label: itemLabel(item as Record<string, unknown>, `Item ${index + 1}`) }] : [];
      });
      return { id, label: String(parsed?.title || parsed?.name || id).replace(/_/g, " "), items };
    }));
    const materials = loaded.filter((entry): entry is Material => entry !== null);
    return NextResponse.json({ materials }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (error) {
    console.error("material catalog error", error);
    return NextResponse.json({ error: "Study materials could not be loaded." }, { status: 502 });
  }
}
