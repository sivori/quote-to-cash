import { CustomerAccount, type Deal } from "./account";
import { QuoteToCash, type ApprovalEvent } from "./pipeline";
import { parseDeal } from "./parse";
import { price, fmt } from "./pricing";
import { isPaymentMethod, PAYMENT_METHODS, type PaymentMethod } from "./payments";
import { CATALOG, REGION_BPS, TERMS } from "./catalog";

export { CustomerAccount, QuoteToCash };

// Routes (JSON):
//   GET  /api/catalog
//   GET  /api/customers/:id                              snapshot: deals, events, chat
//   POST /api/customers/:id/deals   { message, paymentMethod? }   parse → price → create → start Workflow
//   GET  /api/customers/:id/deals/:dealId                deal + its events + Workflow status
//   POST /api/customers/:id/deals/:dealId/decision { decision, by }   approve / reject

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/catalog") return json({ catalog: CATALOG, regions: REGION_BPS, terms: TERMS, paymentMethods: PAYMENT_METHODS, approvalThresholdCents: Number(env.APPROVAL_THRESHOLD_CENTS), secondsPerDay: Number(env.SECONDS_PER_DAY) });

    const m = url.pathname.match(/^\/api\/customers\/([\w-]+)(?:\/deals(?:\/([\w-]+)(?:\/(decision))?)?)?$/);
    if (!m) return env.ASSETS.fetch(req);
    const [, customerId, dealId, action] = m;
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(customerId));

    try {
      if (req.method === "GET" && !dealId) return json(await account.snapshot());

      if (req.method === "POST" && !dealId && url.pathname.endsWith("/deals")) {
        const body = await req.json<{ message?: string; paymentMethod?: string }>();
        const message = body.message?.trim();
        if (!message) return bad("message required");

        const parsed = await parseDeal(env, message);
        await account.appendChat("user", message);
        if (!parsed.lines.length) {
          const reply = `I couldn't find any products in that. ${parsed.unresolved.join("; ") || ""} Try e.g. "50 Pro seats, 20 TB egress, EU, annual".`;
          await account.appendChat("assistant", reply);
          return json({ ok: false, reply, parsed });
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

        const reply = describe(deal);
        await account.appendChat("assistant", reply);
        return json({ ok: true, deal, reply, workflowId: inst.id });
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
  const lines = q.lines.map((l) => `• ${l.quantity.toLocaleString()} × ${l.label} @ ${fmt(l.unitCents)}/${l.unit}/mo = ${fmt(l.baseCents)}`).join("\n");
  const adj = [
    q.regionUpliftCents ? `${q.region} uplift +${fmt(q.regionUpliftCents)}` : `${q.region} (no uplift)`,
    q.termDiscountCents ? `${TERMS[q.term].label} −${fmt(q.termDiscountCents)}` : TERMS[q.term].label,
  ].join(", ");
  const gate = d.needsApproval ? `This is at or above the approval threshold, so it's waiting for a human to approve.` : `Under the approval threshold — auto-approved by policy; invoicing now.`;
  const warn = d.parsed.unresolved.length ? `\n⚠ ${d.parsed.unresolved.join("; ")}` : "";
  return `Quote ${d.id}${d.parsed.customerName ? ` for ${d.parsed.customerName}` : ""} — ${q.months}-month term\n${lines}\n${adj}\nTotal: ${fmt(q.totalCents)}\n${gate}${warn}`;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string) => json({ error: msg }, 400);
