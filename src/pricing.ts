// Deterministic pricing. Pure functions over the catalog; the LLM never sees this file's inputs
// until they are already numbers, and never produces a price.
import { CATALOG, PRICE_BOOK_VERSION, REGIONS, TERMS, type Currency, type Region, type Sku, type Term } from "./catalog";

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
  /** Unit price expressed in the quote currency (USD list × price-book FX). */
  unitCents: number;
  /** quantity × unit × months, before region uplift and term discount. */
  baseCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  region: Region;
  /** Currency of every cents figure in this quote. */
  currency: Currency;
  /** USD→currency rate applied to list prices, in basis points (10000 = 1.0000). */
  fxBps: number;
  /** The price book this quote was rated against; explains the rate after the book changes. */
  priceBookVersion: string;
  term: Term;
  months: number;
  subtotalCents: number;
  regionUpliftCents: number;
  termDiscountCents: number;
  /** Negotiated discount granted by the agent within policy, in bps and cents. */
  agentDiscountBps: number;
  agentDiscountCents: number;
  totalCents: number;
}

/** Round-half-up integer scaling by basis points. */
export function applyBps(cents: number, bps: number): number {
  const num = BigInt(cents) * BigInt(bps);
  return Number((num + 5_000n) / 10_000n);
}

export function price(input: QuoteInput): Quote {
  const term = TERMS[input.term];
  const region = REGIONS[input.region];
  // Convert the unit price first, so every line is an exact multiple of a published unit price
  // in the quote currency and the lines sum to the subtotal without rounding drift.
  const lines: QuoteLine[] = input.lines.map((l) => {
    const item = CATALOG.find((c) => c.sku === l.sku)!;
    const unitCents = applyBps(item.unitCents, region.fxBps);
    return { sku: l.sku, label: item.label, quantity: l.quantity, unit: item.unit, unitCents, baseCents: unitCents * l.quantity * term.months };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.baseCents, 0);
  const withRegion = applyBps(subtotalCents, region.upliftBps);
  const regionUpliftCents = withRegion - subtotalCents;
  const termDiscountCents = applyBps(withRegion, term.discountBps);
  const totalCents = withRegion - termDiscountCents;
  return { lines, region: input.region, currency: region.currency, fxBps: region.fxBps, priceBookVersion: PRICE_BOOK_VERSION, term: input.term, months: term.months, subtotalCents, regionUpliftCents, termDiscountCents, agentDiscountBps: 0, agentDiscountCents: 0, totalCents };
}

/** Apply a policy-checked agent discount to the post-term total. Pure; returns a new quote. */
export function withAgentDiscount(q: Quote, bps: number): Quote {
  const base = q.subtotalCents + q.regionUpliftCents - q.termDiscountCents;
  const agentDiscountCents = applyBps(base, bps);
  return { ...q, agentDiscountBps: bps, agentDiscountCents, totalCents: base - agentDiscountCents };
}

/** Currency-aware formatting: USD as $29,172.00; EUR in European style as 29.172,00 €. */
/** "0.9200 USD→EUR" — the rate as a human reads it, from its basis points. */
export function fxLabel(fxBps: number, currency: Currency): string {
  return `${(fxBps / 10_000).toFixed(4)} USD→${currency}`;
}

export function fmt(cents: number, currency: Currency = "USD"): string {
  const locale = currency === "EUR" ? "de-DE" : "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}
