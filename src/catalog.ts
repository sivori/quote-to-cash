// The price book. Data, not code: everything a sales engineer would want to change lives here.
// All money is integer cents; all multipliers are integer basis points (10000 = 1.0x).

export type Sku = "seat_free" | "seat_pro" | "seat_enterprise" | "egress_tb" | "support_premium";
export type Region = "US" | "EU" | "APAC";
export type Term = "monthly" | "annual" | "three_year";

export interface CatalogItem {
  sku: Sku;
  label: string;
  unit: string;
  /** Per unit, per month. */
  unitCents: number;
  aliases: string[];
}

export const CATALOG: CatalogItem[] = [
  { sku: "seat_free", label: "Free seat", unit: "seat", unitCents: 0, aliases: ["free seat", "free seats", "free"] },
  { sku: "seat_pro", label: "Pro seat", unit: "seat", unitCents: 2_000, aliases: ["pro seat", "pro seats", "pro"] },
  { sku: "seat_enterprise", label: "Enterprise seat", unit: "seat", unitCents: 6_000, aliases: ["enterprise seat", "enterprise seats", "enterprise", "ent"] },
  { sku: "egress_tb", label: "Egress", unit: "TB", unitCents: 8_000, aliases: ["egress", "bandwidth", "transfer", "tb egress"] },
  { sku: "support_premium", label: "Premium support", unit: "plan", unitCents: 50_000, aliases: ["premium support", "support"] },
];

export type Currency = "USD" | "EUR";

/** Bump when any price, uplift, discount or FX rate changes; every quote and invoice carries it. */
export const PRICE_BOOK_VERSION = "2026-08-v1";

/**
 * Regions: uplift in basis points (data residency and local infrastructure cost more), the currency
 * the customer is quoted in, and the price-book FX rate (bps) used to express USD list prices in
 * that currency. The rate is part of the price book — set by finance, not fetched — so a quote is
 * reproducible from its inputs.
 */
export const REGIONS: Record<Region, { upliftBps: number; currency: Currency; fxBps: number; locale: string }> = {
  US: { upliftBps: 10_000, currency: "USD", fxBps: 10_000, locale: "en-US" },
  EU: { upliftBps: 11_000, currency: "EUR", fxBps: 9_200, locale: "de-DE" },
  APAC: { upliftBps: 11_500, currency: "USD", fxBps: 10_000, locale: "en-US" },
};
/** @deprecated kept for the catalog endpoint's shape */
export const REGION_BPS: Record<Region, number> = { US: 10_000, EU: 11_000, APAC: 11_500 };

/** Term commitment: months billed up front and the discount earned for committing. */
export const TERMS: Record<Term, { months: number; discountBps: number; label: string }> = {
  monthly: { months: 1, discountBps: 0, label: "Monthly" },
  annual: { months: 12, discountBps: 1_500, label: "Annual (15% off)" },
  three_year: { months: 36, discountBps: 2_500, label: "3-year (25% off)" },
};

export function findSku(name: string): CatalogItem | undefined {
  const n = name.trim().toLowerCase();
  return CATALOG.find((c) => c.sku === n || c.label.toLowerCase() === n || c.aliases.includes(n));
}
export const isRegion = (x: unknown): x is Region => x === "US" || x === "EU" || x === "APAC";
export const isTerm = (x: unknown): x is Term => x === "monthly" || x === "annual" || x === "three_year";
