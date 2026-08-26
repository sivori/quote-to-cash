import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { charge, sleepFor } from "./payments";
import { DUNNING_STRATEGIES } from "./policy";
import { fmt } from "./pricing";

// Executes the agent's plan durably. The Workflow makes no decisions: it waits for the human
// when the plan says so, issues the invoice, charges, and sleeps between retries on the
// schedule the plan chose. One instance per deal (instance id = deal id), so a re-submitted deal
// resumes rather than duplicates; every step is idempotent against the CustomerAccount.

export interface PipelineParams { customerId: string; dealId: string }
export interface ApprovalEvent { decision: "approved" | "rejected"; by: string }

export class QuoteToCash extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { customerId, dealId } = event.payload;
    const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(customerId));
    const secondsPerDay = Number(this.env.SECONDS_PER_DAY);

    // 1. Record the plan's approval decision. (The decision was made by policy + agent up front.)
    const policy = await step.do("policy", async () => {
      const deal = await account.getDeal(dealId);
      if (!deal) throw new Error(`deal ${dealId} not found`);
      const needsHuman = deal.plan.needsApproval;
      if (!needsHuman) await account.decide(dealId, "approved", "policy", true);
      else await account.requestApproval(dealId);
      return { needsHuman, totalCents: deal.quote.totalCents, dunning: deal.plan.dunning as string };
    });
    const DUNNING = (DUNNING_STRATEGIES as Record<string, { steps: { afterDays: number; level: "reminder" | "warning" | "final_notice" }[] }>)[policy.dunning]?.steps ?? DUNNING_STRATEGIES.standard.steps;

    // 2. Approval gate. The Durable Object holds pending state; the Workflow sleeps on the event.
    if (policy.needsHuman) {
      const approval = await step.waitForEvent<ApprovalEvent>("approval", { type: "approval", timeout: "7 days" });
      const decided = await step.do("record-decision", async () =>
        account.decide(dealId, approval.payload.decision, approval.payload.by, false));
      if (decided.approval?.decision === "rejected") {
        await step.do("notify-rejection", async () => {
          await account.notify(dealId, "info", "email", `Quote ${dealId} was not approved.`);
        });
        return { dealId, outcome: "rejected" as const };
      }
    }

    // 3. Invoice. Exactly one per deal.
    const invoice = await step.do("invoice", async () => {
      const d = await account.issueInvoice(dealId, 30);
      await account.notify(dealId, "info", "email", `Invoice ${d.invoice!.id} for ${fmt(d.invoice!.amountCents, d.invoice!.currency)} issued.`);
      return d.invoice!;
    });

    // 4. Payment, then dunning. Attempt 1 is immediate; each retry waits per the schedule and is
    //    preceded by an escalating notification. Non-retryable failures go straight to collections.
    const attempts = 1 + DUNNING.length;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await step.do(`charge-${attempt}`, async () => {
        const d = await account.getDeal(dealId);
        if (!d) throw new Error("deal vanished");
        if (d.status === "paid") return { ok: true, attempt, amountCents: invoice.amountCents, code: "approved" as const, retryable: false, reference: "already-paid" };
        const r = charge(d.paymentMethod, invoice.amountCents, attempt, dealId);
        await account.recordPayment(dealId, r);
        return r;
      });

      if (result.ok) {
        await step.do("notify-receipt", async () => {
          await account.notify(dealId, "info", "email", `Payment of ${fmt(result.amountCents, invoice.currency)} received (${result.reference}). Thank you.`);
        });
        return { dealId, outcome: "paid" as const, attempt };
      }

      const next = DUNNING[attempt - 1];
      if (!result.retryable || !next) {
        await step.do("collections", async () => {
          await account.notify(dealId, "final", "email+account_manager", `Payment could not be collected after ${attempt} attempt(s). Account referred to collections.`);
          await account.sendToCollections(dealId, result.retryable ? "dunning exhausted" : `non-retryable: ${result.code}`);
        });
        return { dealId, outcome: "collections" as const, attempt };
      }

      await step.do(`dunning-${attempt}`, async () => {
        await account.scheduleDunning(dealId, attempt + 1, next.afterDays, next.level);
        const channel = next.level === "final_notice" ? "email+sms+account_manager" : next.level === "warning" ? "email+sms" : "email";
        await account.notify(dealId, next.level, channel, dunningMessage(next.level, fmt(invoice.amountCents, invoice.currency), next.afterDays, result.code));
      });
      await step.sleep(`wait-${attempt}`, sleepFor(next.afterDays, secondsPerDay));
    }
    return { dealId, outcome: "collections" as const, attempt: attempts };
  }
}

function dunningMessage(level: string, amt: string, days: number, code: string): string {
  switch (level) {
    case "reminder": return `Your payment of ${amt} did not go through (${code}). We'll retry in ${days} day(s); no action needed if your card is current.`;
    case "warning": return `Second attempt to collect ${amt} failed (${code}). Please update your payment method; we'll retry in ${days} day(s).`;
    default: return `FINAL NOTICE: ${amt} remains unpaid (${code}). Service will be suspended if the retry in ${days} day(s) fails.`;
  }
}
