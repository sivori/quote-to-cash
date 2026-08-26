import { describe, it, expect } from "vitest";
import { costMicros } from "../src/cost";
import { parseDeterministic } from "../src/parse";

describe("budget cost", () => {
  it("prices a call in micro-dollars at per-million rates", () => {
    // 1,200 in + 150 out at $0.293 / $2.253 per M = $0.0003516 + $0.00033795 = $0.00068955 → 690 µ$
    expect(costMicros({ prompt_tokens: 1200, completion_tokens: 150 }, 0.293, 2.253)).toBe(690);
  });
  it("rounds up so the cap is conservative", () => {
    expect(costMicros({ prompt_tokens: 1, completion_tokens: 0 }, 0.293, 2.253)).toBe(1);
  });
});

describe("deterministic fallback parser", () => {
  it("parses the canonical deal", () => {
    const p = parseDeterministic("50 Pro seats, 20 TB egress, EU, annual for Acme");
    expect(p.lines).toEqual([{ sku: "seat_pro", quantity: 50 }, { sku: "egress_tb", quantity: 20 }]);
    expect(p.region).toBe("EU"); expect(p.term).toBe("annual"); expect(p.customerName).toBe("Acme");
    expect(p.unresolved).toEqual([]);
  });
  it("handles enterprise + support, APAC, 3 years", () => {
    const p = parseDeterministic("200 enterprise seats and premium support, APAC, 3 years, for Globex");
    expect(p.lines.map((l) => l.sku)).toEqual(["seat_enterprise"]);
    expect(p.region).toBe("APAC"); expect(p.term).toBe("three_year");
    expect(p.notes).toMatch(/premium support/); // no quantity → flagged, not guessed
  });
  it("flags things it cannot map and defaults loudly", () => {
    const p = parseDeterministic("a dozen widgets");
    expect(p.lines).toEqual([]);
    expect(p.unresolved.length).toBe(2);
  });
});
