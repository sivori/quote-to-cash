import { describe, it, expect } from "vitest";
import { price, withAgentDiscount } from "../src/pricing";
import { checkDiscount, checkDunning, needsHumanApproval, POLICY } from "../src/policy";
import { planDeterministic } from "../src/agent";

const annual = price({ lines: [{ sku: "seat_pro", quantity: 50 }], region: "US", term: "annual" });
const monthly = price({ lines: [{ sku: "seat_pro", quantity: 5 }], region: "US", term: "monthly" });

describe("guardrails", () => {
  it("lets the agent grant small discounts alone, escalates larger ones, refuses beyond the ceiling", () => {
    expect(checkDiscount(annual, 500, "multi-year strategic account")).toEqual({ ok: true, value: { bps: 500, needsApproval: false } });
    expect(checkDiscount(annual, 1500, "large volume commitment")).toEqual({ ok: true, value: { bps: 1500, needsApproval: true } });
    expect(checkDiscount(annual, 3000, "they asked nicely")).toMatchObject({ ok: false });
  });
  it("refuses discounts without a reason or on monthly terms", () => {
    expect(checkDiscount(annual, 500, "")).toMatchObject({ ok: false });
    expect(checkDiscount(monthly, 500, "a perfectly good reason")).toMatchObject({ ok: false });
  });
  it("approval can be escalated by the agent but never waived", () => {
    expect(needsHumanApproval(1_000_000, 1_000_000, false, 0)).toBe(true);
    expect(needsHumanApproval(10_000, 1_000_000, false, 0)).toBe(false);
    expect(needsHumanApproval(10_000, 1_000_000, true, 0)).toBe(true);
    expect(needsHumanApproval(10_000, 1_000_000, false, POLICY.maxAutoDiscountBps + 1)).toBe(true);
  });
  it("dunning strategies come from the allowlist only", () => {
    expect(checkDunning("gentle")).toEqual({ ok: true, value: "gentle" });
    expect(checkDunning("skip_all_notices")).toMatchObject({ ok: false });
  });
  it("applies an agent discount after the term discount, in integer cents", () => {
    // 50 × $20 × 12 = $12,000; −15% = $10,200; −5% agent = $510 → $9,690
    const q = withAgentDiscount(annual, 500);
    expect(q.agentDiscountCents).toBe(51_000);
    expect(q.totalCents).toBe(969_000);
  });
  it("deterministic plan: no discount, threshold approval, standard dunning", () => {
    const p = planDeterministic({ lines: [{ sku: "seat_pro", quantity: 50 }], region: "US", term: "annual", customerName: null, paymentMethod: null, unresolved: [], notes: null }, 1_000_000);
    expect(p).toMatchObject({ needsApproval: true, dunning: "standard", llm: false });
    expect(p.quote.agentDiscountBps).toBe(0);
  });
});
