import prisma from './db';
import logger from '../utils/logger';

/**
 * Per-shop AI token usage tracking.
 *
 * Each AI call (OpenAI or Gemini) reports how many prompt/completion tokens it
 * consumed; we increment a per-(shop, provider, month) bucket so the superadmin
 * dashboard can show running totals AND a monthly breakdown, plus an estimated
 * USD cost computed from current model pricing.
 */

// Approximate USD price per 1M tokens, keyed by provider. These match the models
// the app actually uses (OpenAI: gpt-4o-mini, Gemini: gemini-1.5-flash). Pricing
// is applied at display time so it can be tuned here without touching stored data.
export const AI_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  OPENAI: { inputPerM: 0.15, outputPerM: 0.60 },  // gpt-4o-mini
  GEMINI: { inputPerM: 0.075, outputPerM: 0.30 }, // gemini-1.5-flash
};

export function estimateCostUsd(provider: string, promptTokens: number, completionTokens: number): number {
  const p = AI_PRICING[provider] || AI_PRICING.OPENAI;
  const cost = (promptTokens / 1_000_000) * p.inputPerM + (completionTokens / 1_000_000) * p.outputPerM;
  return Math.round(cost * 1e6) / 1e6; // round to 6 decimals (micro-dollars)
}

function currentYearMonthUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Record the token usage of a single AI call. Never throws — usage tracking must
 * never break the customer-facing reply path.
 */
export async function recordAiUsage(
  shopId: string | undefined | null,
  provider: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  try {
    if (!shopId) return;
    const prompt = Math.max(0, Math.round(promptTokens || 0));
    const completion = Math.max(0, Math.round(completionTokens || 0));
    const total = prompt + completion;
    if (total === 0) return;

    const yearMonth = currentYearMonthUtc();
    const prov = provider === 'GEMINI' ? 'GEMINI' : 'OPENAI';

    await prisma.aiUsage.upsert({
      where: { shopId_provider_yearMonth: { shopId, provider: prov, yearMonth } },
      create: {
        shopId,
        provider: prov,
        yearMonth,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        requests: 1,
      },
      update: {
        promptTokens: { increment: prompt },
        completionTokens: { increment: completion },
        totalTokens: { increment: total },
        requests: { increment: 1 },
      },
    });
  } catch (e: any) {
    logger.error(`[AiUsage] Failed to record usage for shop ${shopId}: ${e.message}`);
  }
}
