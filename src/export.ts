// Deal-history exports. CSV is a straight table; the PDF is written by a tiny dependency-free
// writer (core Helvetica fonts, text only) — enough for a statement, and nothing to bundle.
import type { Deal, Event } from "./account";
import { fmt } from "./pricing";
import { TERMS, type Currency } from "./catalog";

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : "");

export function dealsCsv(customerId: string, deals: Deal[]): string {
  const cols = ["deal_id", "customer", "created_at", "status", "customer_name", "region", "term", "months", "line_items", "currency", "subtotal", "region_uplift", "term_discount", "total", "approval", "approved_by", "invoice_id", "invoice_issued_at", "payment_method", "request"];
  const rows = deals.map((d) => [
    d.id, customerId, iso(d.createdAt), d.status, d.parsed.customerName ?? "", d.quote.region, d.quote.term, d.quote.months,
    d.quote.lines.map((l) => `${l.quantity} x ${l.label}`).join("; "), d.quote.currency,
    cents(d.quote.subtotalCents), cents(d.quote.regionUpliftCents), cents(-d.quote.termDiscountCents), cents(d.quote.totalCents),
    d.approval?.decision ?? "", d.approval ? (d.approval.auto ? "policy" : d.approval.by) : "",
    d.invoice?.id ?? "", iso(d.invoice?.issuedAt), d.paymentMethod, d.request,
  ]);
  return [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const cents = (c: number) => (c / 100).toFixed(2);
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  // Guard against spreadsheet formula injection (a plain number such as -5148.00 is not a formula).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ── PDF ───────────────────────────────────────────────────────────────────

export function dealsPdf(customerId: string, deals: Deal[], events: Event[]): Uint8Array {
  const doc = new Pdf();
  doc.text(`Deal history — ${customerId}`, 18, true);
  doc.text(`Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · ${deals.length} deal(s)`, 9, false, 0.45);
  doc.gap(6);
  if (!deals.length) doc.text("No deals.", 11);

  for (const d of deals) {
    const $ = (c: number) => fmt(c, d.quote.currency);
    doc.rule();
    doc.text(`${d.id}   ${$(d.quote.totalCents)}   ${STATUS[d.status] ?? d.status}`, 12, true);
    doc.text(`"${d.request}"`, 9.5, false, 0.45);
    doc.text(`${d.parsed.customerName ? d.parsed.customerName + " · " : ""}${d.quote.region} · ${TERMS[d.quote.term].label} · ${d.quote.months} month(s) · created ${iso(d.createdAt).slice(0, 16).replace("T", " ")}`, 9.5, false, 0.45);
    doc.gap(2);
    for (const l of d.quote.lines) doc.cols([`${l.quantity.toLocaleString("en-US")} × ${l.label} @ ${$(l.unitCents)}/${l.unit}/mo`, $(l.baseCents)], 10);
    if (d.quote.regionUpliftCents) doc.cols([`${d.quote.region} uplift`, "+" + $(d.quote.regionUpliftCents)], 10);
    if (d.quote.termDiscountCents) doc.cols([`${TERMS[d.quote.term].label}`, "−" + $(d.quote.termDiscountCents)], 10);
    doc.cols(["Total", $(d.quote.totalCents)], 11, true);
    if (d.approval) doc.text(`Approval: ${d.approval.decision} by ${d.approval.auto ? "policy" : d.approval.by} at ${iso(d.approval.at).slice(0, 16).replace("T", " ")}`, 9.5, false, 0.45);
    if (d.invoice) doc.text(`Invoice ${d.invoice.id} for ${$(d.invoice.amountCents)}, issued ${iso(d.invoice.issuedAt).slice(0, 10)}, due ${iso(d.invoice.dueAt).slice(0, 10)}`, 9.5, false, 0.45);
    const ev = events.filter((e) => e.dealId === d.id).sort((a, b) => a.seq - b.seq);
    const pay = ev.filter((e) => e.kind.startsWith("payment.") || e.kind === "dunning.scheduled" || e.kind === "deal.collections");
    for (const e of pay) doc.text(`  ${iso(e.ts).slice(11, 19)}  ${e.kind.padEnd(18)}  ${summ(e, d.quote.currency)}`, 8.5, false, 0.45, true);
    doc.gap(6);
  }
  return doc.finish();
}

const STATUS: Record<string, string> = { pending_approval: "AWAITING APPROVAL", past_due: "PAST DUE", collections: "COLLECTIONS" };
function summ(e: Event, currency: Currency): string {
  const d = e.detail as any;
  switch (e.kind) {
    case "payment.attempted": return `attempt ${d.attempt} ${d.reference}`;
    case "payment.succeeded": return `${fmt(d.amountCents, currency)} on attempt ${d.attempt}`;
    case "payment.failed": return `attempt ${d.attempt}: ${d.code}${d.retryable ? "" : " (not retryable)"}`;
    case "dunning.scheduled": return `retry #${d.nextAttempt} in ${d.afterDays}d (${d.level})`;
    case "deal.collections": return String(d.reason);
    default: return "";
  }
}

/** Minimal PDF 1.4 writer: Letter pages, Helvetica / Helvetica-Bold / Courier, automatic page breaks. */
class Pdf {
  private pages: string[][] = [[]];
  private y = 756;
  private readonly left = 54;
  private readonly right = 612 - 54;
  private readonly bottom = 54;

  private ensure(h: number) {
    if (this.y - h < this.bottom) { this.pages.push([]); this.y = 756; }
  }
  private cur() { return this.pages[this.pages.length - 1]; }

  text(s: string, size: number, bold = false, gray = 0, mono = false) {
    const lh = size * 1.4;
    this.ensure(lh);
    this.y -= lh;
    this.cur().push(`BT ${gray} g /${mono ? "F3" : bold ? "F2" : "F1"} ${size} Tf ${this.left} ${this.y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  }
  cols([a, b]: [string, string], size: number, bold = false) {
    const lh = size * 1.4;
    this.ensure(lh);
    this.y -= lh;
    const f = bold ? "F2" : "F1";
    const w = width(b, size, bold);
    this.cur().push(`BT 0 g /${f} ${size} Tf ${this.left + 12} ${this.y.toFixed(1)} Td (${esc(a)}) Tj ET`);
    this.cur().push(`BT 0 g /${f} ${size} Tf ${(this.right - w).toFixed(1)} ${this.y.toFixed(1)} Td (${esc(b)}) Tj ET`);
  }
  rule() { this.ensure(10); this.y -= 6; this.cur().push(`0.85 G 0.5 w ${this.left} ${this.y.toFixed(1)} m ${this.right} ${this.y.toFixed(1)} l S`); this.y -= 4; }
  gap(pt: number) { this.y -= pt; }

  finish(): Uint8Array {
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const font = (name: string) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
    const f1 = font("Helvetica"), f2 = font("Helvetica-Bold"), f3 = font("Courier");
    const pagesId = objs.length + 1 + this.pages.length * 2; // reserve: each page = content + page obj, then Pages
    const pageIds: number[] = [];
    for (const p of this.pages) {
      const stream = p.join("\n");
      const c = add(`<< /Length ${bytes(stream)} >>\nstream\n${stream}\nendstream`);
      const pg = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> >>`);
      pageIds.push(pg);
    }
    const pages = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(bytes(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = bytes(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return latin1(out);
  }
}

/** WinAnsi-safe escaping: replace characters outside Latin-1, escape PDF string delimiters. */
function esc(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, (c) => ({ "€": "\x80", "—": "-", "–": "-", "×": "x", "−": "-", "·": "-", "→": "->", "’": "'", "“": '"', "”": '"' } as Record<string, string>)[c] ?? "?")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function bytes(s: string): number { return latin1(s).length; }
function latin1(s: string): Uint8Array { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; }
/** Rough Helvetica width for right-aligning amounts (digits ≈ 0.556em). */
function width(s: string, size: number, bold: boolean): number { return s.length * size * (bold ? 0.58 : 0.556); }
