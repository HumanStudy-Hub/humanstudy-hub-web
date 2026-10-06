export type Pane = "agent" | "source" | "model";
export type PaneWeights = Record<Pane, number>;
export const defaultPaneWeights: PaneWeights = { agent: 0.8, source: 1.1, model: 1.28 };
export type PaneVisibility = Record<Pane, boolean>;

/** A pane switch keeps chat alongside a single artifact unless comparison is active. */
export function activateArtifact(open: PaneVisibility, pane: "source" | "model"): PaneVisibility {
  if (open.source && open.model) return { ...open, [pane]: true };
  return { ...open, source: pane === "source", model: pane === "model" };
}

/** Keep an artifact available when leaving comparison, even if chat has focus. */
export function toggleComparison(open: PaneVisibility, active: Pane): PaneVisibility {
  return open.source && open.model
    ? { ...open, source: active === "source", model: active !== "source" }
    : { ...open, source: true, model: true };
}

/** Resize just the adjacent visible pair; retain the other pane's share. */
export function resizePanePair(weights: PaneWeights, left: Pane, right: Pane, leftWidth: number, rightWidth: number, delta: number): PaneWeights {
  const total = leftWidth + rightWidth;
  if (left === right || total <= 0 || !Number.isFinite(delta)) return weights;
  const minimum = Math.min(240, total / 2);
  const width = Math.max(minimum, Math.min(total - minimum, leftWidth + delta));
  const share = weights[left] + weights[right];
  return { ...weights, [left]: share * width / total, [right]: share * (total - width) / total };
}

export function validPaneWeights(input: unknown): input is PaneWeights {
  return !!input && typeof input === "object" && ["agent", "source", "model"].every(pane => {
    const value = (input as Record<string, unknown>)[pane];
    return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 10;
  });
}
