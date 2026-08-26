// Deterministic payment simulator. Outcomes are scripted by the payment method token so the demo
// is repeatable and dunning can be shown on demand. Swapping this for Stripe means implementing
// `charge` against PaymentIntents and keeping the same result shape.

export type PaymentMethod = "card_ok" | "card_decline_then_ok" | "card_decline" | "card_insufficient_funds";
export const PAYMENT_METHODS: { id: PaymentMethod; label: string; behaviour: string }[] = [
  { id: "card_ok", label: "Visa ···4242", behaviour: "always succeeds" },
  { id: "card_decline_then_ok", label: "Visa ···0341", behaviour: "declines twice, succeeds on the third attempt" },
  { id: "card_insufficient_funds", label: "Visa ···9995", behaviour: "insufficient funds until attempt 4" },
  { id: "card_decline", label: "Visa ···0002", behaviour: "always declines" },
];

export interface ChargeResult {
  ok: boolean;
  attempt: number;
  amountCents: number;
  /** Processor-style code. `retryable` tells dunning whether to bother. */
  code: "approved" | "card_declined" | "insufficient_funds" | "do_not_honor";
  retryable: boolean;
  reference: string;
}

export function isPaymentMethod(x: unknown): x is PaymentMethod {
  return PAYMENT_METHODS.some((m) => m.id === x);
}

export function charge(method: PaymentMethod, amountCents: number, attempt: number, dealId: string): ChargeResult {
  const reference = `ch_${dealId}_${attempt}`;
  const ok = (code: ChargeResult["code"] = "approved"): ChargeResult => ({ ok: true, attempt, amountCents, code, retryable: false, reference });
  const fail = (code: ChargeResult["code"], retryable: boolean): ChargeResult => ({ ok: false, attempt, amountCents, code, retryable, reference });
  switch (method) {
    case "card_ok": return ok();
    case "card_decline_then_ok": return attempt >= 3 ? ok() : fail("card_declined", true);
    case "card_insufficient_funds": return attempt >= 4 ? ok() : fail("insufficient_funds", true);
    case "card_decline": return fail("do_not_honor", false);
  }
}

/**
 * Dunning schedule, in days after the failed attempt. Escalation is part of the schedule:
 * each retry is preceded by a notification of increasing severity.
 */
export const DUNNING: { afterDays: number; level: "reminder" | "warning" | "final_notice" }[] = [
  { afterDays: 1, level: "reminder" },
  { afterDays: 3, level: "warning" },
  { afterDays: 7, level: "final_notice" },
];

/** Translate a day count into a Workflow sleep string under the deployment's time scale. */
export function sleepFor(days: number, secondsPerDay: number): `${number} seconds` {
  return `${Math.max(1, Math.round(days * secondsPerDay))} seconds`;
}
