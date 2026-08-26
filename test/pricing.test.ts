import { describe, it, expect } from "vitest";
import { price, applyBps, fmt } from "../src/pricing";
import { validate } from "../src/parse";
import { charge, sleepFor } from "../src/payments";
import { DUNNING_STRATEGIES } from "../src/policy";

describe("pricing", () => {
  it("prices the canonical deal in EUR: 50 Pro seats, 20 TB egress, EU, annual", () => {
    const q = price({ lines: [{ sku: "seat_pro", quantity: 50 }, { sku: "egress_tb", quantity: 20 }], region: "EU", term: "annual" });
    expect(q.currency).toBe("EUR");
    expect(q.fxBps).toBe(9_200); expect(q.priceBookVersion).toMatch(/^\d{4}-\d{2}-v\d+$/);
    // unit prices at the 0.92 price-book rate: €18.40/seat, €73.60/TB
    expect(q.lines.map((l) => l.unitCents)).toEqual([1_840, 7_360]);
    // seats: 50 × €18.40 × 12 = €11,040; egress: 20 × €73.60 × 12 = €17,664 → €28,704
    expect(q.subtotalCents).toBe(2_870_400);
    // EU +10% = €31,574.40; annual −15% = €4,736.16 → €26,838.24
    expect(q.regionUpliftCents).toBe(287_040);
    expect(q.termDiscountCents).toBe(473_616);
    expect(q.totalCents).toBe(2_683_824);
  });
  it("prices US deals in USD, unchanged", () => {
    const q = price({ lines: [{ sku: "seat_pro", quantity: 50 }, { sku: "egress_tb", quantity: 20 }], region: "US", term: "annual" });
    expect(q.currency).toBe("USD");
    expect(q.subtotalCents).toBe(3_120_000);
    expect(q.totalCents).toBe(2_652_000); // −15%
  });
  it("rounds half-up in integer math", () => {
    expect(applyBps(1, 10_000)).toBe(1);
    expect(applyBps(3, 11_500)).toBe(3); // 3.45 → 3
    expect(applyBps(5, 11_500)).toBe(6); // 5.75 → 6
  });
  it("formats per currency", () => {
    expect(fmt(2_917_200)).toBe("$29,172.00"); expect(fmt(5)).toBe("$0.05");
    expect(fmt(2_683_824, "EUR")).toBe("26.838,24\u00a0€");
  });
});

describe("parse validation", () => {
  it("maps aliases, merges duplicates, and reports unknowns instead of guessing", () => {
    const p = validate({ lines: [{ product: "pro", quantity: 30 }, { product: "Pro seat", quantity: 20 }, { product: "widgets", quantity: 3 }], region: "EU", term: "annual", customerName: "Acme", paymentMethod: null, notes: null });
    expect(p.lines).toEqual([{ sku: "seat_pro", quantity: 50 }]);
    expect(p.unresolved).toEqual(['unknown product "widgets"']);
  });
  it("defaults region and term loudly", () => {
    const p = validate({ lines: [{ product: "egress", quantity: 1 }], region: "unknown", term: "unknown", customerName: null, paymentMethod: null, notes: null });
    expect(p.region).toBe("US"); expect(p.term).toBe("monthly");
    expect(p.unresolved.length).toBe(2);
  });
});

describe("payments + dunning", () => {
  it("scripts outcomes by method", () => {
    expect(charge("card_ok", 100, 1, "d").ok).toBe(true);
    expect(charge("card_decline_then_ok", 100, 2, "d")).toMatchObject({ ok: false, retryable: true });
    expect(charge("card_decline_then_ok", 100, 3, "d").ok).toBe(true);
    expect(charge("card_decline", 100, 9, "d")).toMatchObject({ ok: false, retryable: false, code: "do_not_honor" });
  });
  it("scales the dunning schedule to the deployment's clock", () => {
    expect(DUNNING_STRATEGIES.standard.steps.map((d) => d.afterDays)).toEqual([1, 3, 7]);
    expect(sleepFor(3, 86_400)).toBe("259200 seconds");
    expect(sleepFor(3, 5)).toBe("15 seconds");
  });
});
