import { v4 as uuidv4 } from 'uuid';

export function generateOrderId(): string {
  // 16 hex chars (64 bits): collision-safe at our scale and not enumerable, while
  // still short enough to read over WhatsApp. (The old 8-char/32-bit id was both
  // guessable and prone to collisions.)
  return uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
}

export function formatPrice(price: number, currency = 'SAR'): string {
  return `${price} ${currency === 'SAR' ? 'ريال' : currency}`;
}

/**
 * Mask a phone number / JID for logging (PII minimization, GDPR/CWE-532).
 * Keeps a short prefix + last 2 digits so logs stay useful for support without
 * recording the full number, e.g. "966512345678" -> "9665****78".
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value);
  // Preserve any "@suffix" (WhatsApp JID) but mask the numeric/local part.
  const [local, ...rest] = s.split('@');
  const suffix = rest.length ? '@' + rest.join('@') : '';
  if (local.length <= 6) return '****' + suffix;
  return local.slice(0, 4) + '****' + local.slice(-2) + suffix;
}

export function formatTimestamp(): string {
  return new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
}

export function extractPhoneNumber(from: string): string {
  return from.replace(/\D/g, '');
}

export function isValidSaudiPhone(phone: string): boolean {
  const cleaned = phone.replace(/\D/g, '');
  return /^(05\d{8}|9665\d{8}|5\d{8})$/.test(cleaned);
}
