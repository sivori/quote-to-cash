import { DurableObject } from "cloudflare:workers";
import type { Quote } from "./pricing";
import type { ParsedDeal } from "./parse";
import type { ChargeResult, PaymentMethod } from "./payments";

// One CustomerAccount per customer. It is the system of record for every deal the customer has
// had: the parsed request, the priced quote, the approval decision, the invoice, every payment
// attempt, and every notification sent. A Durable Object is single-threaded per instance, so
// "exactly one invoice per deal" and "approval recorded once" are true, not hopeful.

export type DealStatus =
  | "quoted" | "pending_approval" | "approved" | "rejected"
  | "invoiced" | "paid" | "past_due" | "collections";

export interface Deal {
  id: string;
  customerId: string;
  request: string;
  parsed: ParsedDeal;
  quote: Quote;
  paymentMethod: PaymentMethod;
  status: DealStatus;
  needsApproval: boolean;
  approval: { decision: "approved" | "rejected"; by: string; at: number; auto: boolean } | null;
  invoice: { id: string; amountCents: number; issuedAt: number; dueAt: number } | null;
  workflowId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Event {
  seq: number;
  dealId: string;
  ts: number;
  kind: "deal.created" | "quote.priced" | "approval.requested" | "approval.decided" | "invoice.issued"
      | "payment.attempted" | "payment.succeeded" | "payment.failed" | "dunning.scheduled"
      | "notification.sent" | "deal.collections";
  detail: Record<string, unknown>;
}

export class CustomerAccount extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      -- Append-only audit log. No UPDATE or DELETE path exists for this table.
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_deal ON events(deal_id, seq);
      CREATE TABLE IF NOT EXISTS chat (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL
      );
    `);
  }

  // ── deals ─────────────────────────────────────────────────────────────
  createDeal(deal: Deal): Deal {
    this.sql.exec("INSERT INTO deals(id,json,status,created_at) VALUES(?,?,?,?)", deal.id, JSON.stringify(deal), deal.status, deal.createdAt);
    this.log(deal.id, "deal.created", { request: deal.request, customerName: deal.parsed.customerName });
    this.log(deal.id, "quote.priced", { totalCents: deal.quote.totalCents, region: deal.quote.region, term: deal.quote.term });
    return deal;
  }

  getDeal(id: string): Deal | null {
    const r = this.sql.exec("SELECT json FROM deals WHERE id=?", id).toArray()[0];
    return r ? (JSON.parse(r.json as string) as Deal) : null;
  }

  listDeals(): Deal[] {
    return this.sql.exec("SELECT json FROM deals ORDER BY created_at DESC").toArray().map((r) => JSON.parse(r.json as string));
  }

  private save(deal: Deal) {
    deal.updatedAt = Date.now();
    this.sql.exec("UPDATE deals SET json=?, status=? WHERE id=?", JSON.stringify(deal), deal.status, deal.id);
  }

  setWorkflow(dealId: string, workflowId: string) {
    const d = this.must(dealId); d.workflowId = workflowId; this.save(d);
  }

  // ── approval ──────────────────────────────────────────────────────────
  requestApproval(dealId: string): Deal {
    const d = this.must(dealId);
    if (d.status === "quoted") { d.status = "pending_approval"; this.save(d); this.log(dealId, "approval.requested", { totalCents: d.quote.totalCents }); }
    return d;
  }

  /** Idempotent: a second decision on a decided deal is ignored, and returns the first. */
  decide(dealId: string, decision: "approved" | "rejected", by: string, auto: boolean): Deal {
    const d = this.must(dealId);
    if (d.approval) return d;
    d.approval = { decision, by, at: Date.now(), auto };
    d.status = decision;
    this.save(d);
    this.log(dealId, "approval.decided", { decision, by, auto });
    return d;
  }

  // ── invoice + payments ────────────────────────────────────────────────
  /** Idempotent: exactly one invoice per deal. */
  issueInvoice(dealId: string, dueDays: number): Deal {
    const d = this.must(dealId);
    if (d.invoice) return d;
    const now = Date.now();
    d.invoice = { id: `inv_${dealId}`, amountCents: d.quote.totalCents, issuedAt: now, dueAt: now + dueDays * 86_400_000 };
    d.status = "invoiced";
    this.save(d);
    this.log(dealId, "invoice.issued", { invoiceId: d.invoice.id, amountCents: d.invoice.amountCents });
    return d;
  }

  recordPayment(dealId: string, result: ChargeResult): Deal {
    const d = this.must(dealId);
    this.log(dealId, "payment.attempted", { attempt: result.attempt, reference: result.reference });
    if (result.ok) {
      d.status = "paid";
      this.log(dealId, "payment.succeeded", { attempt: result.attempt, amountCents: result.amountCents, reference: result.reference });
    } else {
      d.status = "past_due";
      this.log(dealId, "payment.failed", { attempt: result.attempt, code: result.code, retryable: result.retryable });
    }
    this.save(d);
    return d;
  }

  scheduleDunning(dealId: string, attempt: number, afterDays: number, level: string) {
    this.log(dealId, "dunning.scheduled", { nextAttempt: attempt, afterDays, level });
  }

  notify(dealId: string, level: string, channel: string, message: string) {
    this.log(dealId, "notification.sent", { level, channel, message });
  }

  sendToCollections(dealId: string, reason: string): Deal {
    const d = this.must(dealId);
    d.status = "collections"; this.save(d);
    this.log(dealId, "deal.collections", { reason });
    return d;
  }

  // ── history / memory ──────────────────────────────────────────────────
  events(dealId?: string): Event[] {
    const rows = dealId
      ? this.sql.exec("SELECT * FROM events WHERE deal_id=? ORDER BY seq", dealId)
      : this.sql.exec("SELECT * FROM events ORDER BY seq DESC LIMIT 200");
    return rows.toArray().map((r) => ({ seq: Number(r.seq), dealId: r.deal_id as string, ts: Number(r.ts), kind: r.kind as Event["kind"], detail: JSON.parse(r.detail as string) }));
  }

  appendChat(role: "user" | "assistant", content: string) {
    this.sql.exec("INSERT INTO chat(role,content,ts) VALUES(?,?,?)", role, content, Date.now());
  }
  recentChat(limit = 20) {
    return this.sql.exec("SELECT role,content,ts FROM (SELECT * FROM chat ORDER BY seq DESC LIMIT ?) ORDER BY seq", limit).toArray()
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content as string, ts: Number(r.ts) }));
  }

  /** Everything the UI (and a future explain-my-deal LLM) may see. */
  snapshot() {
    return { deals: this.listDeals(), events: this.events(), chat: this.recentChat() };
  }

  private must(id: string): Deal {
    const d = this.getDeal(id);
    if (!d) throw new Error(`no deal ${id}`);
    return d;
  }
  private log(dealId: string, kind: Event["kind"], detail: Record<string, unknown>) {
    this.sql.exec("INSERT INTO events(deal_id,ts,kind,detail) VALUES(?,?,?,?)", dealId, Date.now(), kind, JSON.stringify(detail));
  }
}
