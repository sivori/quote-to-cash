<p align="center"><img src="public/brand/mark.png" width="96" height="96" alt="Quote to Cash logo: an orange speech bubble overlapping a coin"></p>

# Quote to Cash

**Type a deal in plain English. Watch it get quoted, approved, invoiced, and paid — on Cloudflare.**

[![CI](https://github.com/sivori/quote-to-cash/actions/workflows/ci.yml/badge.svg)](https://github.com/sivori/quote-to-cash/actions/workflows/ci.yml) &nbsp; **Live demo → [quote-to-cash.csivori.workers.dev](https://quote-to-cash.csivori.workers.dev)**

[![Quote to Cash screenshot](docs/screenshot.png)](https://quote-to-cash.csivori.workers.dev)

## How it works

```
"50 Pro seats, 20 TB egress, EU, annual"
        │
        ▼  Llama 3.3 (Workers AI) extracts products, quantities, region, term — never prices
        ▼  price() rates it from the catalog in integer cents           →  26.838,24 €
        ▼  CustomerAccount (Durable Object) records the deal
        ▼  QuoteToCash (Workflow, one per deal)
           policy ─▶ approval (pauses for a human ≥ $10k) ─▶ invoice ─▶ charge ─▶ paid
                                                                          │ declined
                                     reminder · 1d · retry · warning · 3d · retry · final notice · 7d · retry · collections
```

| Cloudflare service | Used for |
|---|---|
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | Llama 3.3 with JSON-schema output, parsing the sentence into a structured deal |
| [Workflows](https://developers.cloudflare.com/workflows/) | The pipeline: durable steps, `waitForEvent` for approval, `sleep` for dunning backoff |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | Per-customer deal history, event log and chat memory; a singleton spend guard |
| [Workers](https://developers.cloudflare.com/workers/) + Static Assets | API and the UI |

## Try it in two minutes

1. Open the [demo](https://quote-to-cash.csivori.workers.dev) and click the chip **5 Pro seats monthly in the US**. It's under the approval threshold, so it auto-approves, invoices, and pays — expand the deal to see each step.
2. In the header, switch **Pay with** to *Mastercard ···0341* (declines twice), then click **50 Pro seats, 20 TB egress, EU, annual**. It's €26,838 — over the threshold — so the Workflow pauses. Click **Approve**. Watch the decline, the reminder, the retry, the warning, and the payment on attempt 3. Dunning days run at 5 s each in the demo.
3. Click **Export** for the deal history as CSV or PDF.

| Test card | Behaviour |
|---|---|
| Visa ···4242 | pays first time |
| Mastercard ···0341 | declines twice, pays on the third attempt |
| Amex ···9995 | insufficient funds until the fourth attempt |
| Discover ···0002 | `do_not_honor` — straight to collections |

## Design decisions

- **The model names things; code prices them.** Llama 3.3 returns SKUs, quantities, region and term into a schema. `validate()` maps them onto the catalog and *reports* anything it can't, rather than guessing. Every amount, message, and policy decision comes from code. ([`parse.ts`](src/parse.ts), [`pricing.ts`](src/pricing.ts), [`catalog.ts`](src/catalog.ts))
- **Money is integers.** Cents, basis points, round-half-up. EU deals are priced in EUR at a price-book FX rate, and every quote and invoice is stamped with that rate and the price-book version, so an invoice still explains itself after the book changes.
- **Idempotent everywhere.** Workflow instance id = deal id, so a resubmitted deal resumes rather than duplicates. Exactly one invoice and one decision per deal, enforced in the Durable Object. The event log is append-only. ([`account.ts`](src/account.ts), [`pipeline.ts`](src/pipeline.ts))
- **Dunning reads the processor's word.** `card_declined` retries on a 1d / 3d / 7d schedule with escalating notices; `do_not_honor` goes straight to collections. Days are a deployment setting (`SECONDS_PER_DAY`), so the same code runs in seconds here and in days in production. ([`payments.ts`](src/payments.ts))
- **A public demo needs a spend guard.** A singleton `Budget` Durable Object meters every LLM call from the model's reported usage at Workers AI's [published rates](https://developers.cloudflare.com/workers-ai/platform/pricing/): $5 per day overall, 40 quotes per IP, one per second. Past the cap a keyword parser takes over and the reply says so; the footer shows today's spend. ([`budget.ts`](src/budget.ts))

## Run it

```bash
npm install
npm test          # pricing, parser validation, payments, dunning clock, exports, budget
npm run dev       # http://localhost:8787 — Workers AI runs remotely even in dev (wrangler login)
scripts/demo.sh   # two deals end to end against the dev server
npm run deploy
```

Settings are in [`wrangler.jsonc`](wrangler.jsonc): approval threshold, seconds per day, model, AI budget.

## Not in scope

Real payments (`charge()` has the shape a Stripe PaymentIntents call would replace), tax, and login. Each is a bounded addition; none changes the pipeline.

## How it was built

With Claude Code, prompt by prompt. Every prompt is in [`PROMPTS.md`](PROMPTS.md), verbatim and in order. The UX pass against Cloudflare's own design system is in [`docs/ux-review.md`](docs/ux-review.md).
