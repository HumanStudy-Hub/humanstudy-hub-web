// Usage plans: pure logic (no network, no database), shared by the hosted model route, the usage
// endpoint and the account page. Limits come from ./plans-config only.

import { DEFAULT_PLAN, PLANS, isPlanId, type PlanId } from "./plans-config";

/** Metering and plans are on only with USAGE_PLANS_ENABLED=1, after the migration is applied.
 *  Off: the hosted route, the desktop key and the account page behave exactly as before. */
export function usagePlansEnabled(): boolean {
  return process.env.USAGE_PLANS_ENABLED === "1";
}

export type Locale = "en" | "zh";

export type AllowanceStatus = {
  plan: PlanId;
  label: string;
  usedUsd: number;
  limitUsd: number;
  remainingUsd: number;
  /** First day of the metered month, YYYY-MM-01 (UTC). */
  period: string;
  /** When the allowance renews: 00:00 UTC on the 1st of next month (ISO). */
  renewsAt: string;
  exhausted: boolean;
};

/** The metered month that contains `now`, as YYYY-MM-01 in UTC. */
export function periodStart(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** 00:00 UTC on the 1st of the month after `now`. */
export function renewsAt(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function planOf(value: unknown): PlanId {
  return isPlanId(value) ? value : DEFAULT_PLAN;
}

/** Dollars, rounded to a tenth of a cent so float sums never read as 2.9999999. */
const usd = (n: number) => Math.round(n * 1000) / 1000;

export function allowanceStatus(input: { plan: unknown; usedUsd: unknown; now?: number }): AllowanceStatus {
  const now = input.now ?? Date.now();
  const plan = planOf(input.plan);
  const limitUsd = PLANS[plan].monthlyBudgetUsd;
  const used = Number(input.usedUsd);
  const usedUsd = Number.isFinite(used) && used > 0 ? usd(used) : 0;
  return {
    plan,
    label: PLANS[plan].label,
    usedUsd,
    limitUsd,
    remainingUsd: usd(Math.max(0, limitUsd - usedUsd)),
    period: periodStart(now),
    renewsAt: renewsAt(now).toISOString(),
    // Used up once not even one call's reservation fits (the route refuses the same way).
    exhausted: usedUsd + PLANS[plan].reservePerCallUsd > limitUsd,
  };
}

/** The models a plan may call: the plan's list within what the proxy forwards, and its default. */
export function planModels(planInput: unknown, available: string[], serverDefault: string): { models: string[]; defaultModel: string } {
  const plan = PLANS[planOf(planInput)];
  const models = plan.models === "all" ? [...available] : available.filter((m) => (plan.models as string[]).includes(m));
  if (!models.length) return { models: [], defaultModel: "" };
  const wanted = plan.defaultModel ?? serverDefault;
  return { models, defaultModel: models.includes(wanted) ? wanted : models[0] };
}

export function formatRenewal(iso: string, locale: Locale = "en"): string {
  const d = new Date(iso);
  if (locale === "zh") return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Said in the app and in the API when the month's allowance is used up. */
export function exhaustedMessage(status: Pick<AllowanceStatus, "plan" | "renewsAt">, locale: Locale = "en"): string {
  const date = formatRenewal(status.renewsAt, locale);
  if (locale === "zh") return status.plan === "free" ? `本月的免费额度已用完，将于 ${date} 恢复。` : `本月的 Pro 额度已用完，将于 ${date} 恢复。`;
  return status.plan === "free"
    ? `You've used this month's free allowance. It renews on ${date}.`
    : `You've used this month's Pro allowance. It renews on ${date}.`;
}

/** The one line on the account page. */
export function usageLine(status: AllowanceStatus, locale: Locale = "en"): string {
  const date = formatRenewal(status.renewsAt, locale);
  if (locale === "zh") return `${status.label} 方案：本月已用 ${money(status.usedUsd)} / ${money(status.limitUsd)}，${date} 恢复。`;
  return `${status.label} plan: ${money(status.usedUsd)} of ${money(status.limitUsd)} used this month. Renews ${date}.`;
}

export function modelNotInPlanMessage(model: string, planInput: unknown, models: string[], locale: Locale = "en"): string {
  const plan = PLANS[planOf(planInput)];
  if (locale === "zh") return `${model} 不在 ${plan.label} 方案内。可用模型：${models.join("、")}。`;
  return `${model} is not included in the ${plan.label} plan. Your plan includes: ${models.join(", ")}. Choose one in Settings → Models.`;
}

export type MeteredUsage = { id?: string; costUsd?: number; promptTokens: number; completionTokens: number };

const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** Reads OpenRouter's usage block (`usage.cost` is the call's cost in US dollars). */
export function usageFrom(body: unknown): MeteredUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { id?: unknown; usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } };
  const out: MeteredUsage = { promptTokens: 0, completionTokens: 0 };
  if (typeof b.id === "string" && b.id) out.id = b.id;
  if (b.usage && typeof b.usage === "object") {
    const cost = Number(b.usage.cost);
    if (b.usage.cost !== undefined && b.usage.cost !== null && Number.isFinite(cost) && cost >= 0) out.costUsd = cost;
    out.promptTokens = count(b.usage.prompt_tokens);
    out.completionTokens = count(b.usage.completion_tokens);
  }
  return out.id || out.costUsd !== undefined ? out : null;
}

/** Watches an OpenAI-style SSE stream for the generation id and the final usage chunk. The bytes
 *  themselves pass through untouched; this only reads a copy. */
export class SseUsageScanner {
  private buffer = "";
  private decoder = new TextDecoder();
  id?: string;
  usage?: MeteredUsage;

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    // A runaway line without newlines must not grow without bound; usage chunks are small.
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }

  end(): MeteredUsage | null {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    if (this.usage) return { ...this.usage, id: this.usage.id ?? this.id };
    return this.id ? { id: this.id, promptTokens: 0, completionTokens: 0 } : null;
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]" || !data.includes('"')) return;
    try {
      const parsed = JSON.parse(data);
      const u = usageFrom(parsed);
      if (u?.id && !this.id) this.id = u.id;
      if (u?.costUsd !== undefined) this.usage = u;
    } catch { /* not JSON: ignore */ }
  }
}
