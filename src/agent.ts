// The deal agent. Llama 3.3 runs a bounded tool-use loop: it can look up pricing, propose a
// discount, escalate for approval, and choose a dunning strategy. Every tool is code with a
// guardrail from ./policy in front of it; the model can ask, it cannot decide. When the loop
// misbehaves, runs out of turns, or the AI budget is exhausted, a deterministic plan is used.
import { price, withAgentDiscount, fmt, type Quote } from "./pricing";
import { TERMS } from "./catalog";
import type { ParsedDeal } from "./parse";
import { POLICY, DUNNING_STRATEGIES, checkDiscount, checkDunning, needsHumanApproval, type DunningStrategyId } from "./policy";
import type { Usage } from "./cost";

/** JSON strings, so the whole plan stays RPC-serializable through the Durable Object. */
export interface TraceStep { tool: string; args: string; result: string; ok: boolean }
export interface Plan {
  quote: Quote;
  discountReason: string | null;
  needsApproval: boolean;
  approvalReason: string | null;
  dunning: DunningStrategyId;
  dunningReason: string | null;
  rationale: string;
  trace: TraceStep[];
  /** false when the deterministic fallback produced the plan */
  llm: boolean;
}

const TOOLS = [
  { type: "function", function: { name: "lookup_pricing", description: "Price the deal from the catalog. Call this first. Returns every amount; you never compute prices yourself.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "apply_discount", description: `Propose a negotiated discount as a whole percentage (e.g. 5 means 5% off). Policy: only on annual or three_year terms; up to ${POLICY.maxAutoDiscountBps / 100}% on your own authority; ${POLICY.maxAutoDiscountBps / 100}–${POLICY.maxDiscountBps / 100}% requires human approval; never above ${POLICY.maxDiscountBps / 100}%. Use sparingly and only with a real business reason (large volume, multi-year commitment, strategic customer).`, parameters: { type: "object", properties: { percent: { type: "number", description: "whole percent off, 1–25" }, reason: { type: "string" } }, required: ["percent", "reason"] } } },
  { type: "function", function: { name: "request_approval", description: "Escalate this deal to a human even if policy would auto-approve it (e.g. unusual size for the customer, ambiguous request, unmapped items). You cannot do the reverse: deals at or above the threshold always wait for a human.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } },
  { type: "function", function: { name: "choose_dunning_strategy", description: `Pick how failed payments are retried. Options: ${Object.entries(DUNNING_STRATEGIES).map(([k, v]) => `${k} (${v.when}; notices at ${v.steps.map((s) => s.afterDays + "d").join("/")})`).join("; ")}. Default is standard.`, parameters: { type: "object", properties: { strategy: { type: "string", enum: Object.keys(DUNNING_STRATEGIES) }, reason: { type: "string" } }, required: ["strategy", "reason"] } } },
  { type: "function", function: { name: "finalize", description: "Finish with a one- or two-sentence rationale for the salesperson. Call this when the plan is complete.", parameters: { type: "object", properties: { rationale: { type: "string" } }, required: ["rationale"] } } },
];

const SYSTEM = `You are a deal desk agent for a cloud platform. A salesperson's request has been parsed into products, region and term. Decide how to handle the deal using the tools, then finalize.
Rules: always call lookup_pricing first. Offer a discount only when the deal earns it (multi-year, large volume, strategic named customer) and keep it small; most deals get none. Escalate to a human when something is unusual or unmapped. Choose a dunning strategy that fits the account: gentle for strategic multi-year accounts, aggressive for small monthly deals, standard otherwise. Do not compute prices; do not describe amounts other than those returned by tools. Call one tool at a time.`;

export interface AgentEnv { AI: Ai; MODEL: string; APPROVAL_THRESHOLD_CENTS: string }

export async function planDeal(env: AgentEnv, parsed: ParsedDeal, request: string, meter: (u: Usage) => Promise<unknown>): Promise<Plan> {
  const threshold = Number(env.APPROVAL_THRESHOLD_CENTS);
  const state = { quote: null as Quote | null, discountReason: null as string | null, escalated: false, approvalReason: null as string | null, dunning: "standard" as DunningStrategyId, dunningReason: null as string | null, rationale: "", done: false };
  const trace: TraceStep[] = [];

  // Tool implementations. Each returns what the model gets to see; policy decides what it may do.
  const tools: Record<string, (args: any) => unknown> = {
    lookup_pricing() {
      state.quote = price(parsed);
      const q = state.quote;
      return { currency: q.currency, term: TERMS[q.term].label, months: q.months, lines: q.lines.map((l) => ({ item: l.label, quantity: l.quantity, amount: fmt(l.baseCents, q.currency) })), regionUplift: fmt(q.regionUpliftCents, q.currency), termDiscount: fmt(q.termDiscountCents, q.currency), total: fmt(q.totalCents, q.currency), approvalThreshold: fmt(threshold, "USD"), needsApprovalByPolicy: q.totalCents >= threshold, unresolved: parsed.unresolved, customerName: parsed.customerName };
    },
    apply_discount({ percent, reason }: { percent: unknown; reason: string }) {
      if (!state.quote) return { error: "call lookup_pricing first" };
      const pct = Number(percent);
      if (!Number.isFinite(pct)) return { error: "percent must be a number, e.g. 5 for 5% off" };
      const g = checkDiscount(state.quote, Math.round(pct * 100), typeof reason === "string" ? reason : null);
      if (!g.ok) return { error: g.reason };
      state.quote = withAgentDiscount(price(parsed), g.value.bps);
      state.discountReason = reason;
      return { applied: `${g.value.bps / 100}%`, discount: fmt(state.quote.agentDiscountCents, state.quote.currency), newTotal: fmt(state.quote.totalCents, state.quote.currency), requiresHumanApproval: g.value.needsApproval };
    },
    request_approval({ reason }: { reason: string }) {
      state.escalated = true; state.approvalReason = typeof reason === "string" ? reason.slice(0, 200) : "agent escalation";
      return { escalated: true };
    },
    choose_dunning_strategy({ strategy, reason }: { strategy: string; reason: string }) {
      const g = checkDunning(strategy);
      if (!g.ok) return { error: g.reason };
      state.dunning = g.value; state.dunningReason = typeof reason === "string" ? reason.slice(0, 200) : null;
      return { strategy: g.value, notices: DUNNING_STRATEGIES[g.value].steps };
    },
    finalize({ rationale }: { rationale: string }) {
      state.rationale = typeof rationale === "string" ? rationale.slice(0, 400) : "";
      state.done = true;
      return { ok: true };
    },
  };

  const messages: any[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Request: "${request.slice(0, 500)}"\nParsed: ${JSON.stringify({ lines: parsed.lines, region: parsed.region, term: parsed.term, customerName: parsed.customerName, unresolved: parsed.unresolved })}` },
  ];

  for (let turn = 0; turn < POLICY.maxToolCalls && !state.done; turn++) {
    let res: any;
    try {
      res = await env.AI.run(env.MODEL as any, { messages, tools: TOOLS, max_tokens: 300 });
    } catch (e) {
      trace.push({ tool: "llm", args: "{}", result: JSON.stringify({ error: String(e) }), ok: false });
      break;
    }
    await meter({ prompt_tokens: res?.usage?.prompt_tokens ?? 2500, completion_tokens: res?.usage?.completion_tokens ?? 300 });
    const calls: { id: string; name: string; arguments: any }[] = (res?.tool_calls ?? []).map((c: any, i: number) => ({ id: c.id ?? `call_${turn}_${i}`, name: c.name ?? c.function?.name, arguments: parseArgs(c.arguments ?? c.function?.arguments) }));
    if (!calls.length) {
      // No tool call: treat any text as the rationale if pricing is done, else nudge once.
      if (state.quote) { state.rationale = String(res?.response ?? "").slice(0, 400); state.done = true; break; }
      messages.push({ role: "assistant", content: String(res?.response ?? "") }, { role: "user", content: "Use the tools. Start with lookup_pricing." });
      continue;
    }
    // OpenAI-compatible tool-call shape, which is what Workers AI validates against.
    const used = calls.slice(0, 1);
    messages.push({ role: "assistant", content: "", tool_calls: used.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) });
    for (const c of used) {
      const fn = tools[c.name];
      const result = fn ? safe(() => fn(c.arguments)) : { error: `unknown tool ${c.name}` };
      const ok = !(result && typeof result === "object" && "error" in (result as any));
      trace.push({ tool: c.name, args: JSON.stringify(c.arguments), result: JSON.stringify(result ?? null), ok });
      messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: JSON.stringify(result) });
    }
  }

  if (!state.quote) return { ...planDeterministic(parsed, threshold), trace, llm: trace.length > 0 };
  const discountBps = state.quote.agentDiscountBps;
  const needsApproval = needsHumanApproval(state.quote.totalCents, threshold, state.escalated, discountBps);
  const approvalReason = needsApproval ? (state.approvalReason ?? (discountBps > POLICY.maxAutoDiscountBps ? `discount of ${discountBps / 100}% exceeds the agent's authority` : "at or above the approval threshold")) : null;
  return { quote: state.quote, discountReason: state.discountReason, needsApproval, approvalReason, dunning: state.dunning, dunningReason: state.dunningReason, rationale: state.rationale || "Priced from the catalog; no discount.", trace, llm: true };
}

/** The plan policy alone would produce. Used when the LLM is unavailable or misbehaves. */
export function planDeterministic(parsed: ParsedDeal, thresholdCents: number): Plan {
  const quote = price(parsed);
  const needsApproval = needsHumanApproval(quote.totalCents, thresholdCents, false, 0);
  return { quote, discountReason: null, needsApproval, approvalReason: needsApproval ? "at or above the approval threshold" : null, dunning: "standard", dunningReason: null, rationale: "Priced from the catalog by policy; no discount.", trace: [], llm: false };
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a === "string") { try { return JSON.parse(a); } catch { return {}; } }
  return {};
}
function safe<T>(f: () => T): T | { error: string } { try { return f(); } catch (e) { return { error: String(e) }; } }
