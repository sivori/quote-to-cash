// Deterministic pricing. Pure functions over the catalog; the LLM never sees this file's inputs
// until they are already numbers, and never produces a price.
import { CATALOG, REGION_BPS, TERMS, type Region, type Sku, type Term } from "./catalog";

export interface QuoteInput {
  lines: { sku: Sku; quantity: number }[];
  region: Region;
  term: Term;
}

export interface QuoteLine {
  sku: Sku;
  label: string;
  quantity: number;
  unit: string;
  unitCents: number;
  /** quantity × unit × months, before region uplift and term discount. */
  baseCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  region: Region;
  term: Term;
  months: number;
  subtotalCents: number;
  regionUpliftCents: number;
  termDiscountCents: number;
  totalCents: number;
}

/** Round-half-up integer scaling by basis points. */
export function applyBps(cents: number, bps: number): number {
  const num = BigInt(cents) * BigInt(bps);
  return Number((num + 5_000n) / 10_000n);
}

export function price(input: QuoteInput): Quote {
  const term = TERMS[input.term];
  const lines: QuoteLine[] = input.lines.map((l) => {
    const item = CATALOG.find((c) => c.sku === l.sku)!;
    return {
      sku: l.sku, label: item.label, quantity: l.quantity, unit: item.unit, unitCents: item.unitCents,
      baseCents: item.unitCents * l.quantity * term.months,
    };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.baseCents, 0);
  const withRegion = applyBps(subtotalCents, REGION_BPS[input.region]);
  const regionUpliftCents = withRegion - subtotalCents;
  const termDiscountCents = applyBps(withRegion, term.discountBps);
  const totalCents = withRegion - termDiscountCents;
  return { lines, region: input.region, term: input.term, months: term.months, subtotalCents, regionUpliftCents, termDiscountCents, totalCents };
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
