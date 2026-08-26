import { CustomerAccount, type Deal } from "./account";
import { QuoteToCash, type ApprovalEvent } from "./pipeline";
import { parseDeal, parseDeterministic, type ParsedDeal } from "./parse";
import { Budget } from "./budget";
import { price, fmt } from "./pricing";
import { isPaymentMethod, PAYMENT_METHODS, type PaymentMethod } from "./payments";
import { CATALOG, REGIONS, TERMS } from "./catalog";
import { dealsCsv, dealsPdf } from "./export";

export { CustomerAccount, QuoteToCash, Budget };

// Routes (JSON):
//   GET  /api/catalog
//   GET  /api/budget                                     today's AI spend vs cap
//   GET  /api/customers/:id                              snapshot: deals, events, chat
//   POST /api/customers/:id/deals   { message, paymentMethod? }   parse → price → create → start Workflow
//   GET  /api/customers/:id/deals/:dealId                deal + its events + Workflow status
//   POST /api/customers/:id/deals/:dealId/decision { decision, by }   approve / reject
//   DELETE /api/customers/:id                            wipe deals, events and chat (demo reset)
//   GET  /api/customers/:id/export.csv | export.pdf      deal history as a file

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
    if (url.pathname === "/api/budget") return json(await budget.status());
    if (url.pathname === "/api/catalog") return json({ catalog: CATALOG, regions: REGIONS, terms: TERMS, paymentMethods: PAYMENT_METHODS, approvalThresholdCents: Number(env.APPROVAL_THRESHOLD_CENTS), secondsPerDay: Number(env.SECONDS_PER_DAY) });

    const ex = url.pathname.match(/^\/api\/customers\/([\w-]+)\/export\.(csv|pdf)$/);
    if (ex && req.method === "GET") {
      const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ex[1]));
      const stamp = new Date().toISOString().slice(0, 10);
      if (ex[2] === "csv") {
        return new Response(dealsCsv(ex[1], await account.listDeals()), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="deals-${ex[1]}-${stamp}.csv"` } });
      }
      const [deals, events] = await Promise.all([account.listDeals(), account.events()]);
      return new Response(dealsPdf(ex[1], deals, events), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="deals-${ex[1]}-${stamp}.pdf"` } });
    }

    const m = url.pathname.match(/^\/api\/customers\/([\w-]+)(?:\/deals(?:\/([\w-]+)(?:\/(decision))?)?)?$/);
    if (!m) return env.ASSETS.fetch(req);
    const [, customerId, dealId, action] = m;
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(customerId));

    try {
      if (req.method === "GET" && !dealId) return json(await account.snapshot());
      if (req.method === "DELETE" && !dealId) return json({ ok: true, cleared: await account.clearAll() });

      if (req.method === "POST" && !dealId && url.pathname.endsWith("/deals")) {
        const body = await req.json<{ message?: string; paymentMethod?: string }>();
        const message = body.message?.trim();
        if (!message) return bad("message required");

        // Spend guard: an unauthenticated demo gets a daily AI budget, a per-IP quota and a burst
        // limit. Over any of them, a deterministic parser takes over and the reply says so.
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        const verdict = await budget.check(ip);
        if (!verdict.ok && verdict.reason === "burst") return json({ error: "one quote per second, please" }, 429);
        let parsed: ParsedDeal; let llm = true;
        if (verdict.ok) {
          const r = await parseDeal(env, message);
          parsed = r.deal;
          await budget.record(ip, r.usage);
        } else {
          parsed = parseDeterministic(message); llm = false;
        }
        await account.appendChat("user", message);
        if (!parsed.lines.length) {
          const reply = `I couldn't find any products in that. ${parsed.unresolved.join("; ") || ""} Try e.g. "50 Pro seats, 20 TB egress, EU, annual".` + (llm ? "" : "\n\n_Parsed without the LLM — today's AI budget is used up._");
          await account.appendChat("assistant", reply);
          return json({ ok: false, reply, parsed, llm });
        }
        const paymentMethod: PaymentMethod = isPaymentMethod(body.paymentMethod) ? body.paymentMethod
          : isPaymentMethod(parsed.paymentMethod) ? parsed.paymentMethod : "card_ok";
        const quote = price(parsed);
        const id = `deal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const now = Date.now();
        const deal: Deal = {
          id, customerId, request: message, parsed, quote, paymentMethod, status: "quoted",
          needsApproval: quote.totalCents >= Number(env.APPROVAL_THRESHOLD_CENTS),
          approval: null, invoice: null, workflowId: null, createdAt: now, updatedAt: now,
        };
        await account.createDeal(deal);
        const inst = await env.PIPELINE.create({ id, params: { customerId, dealId: id } });
        await account.setWorkflow(id, inst.id);

        const reply = describe(deal) + (llm ? "" : `\n\n_Parsed without the LLM — ${verdict.ok ? "" : verdict.reason === "daily_cap" ? "today's AI budget is used up" : "you've hit today's per-visitor limit"}; a keyword parser handled this one._`);
        await account.appendChat("assistant", reply);
        return json({ ok: true, deal, reply, workflowId: inst.id, llm });
      }

      if (dealId && !action && req.method === "GET") {
        const deal = await account.getDeal(dealId);
        if (!deal) return json({ error: "not found" }, 404);
        const status = deal.workflowId ? await (await env.PIPELINE.get(deal.workflowId)).status() : null;
        return json({ deal, events: await account.events(dealId), workflow: status });
      }

      if (dealId && action === "decision" && req.method === "POST") {
        const body = await req.json<Partial<ApprovalEvent>>();
        const decision = body.decision === "rejected" ? "rejected" : "approved";
        const deal = await account.getDeal(dealId);
        if (!deal?.workflowId) return json({ error: "not found" }, 404);
        if (deal.status !== "pending_approval") return bad(`deal is ${deal.status}, not pending approval`);
        const inst = await env.PIPELINE.get(deal.workflowId);
        const payload: ApprovalEvent = { decision, by: body.by?.slice(0, 60) || "anonymous" };
        await inst.sendEvent({ type: "approval", payload });
        return json({ ok: true, sent: payload });
      }

      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** The assistant's reply is assembled from priced numbers by code — the model never phrases money. */
function describe(d: Deal): string {
  const q = d.quote;
  const $ = (c: number) => fmt(c, q.currency);
  const lines = q.lines.map((l) => `• ${l.quantity.toLocaleString()} × ${l.label} @ ${$(l.unitCents)}/${l.unit}/mo = ${$(l.baseCents)}`).join("\n");
  const adj = [
    q.regionUpliftCents ? `${q.region} uplift +${$(q.regionUpliftCents)}` : `${q.region} (no uplift)`,
    q.termDiscountCents ? `${TERMS[q.term].label} −${$(q.termDiscountCents)}` : TERMS[q.term].label,
    q.currency === "EUR" ? "quoted in EUR at the price-book rate" : "",
  ].filter(Boolean).join(", ");
  const gate = d.needsApproval ? `This is at or above the approval threshold, so it's waiting for a human to approve.` : `Under the approval threshold — auto-approved by policy; invoicing now.`;
  const warn = d.parsed.unresolved.length ? `\n⚠ ${d.parsed.unresolved.join("; ")}` : "";
  return [
    `**Quote ${d.id}**${d.parsed.customerName ? ` for ${d.parsed.customerName}` : ""} · ${q.months}-month term`,
    lines,
    adj,
    `**Total: ${$(q.totalCents)}**`,
    gate + warn,
  ].join("\n\n");
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string) => json({ error: msg }, 400);
