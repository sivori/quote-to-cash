// Natural language → structured deal. The model's only job is to name SKUs, quantities, region
// and term; it returns no prices. Its output is validated against the catalog before use.
import { CATALOG, findSku, isRegion, isTerm, type Region, type Term } from "./catalog";
import type { QuoteInput } from "./pricing";

export interface ParsedDeal extends QuoteInput {
  customerName: string | null;
  paymentMethod: string | null;
  /** Anything the model could not map, surfaced to the user rather than silently dropped. */
  unresolved: string[];
  notes: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { product: { type: "string" }, quantity: { type: "number" } },
        required: ["product", "quantity"],
        additionalProperties: false,
      },
    },
    region: { type: "string", enum: ["US", "EU", "APAC", "unknown"] },
    term: { type: "string", enum: ["monthly", "annual", "three_year", "unknown"] },
    customerName: { type: ["string", "null"] },
    paymentMethod: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
  required: ["lines", "region", "term", "customerName", "paymentMethod", "notes"],
  additionalProperties: false,
};

const SYSTEM = `You convert a salesperson's message into a structured deal for a cloud platform.
Products (use these names exactly): ${CATALOG.map((c) => `${c.label} (per ${c.unit}; aliases: ${c.aliases.join(", ")})`).join("; ")}.
Regions: US, EU, APAC. Terms: monthly, annual, three_year (a "3 year", "36 month" or "multi-year" deal is three_year).
Rules:
- Quantities are numbers; "20 TB egress" is product "Egress", quantity 20. "1 year" or "yearly" is annual.
- If a region or term is not stated, return "unknown". Never guess.
- paymentMethod: if the message mentions a card or payment method, copy the identifier (e.g. "card_decline_then_ok"); else null.
- customerName: the company or person the deal is for, if stated; else null.
- notes: anything you could not map to a product, briefly; else null.
- Do NOT compute or mention prices. Respond with JSON only.`;

export async function parseDeal(env: Env, message: string): Promise<ParsedDeal> {
  const res = (await env.AI.run(env.MODEL as any, {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: message.slice(0, 2000) }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 400,
  })) as { response?: unknown };
  const raw = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
  return validate(raw);
}

/** Map model output onto the catalog; anything that doesn't fit becomes `unresolved`, not a guess. */
export function validate(raw: any): ParsedDeal {
  const unresolved: string[] = [];
  const lines: QuoteInput["lines"] = [];
  for (const l of Array.isArray(raw?.lines) ? raw.lines : []) {
    const item = findSku(String(l?.product ?? ""));
    const qty = Number(l?.quantity);
    if (!item) { unresolved.push(`unknown product "${String(l?.product ?? "").slice(0, 60)}"`); continue; }
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) { unresolved.push(`bad quantity for ${item.label}`); continue; }
    const existing = lines.find((x) => x.sku === item.sku);
    if (existing) existing.quantity += Math.round(qty); else lines.push({ sku: item.sku, quantity: Math.round(qty) });
  }
  const region: Region = isRegion(raw?.region) ? raw.region : "US";
  if (!isRegion(raw?.region)) unresolved.push("region not stated — defaulted to US");
  const term: Term = isTerm(raw?.term) ? raw.term : "monthly";
  if (!isTerm(raw?.term)) unresolved.push("term not stated — defaulted to monthly");
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return { lines, region, term, customerName: str(raw?.customerName, 80), paymentMethod: str(raw?.paymentMethod, 40), unresolved, notes: str(raw?.notes, 200) };
}
