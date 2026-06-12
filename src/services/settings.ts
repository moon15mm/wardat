import prisma from './db';
import logger from '../utils/logger';

/**
 * DB-backed platform settings with environment-variable fallback.
 *
 * Resolution order for any key: DB override → process.env → built-in default.
 * This lets the Super Admin edit operational config (plan prices, platform
 * Stripe keys, WhatsApp app secret, SMTP, base URL) from the dashboard without
 * touching .env or restarting — while existing .env values keep working as the
 * baseline until overridden.
 *
 * Boot-critical secrets (SESSION_SECRET, DATABASE_URL, ADMIN_*) are intentionally
 * NOT managed here — they must stay in .env.
 */

// Plan pricing defaults (used when neither DB nor env provides a value).
const DEFAULTS: Record<string, string> = {
  PLAN_PRICE_SILVER: '50',
  PLAN_PRICE_GOLD: '150',
  PLAN_PRICE_PLATINUM: '300',
  PLAN_DISCOUNT_3: '5',
  PLAN_DISCOUNT_6: '10',
  PLAN_DISCOUNT_12: '20',
  FOLLOWUP_DAYS: '3',
  BACKUP_ENABLED: 'true',
  BACKUP_RETENTION_DAYS: '14',
};

// All keys the settings UI can read/write.
export const SETTING_KEYS = [
  'PLAN_PRICE_SILVER', 'PLAN_PRICE_GOLD', 'PLAN_PRICE_PLATINUM',
  'PLAN_DISCOUNT_3', 'PLAN_DISCOUNT_6', 'PLAN_DISCOUNT_12',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL',
  'WHATSAPP_APP_SECRET',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'APP_BASE_URL', 'ULTRAMSG_WEBHOOK_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_MODEL',
  // Acquisition agent
  'FOLLOWUP_DAYS', 'AGENT_ENABLED', 'AGENT_CITY', 'AGENT_SENDER_SHOP_ID', 'AGENT_AUTOSEND', 'GOOGLE_PLACES_API_KEY',
  // Backups
  'BACKUP_ENABLED', 'BACKUP_RETENTION_DAYS',
] as const;
export type SettingKey = typeof SETTING_KEYS[number];

// Keys whose values must be masked when returned to the UI.
export const SECRET_KEYS = new Set<string>([
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'WHATSAPP_APP_SECRET', 'SMTP_PASS', 'OPENAI_API_KEY', 'GOOGLE_PLACES_API_KEY',
]);

export function getFollowupDays(): number {
  const n = parseInt(raw('FOLLOWUP_DAYS') || '3', 10);
  return isNaN(n) ? 3 : Math.min(60, Math.max(1, n));
}

export function getOpenAI(): { apiKey: string; model: string } {
  return {
    apiKey: raw('OPENAI_API_KEY') || '',
    model: raw('OPENAI_MODEL') || 'gpt-4o-mini',
  };
}

const cache = new Map<string, string>();
let loaded = false;

export async function loadSettings(): Promise<void> {
  try {
    const rows = await prisma.platformSetting.findMany();
    cache.clear();
    for (const r of rows) cache.set(r.key, r.value);
    loaded = true;
    logger.info(`[Settings] Loaded ${rows.length} platform settings from DB`);
  } catch (err: any) {
    logger.error(`[Settings] Failed to load settings: ${err.message}`);
  }
}

/** Raw effective value: DB → env → default → undefined. */
export function raw(key: string): string | undefined {
  if (cache.has(key)) return cache.get(key);
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  return DEFAULTS[key];
}

export function getPlanPrice(plan: string): number {
  const v = raw(`PLAN_PRICE_${plan}`);
  const n = parseFloat(v || '');
  return isNaN(n) ? 0 : n;
}

/** Discount fraction (0-1) for a given duration in months. */
export function getDiscountFraction(months: number): number {
  if (![3, 6, 12].includes(months)) return 0;
  const pct = parseFloat(raw(`PLAN_DISCOUNT_${months}`) || '0');
  return isNaN(pct) ? 0 : Math.min(90, Math.max(0, pct)) / 100;
}

export function getAppBaseUrl(): string {
  return (raw('APP_BASE_URL') || 'https://wardat.xyz').replace(/\/$/, '');
}

export interface PlatformStripe {
  secretKey: string; webhookSecret: string; successUrl: string; cancelUrl: string;
}
export function getPlatformStripe(): PlatformStripe {
  return {
    secretKey: raw('STRIPE_SECRET_KEY') || '',
    webhookSecret: raw('STRIPE_WEBHOOK_SECRET') || '',
    successUrl: raw('STRIPE_SUCCESS_URL') || '',
    cancelUrl: raw('STRIPE_CANCEL_URL') || '',
  };
}

export interface SmtpConfig {
  host?: string; port: number; secure: boolean; user?: string; pass?: string; from?: string;
}
export function getSmtp(): SmtpConfig {
  const port = parseInt(raw('SMTP_PORT') || '587', 10);
  return {
    host: raw('SMTP_HOST'),
    port: isNaN(port) ? 587 : port,
    secure: raw('SMTP_SECURE') === 'true' || port === 465,
    user: raw('SMTP_USER'),
    pass: raw('SMTP_PASS'),
    from: raw('SMTP_FROM'),
  };
}

export function getWhatsappAppSecret(): string | undefined {
  return raw('WHATSAPP_APP_SECRET') || undefined;
}

/** Effective values for all known keys (raw, unmasked). */
export function effectiveAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = raw(k) ?? '';
  return out;
}

/**
 * Persist a partial set of settings. Only keys present in `updates` are written.
 * Returns the number of keys saved.
 */
export async function saveSettings(updates: Record<string, string>): Promise<number> {
  let count = 0;
  for (const key of Object.keys(updates)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) continue;
    const value = String(updates[key]);
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    count++;
  }
  await loadSettings();
  return count;
}
