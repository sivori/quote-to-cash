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

export interface ParseResult { deal: ParsedDeal; usage: { prompt_tokens: number; completion_tokens: number } }

export async function parseDeal(env: Env, message: string): Promise<ParseResult> {
  const res = (await env.AI.run(env.MODEL as any, {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: message.slice(0, 2000) }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 400,
  })) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const raw = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
  // If the runtime omits usage, assume the request's ceiling so the cap errs on the safe side.
  const usage = { prompt_tokens: res.usage?.prompt_tokens ?? 1500, completion_tokens: res.usage?.completion_tokens ?? 400 };
  return { deal: validate(raw), usage };
}

/**
 * Deterministic fallback used when the AI budget is exhausted: "<number> <catalog alias>" pairs,
 * region and term keywords, "for <Name>". It handles the phrasings a demo visitor is likely to
 * type and flags everything else — it never guesses a product.
 */
export function parseDeterministic(message: string): ParsedDeal {
  const text = message.toLowerCase();
  const lines: { product: string; quantity: number }[] = [];
  const aliases = CATALOG.flatMap((c) => c.aliases.map((a) => ({ alias: a, label: c.label }))).sort((a, b) => b.alias.length - a.alias.length);
  let rest = text;
  for (const { alias, label } of aliases) {
    const re = new RegExp(`(\\d[\\d,\\.]*)\\s*(?:x\\s*)?(?:tb\\s+)?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    rest = rest.replace(re, (_m, n: string) => { lines.push({ product: label, quantity: Number(n.replace(/[,]/g, "")) }); return " "; });
  }
  const region = /\bapac\b|asia|pacific|singapore|tokyo|sydney/.test(text) ? "APAC" : /\beu\b|europe|frankfurt|london|paris|amsterdam/.test(text) ? "EU" : /\bus\b|usa|united states|america/.test(text) ? "US" : "unknown";
  const term = /3[- ]?year|three[- ]?year|36[- ]?month|multi[- ]?year/.test(text) ? "three_year" : /annual|yearly|1[- ]?year|one[- ]?year|12[- ]?month/.test(text) ? "annual" : /month/.test(text) ? "monthly" : "unknown";
  const name = message.match(/\bfor\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,3})/)?.[1] ?? null;
  const leftover = rest.replace(/[^a-z]+/g, " ").trim();
  const noise = /^(?:\s*(?:and|for|in|the|a|an|with|seats?|months?|years?|annual|monthly|eu|us|apac|europe|asia|pacific|plus|of|x|tb|deal|please|quote|me|our|we|need|want|company|team)\s*)*$/;
  return validate({ lines, region, term, customerName: name, paymentMethod: null, notes: leftover && !noise.test(leftover) ? `could not map: "${leftover.slice(0, 80)}"` : null });
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
