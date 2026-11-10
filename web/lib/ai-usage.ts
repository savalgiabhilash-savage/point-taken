import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

// AI usage per account (Settings → AI usage). Each Claude call made for a signed-in user is logged with its
// token counts and an estimated cost, from the API's own `usage` numbers × list prices (USD per 1M tokens).
// It's an estimate: Anthropic's bill is the source of truth (taxes, credits and price changes aren't here).
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
};
// Prompt caching: writing to the cache costs 1.25× input, reading from it 0.1× input.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** Add one response's usage to a running total (a multi-round tool loop makes several calls). */
export function addUsage(total: Usage, u: Anthropic.Usage | null | undefined): Usage {
  if (!u) return total;
  return {
    input: total.input + (u.input_tokens ?? 0),
    output: total.output + (u.output_tokens ?? 0),
    cacheWrite: total.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: total.cacheRead + (u.cache_read_input_tokens ?? 0),
  };
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (u.input * p.input + u.cacheWrite * p.input * CACHE_WRITE + u.cacheRead * p.input * CACHE_READ + u.output * p.output) /
    1_000_000
  );
}

/** Record one feature use for the signed-in user (RLS: users insert only their own rows). Never throws. */
export async function logUsage(sb: SupabaseClient, userId: string, feature: string, model: string, u: Usage, calls: number) {
  if (!u.input && !u.output) return;
  try {
    await sb.from("ai_usage").insert({
      user_id: userId,
      feature,
      model,
      calls,
      input_tokens: u.input,
      output_tokens: u.output,
      cache_write_tokens: u.cacheWrite,
      cache_read_tokens: u.cacheRead,
      cost_usd: Number(costUsd(model, u).toFixed(6)),
    });
  } catch {
    // usage logging must never break the feature (e.g. before migration 0015)
  }
}
