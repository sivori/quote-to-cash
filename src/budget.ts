import { DurableObject } from "cloudflare:workers";
import { costMicros, type Usage } from "./cost";
export type { Usage };

// Spend guard for an unauthenticated demo. One singleton Durable Object meters every Workers AI
// call from the `usage` the model returns, prices it at the published per-token rates, and
// refuses once the UTC day's total reaches the cap. It also keeps a per-IP daily quota and a
// short burst limit so one visitor cannot spend the whole budget.
//
// Everything is in micro-dollars (1e-6 USD) as integers; no floats touch the ledger.

export interface BudgetStatus {
  day: string;
  spentMicros: number;
  capMicros: number;
  calls: number;
  llmAvailable: boolean;
  resetsAt: string;
}
export type Verdict = { ok: true } | { ok: false; reason: "daily_cap" | "ip_quota" | "burst" };

export class Budget extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, micros INTEGER NOT NULL, calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ip (day TEXT NOT NULL, ip TEXT NOT NULL, calls INTEGER NOT NULL, last_ts INTEGER NOT NULL, PRIMARY KEY (day, ip));
    `);
  }

  private cfg() {
    return {
      capMicros: Math.round(Number(this.env.AI_DAILY_CAP_USD) * 1_000_000),
      ipDaily: Number(this.env.AI_IP_DAILY_QUOTES),
      burstMs: Number(this.env.AI_BURST_MS),
    };
  }

  /** Called before an LLM call. Reserves nothing; the price of a call is only known afterwards. */
  check(ip: string): Verdict {
    const { capMicros, ipDaily, burstMs } = this.cfg();
    const day = today();
    const s = this.spendRow(day);
    if (s.micros >= capMicros) return { ok: false, reason: "daily_cap" };
    const r = this.sql.exec("SELECT calls, last_ts FROM ip WHERE day=? AND ip=?", day, ip).toArray()[0];
    if (r && Number(r.calls) >= ipDaily) return { ok: false, reason: "ip_quota" };
    if (r && Date.now() - Number(r.last_ts) < burstMs) return { ok: false, reason: "burst" };
    return { ok: true };
  }

  /**
   * Called after every LLM call with the usage the model reported. Spend is per call; the per-IP
   * quota counts quotes, not calls — an agent loop makes several calls per quote, and a visitor
   * should be limited by how many deals they run, not by how much the agent thought.
   */
  record(ip: string, usage: Usage, opts: { newQuote?: boolean } = {}): BudgetStatus {
    const day = today();
    const micros = costMicros(usage, Number(this.env.AI_PRICE_IN_PER_M), Number(this.env.AI_PRICE_OUT_PER_M));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO spend(day,prompt_tokens,completion_tokens,micros,calls) VALUES(?,?,?,?,1)
         ON CONFLICT(day) DO UPDATE SET prompt_tokens=prompt_tokens+excluded.prompt_tokens, completion_tokens=completion_tokens+excluded.completion_tokens, micros=micros+excluded.micros, calls=calls+1`,
        day, usage.prompt_tokens, usage.completion_tokens, micros,
      );
      if (opts.newQuote) this.sql.exec(
        `INSERT INTO ip(day,ip,calls,last_ts) VALUES(?,?,1,?) ON CONFLICT(day,ip) DO UPDATE SET calls=calls+1, last_ts=excluded.last_ts`,
        day, ip, Date.now(),
      );
    });
    return this.status();
  }

  status(): BudgetStatus {
    const { capMicros } = this.cfg();
    const day = today();
    const s = this.spendRow(day);
    const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
    return { day, spentMicros: s.micros, capMicros, calls: s.calls, llmAvailable: s.micros < capMicros, resetsAt: reset.toISOString() };
  }

  private spendRow(day: string) {
    const r = this.sql.exec("SELECT micros, calls FROM spend WHERE day=?", day).toArray()[0];
    return { micros: r ? Number(r.micros) : 0, calls: r ? Number(r.calls) : 0 };
  }
}

export function today() { return new Date().toISOString().slice(0, 10); }

