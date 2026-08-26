// Hard guardrails. The agent proposes; these functions decide. Every limit an LLM must not cross
// is data here, and every tool the agent can call goes through one of these before anything is
// recorded. Pure and unit-tested.
import type { Quote } from "./pricing";

export const POLICY = {
  /** Discount the agent may grant on its own authority. */
  maxAutoDiscountBps: 1_000,      // 10%
  /** Discount that may be granted at all, even with a human's approval. */
  maxDiscountBps: 2_500,          // 25%
  /** Term lengths that justify any discount at all: monthly deals get none. */
  discountableTerms: ["annual", "three_year"] as const,
  /** Fewest payment attempts before a deal may go to collections. */
  minAttempts: 3,
  /** Most attempts any strategy may make. */
  maxAttempts: 5,
  /** Bounded agent loop. */
  maxToolCalls: 6,
};

export type DunningLevel = "reminder" | "warning" | "final_notice";
export interface DunningStep { afterDays: number; level: DunningLevel }
export type DunningStrategyId = "standard" | "gentle" | "aggressive";

/** Allowlisted dunning schedules. The agent picks an id; it cannot author a schedule. */
export const DUNNING_STRATEGIES: Record<DunningStrategyId, { label: string; when: string; steps: DunningStep[] }> = {
  standard: { label: "Standard", when: "default for most accounts", steps: [{ afterDays: 1, level: "reminder" }, { afterDays: 3, level: "warning" }, { afterDays: 7, level: "final_notice" }] },
  gentle: { label: "Gentle", when: "strategic or multi-year accounts; more time between notices", steps: [{ afterDays: 3, level: "reminder" }, { afterDays: 7, level: "warning" }, { afterDays: 14, level: "final_notice" }] },
  aggressive: { label: "Aggressive", when: "small monthly deals or prior payment trouble; fast escalation", steps: [{ afterDays: 1, level: "reminder" }, { afterDays: 2, level: "warning" }, { afterDays: 4, level: "final_notice" }] },
};
export const isDunningStrategy = (x: unknown): x is DunningStrategyId => typeof x === "string" && x in DUNNING_STRATEGIES;

export type Guard<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A discount request from the agent, checked against policy. Returns the bps actually allowed and whether it needs a human. */
export function checkDiscount(quote: Quote, requestedBps: number, reason: string | null): Guard<{ bps: number; needsApproval: boolean }> {
  if (!Number.isInteger(requestedBps) || requestedBps <= 0) return { ok: false, reason: "discount must be a positive whole number of basis points" };
  if (!reason || reason.trim().length < 8) return { ok: false, reason: "a discount needs a stated business reason" };
  if (!(POLICY.discountableTerms as readonly string[]).includes(quote.term)) return { ok: false, reason: `no discounts on ${quote.term} terms — offer a longer term instead` };
  if (requestedBps > POLICY.maxDiscountBps) return { ok: false, reason: `${requestedBps / 100}% exceeds the ${POLICY.maxDiscountBps / 100}% ceiling; nobody can approve that` };
  return { ok: true, value: { bps: requestedBps, needsApproval: requestedBps > POLICY.maxAutoDiscountBps } };
}

/** Approval is a policy decision: the agent may escalate, it may never waive. */
export function needsHumanApproval(totalCents: number, thresholdCents: number, agentEscalated: boolean, discountBps: number): boolean {
  return totalCents >= thresholdCents || agentEscalated || discountBps > POLICY.maxAutoDiscountBps;
}

export function checkDunning(id: unknown): Guard<DunningStrategyId> {
  if (!isDunningStrategy(id)) return { ok: false, reason: `unknown strategy; choose one of ${Object.keys(DUNNING_STRATEGIES).join(", ")}` };
  const attempts = 1 + DUNNING_STRATEGIES[id].steps.length;
  if (attempts < POLICY.minAttempts || attempts > POLICY.maxAttempts) return { ok: false, reason: "strategy violates attempt bounds" };
  return { ok: true, value: id };
}
