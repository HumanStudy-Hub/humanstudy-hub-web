// Usage plans: every limit lives here. The owner sets the final numbers; nothing else in the code
// hard-codes a budget, a price or a model list per plan.
//
// Spend is metered in US dollars as OpenRouter reports it for each call (`usage.cost`), so no model
// price table is kept anywhere. A budget covers everything the hosted route forwards for an account:
// building a study (the agent conversation) and simulation runs, in the desktop app and in Try online.
//
// The month is the calendar month in UTC. The allowance renews at 00:00 UTC on the 1st.

export type PlanId = "free" | "pro";

export type PlanLimits = {
  /** Shown to the user ("Free", "Pro"). */
  label: string;
  /** Hosted-model spend per calendar month, in US dollars (OpenRouter's reported cost). */
  monthlyBudgetUsd: number;
  /** Models this plan may call through the hosted route, intersected with DESKTOP_MODELS.
   *  "all" = every model the proxy forwards. */
  models: "all" | string[];
  /** The model new sessions start on. null = the server default (DESKTOP_DEFAULT_MODEL). */
  defaultModel: string | null;
  /** AI participants per condition (arm) a client should allow. "paper" = the paper's own n.
   *  The desktop relay enforces its own cap today (1-60); the budget is the server's hard bound. */
  maxParticipantsPerArm: number | "paper";
  /** One run across several participant models at once. */
  batchAcrossModels: boolean;
  /** First in line when capacity is short (e.g. Try online sandboxes). */
  priority: boolean;
  /** Held against the allowance while a call is in flight, then replaced by its real cost (and
   *  charged in full if no cost can be found). Bounds how far parallel calls can overrun a month. */
  reservePerCallUsd: number;
  /** Calls in flight at once per account. The desktop relay runs up to 8 participant calls in
   *  parallel, plus the agent conversation. Above this the route answers 429 (clients retry). */
  maxConcurrentCalls: number;
};

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    label: "Free",
    // Owner decision 2026-11-10: $10/month. On Claude Haiku 5.5 that is several study drafts plus their
    // simulation runs. (owner set the amount).
    monthlyBudgetUsd: 10,
    // The default model and a cheaper one. Stronger AI-participant models are part of Pro.
    // If older desktop builds still default to a model missing here, they get a clear
    // "part of Pro" error until they update; add that model here to avoid it.
    models: ["anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash"],
    defaultModel: "anthropic/claude-haiku-5.5",
    // Today's desktop cap, unchanged for free accounts.
    maxParticipantsPerArm: 60,
    batchAcrossModels: false,
    priority: false,
    // A large Haiku call (long prompt, 4,096 output tokens) costs a few cents.
    reservePerCallUsd: 0.05,
    maxConcurrentCalls: 12,
  },
  pro: {
    label: "Pro",
    // Proposal: $30/month. The Pro price itself is not set yet (no payment integration).
    monthlyBudgetUsd: 30,
    models: "all",
    defaultModel: null,
    maxParticipantsPerArm: "paper",
    batchAcrossModels: true,
    priority: true,
    // Stronger models with long agent contexts can cost tens of cents per call.
    reservePerCallUsd: 0.25,
    maxConcurrentCalls: 32,
  },
};

/** Every signed-in account is on this plan unless an admin sets another one. */
export const DEFAULT_PLAN: PlanId = "free";

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLANS, value);
}
