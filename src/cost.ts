/** Micro-dollars for one LLM call at USD-per-million-token prices. Rounds up so a cap is conservative. */
export interface Usage { prompt_tokens: number; completion_tokens: number }
export function costMicros(usage: Usage, inUsdPerM: number, outUsdPerM: number): number {
  return Math.ceil(usage.prompt_tokens * inUsdPerM + usage.completion_tokens * outUsdPerM);
}
