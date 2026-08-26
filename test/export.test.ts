import { describe, it, expect } from "vitest";
import { dealsCsv, dealsPdf } from "../src/export";
import { price } from "../src/pricing";

const deal: any = {
  id: "deal_1", customerId: "acme", request: 'Quote for "Acme", 50 Pro seats', createdAt: 1_700_000_000_000, status: "paid",
  parsed: { customerName: "Acme", lines: [], region: "EU", term: "annual", paymentMethod: null, unresolved: [], notes: null },
  quote: price({ lines: [{ sku: "seat_pro", quantity: 50 }], region: "EU", term: "annual" }), paymentMethod: "card_ok",
  needsApproval: true, approval: { decision: "approved", by: "chris", at: 1_700_000_100_000, auto: false },
  invoice: { id: "inv_deal_1", amountCents: 1_122_000, issuedAt: 1_700_000_200_000, dueAt: 1_702_592_200_000 }, workflowId: "deal_1", updatedAt: 0,
};

describe("exports", () => {
  it("writes CSV with quoting and formula guarding", () => {
    const csv = dealsCsv("acme", [{ ...deal, request: "=HYPERLINK(\"x\")" }]);
    const [head, row] = csv.split("\r\n");
    expect(head.startsWith("deal_id,customer,")).toBe(true);
    expect(row).toContain('"\'=HYPERLINK(""x"")"');
    expect(row).toContain("11220.00");
  });
  it("writes a parseable PDF", () => {
    const pdf = dealsPdf("acme", [deal], [{ seq: 1, dealId: "deal_1", ts: 1, kind: "payment.succeeded", detail: { attempt: 1, amountCents: 1_122_000 } }]);
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text.trim().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Deal history - acme");
    // xref offsets must point at "N 0 obj"
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
  });
});
