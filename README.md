# Quote to Cash

**A quote-to-cash pipeline on Cloudflare's developer platform.** Type a deal in plain English; an LLM structures it, deterministic code prices it, and a Workflow carries it through approval, invoicing, payment and dunning — pausing for a human when the number is big enough.

[![CI](https://github.com/sivori/quote-to-cash/actions/workflows/ci.yml/badge.svg)](https://github.com/sivori/quote-to-cash/actions/workflows/ci.yml) &nbsp; **Live demo → [quote-to-cash.csivori.workers.dev](https://quote-to-cash.csivori.workers.dev)**

```
"50 Pro seats, 20 TB egress, EU, annual"
        │
        ▼  Workers AI (Llama 3.3, JSON-schema output) — names SKUs, quantities, region, term. No prices.
   ParsedDeal ──▶ price()  pure, integer cents, catalog-driven ──▶ Quote  $29,172.00
        │
        ▼  CustomerAccount (Durable Object · SQLite): deals, append-only event log, chat memory
        │
        ▼  QuoteToCash (Workflow, one instance per deal)
   policy ─▶ [ ≥ threshold? waitForEvent("approval") ] ─▶ invoice ─▶ charge ─▶ paid
                                                                        │ fail
                                                          reminder (1d) → retry → warning (3d) → retry → final notice (7d) → retry → collections
```

## What it demonstrates

| Requirement | Implementation |
|---|---|
| Natural-language deal → structured quote | [`src/parse.ts`](src/parse.ts): Llama 3.3 with a JSON schema, then `validate()` maps output onto the catalog. Unknown products are *reported*, never guessed. |
| Pricing | [`src/pricing.ts`](src/pricing.ts) + [`src/catalog.ts`](src/catalog.ts): integer cents, basis-point uplifts and discounts, round-half-up. The model never sees a price. |
| Workflow orchestration | [`src/pipeline.ts`](src/pipeline.ts): policy → approval → invoice → payment → dunning, each step idempotent against the account. |
| Approval on `waitForEvent` | The account DO holds `pending_approval`; the Workflow sleeps until `/decision` sends an event. Under the threshold, policy auto-approves. |
| Simulated payment + dunning | [`src/payments.ts`](src/payments.ts): scripted test cards; a 1d / 3d / 7d schedule with escalating notifications (email → email+sms → email+sms+account manager), then collections. |
| Per-customer memory | Every deal, decision, attempt and notification in the customer's Durable Object. The chat history lives there too. |

## Production-shaped choices

- **Instance id = deal id.** Re-submitting a deal resumes its Workflow instead of creating a second one.
- **Exactly one invoice per deal, exactly one decision.** Enforced in the Durable Object, not by convention.
- **The event log is append-only.** No UPDATE or DELETE path exists. Status is derived by writing new events.
- **Time is a deployment setting.** The dunning schedule is written in days; `SECONDS_PER_DAY` makes one day take 5 s in the demo and 86 400 s in production. Same code path.
- **Failures are typed.** A `do_not_honor` decline is non-retryable and goes straight to collections; `card_declined` retries. Dunning reads the processor's word for it.
- **The LLM has a narrow job.** Extract names and numbers into a schema. Pricing, policy, and every message a customer would receive are produced by code.

## Try it

Chips in the UI cover the paths: a small deal that auto-approves, the canonical deal that needs a human, a 3-year APAC deal, and a request the model can't map. The **pay with** selector scripts the payment outcome:

| Card | Behaviour |
|---|---|
| Visa ···4242 | succeeds |
| Mastercard ···0341 | declines twice, pays on the third attempt (watch the reminder and warning go out) |
| Amex ···9995 | insufficient funds until the fourth attempt (final notice) |
| Discover ···0002 | `do_not_honor` — straight to collections |

## Run it

```bash
npm install
npm test            # pricing, parser validation, payment scripting, dunning clock
npm run dev         # http://localhost:8787 — Workers AI runs remotely even in dev (wrangler login)
scripts/demo.sh     # two deals end to end against the dev server
npm run deploy
```

Config lives in [`wrangler.jsonc`](wrangler.jsonc): `APPROVAL_THRESHOLD_CENTS`, `SECONDS_PER_DAY`, `MODEL`.

## What's deliberately out of scope

Real payments (the simulator's `charge()` has the shape a Stripe PaymentIntents call would replace), tax, multi-currency, and a customer-facing explain-my-invoice assistant. Each is a bounded addition; none changes the pipeline.

## How it was built

With Claude Code. The assignment asks for prompt history; every prompt is in [`PROMPTS.md`](PROMPTS.md), verbatim and in order.
