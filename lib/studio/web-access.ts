import type { StudioDocument } from "./types";

/** The web runs one study-building agent per project: the first build (retried if it failed).
 * Discussion and later changes happen in HumanStudy Desktop, where the agent runs locally. */
export const DESKTOP_DOWNLOAD_URL = process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL || "https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/latest";

export function webAgentAllowed(document: Pick<StudioDocument, "pipeline">, mode: "build" | "discuss"): boolean {
  if (mode !== "build") return false;
  return !document.pipeline || document.pipeline.status === "failed";
}

/** True once the first build has produced a package: from then on the page offers the app. */
export function continueInApp(document: Pick<StudioDocument, "pipeline">): boolean {
  return document.pipeline?.status === "review" || document.pipeline?.status === "complete";
}
