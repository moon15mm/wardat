import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const SECRET = process.env.SESSION_SECRET || '';

// Token lifetime in seconds (default 24h)
const TOKEN_TTL_SECONDS = parseInt(process.env.TOKEN_TTL_SECONDS || '86400', 10);

if (!SECRET) {
  // Fail loud at import time: a missing secret means any attacker can forge tokens.
  throw new Error(
    'SESSION_SECRET is not set. Refusing to start with an insecure default. ' +
      'Set a strong random SESSION_SECRET in the environment.'
  );
}

/**
 * Hash a password with bcrypt (salted, slow).
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Legacy hash used by older records (unsalted SHA-256). Kept only to verify and
 * transparently migrate existing passwords on next successful login.
 */
function legacyHash(password: string): string {
  return crypto.createHash('sha256').update(password + SECRET).digest('hex');
}

/**
 * Verify a plaintext password against a stored hash.
 * Supports both bcrypt hashes and legacy SHA-256 hashes.
 * Returns { valid, needsRehash } so the caller can upgrade legacy hashes.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!storedHash) return { valid: false, needsRehash: false };

  // bcrypt hashes start with $2a$ / $2b$ / $2y$
  if (storedHash.startsWith('$2')) {
    const valid = await bcrypt.compare(password, storedHash);
    return { valid, needsRehash: false };
  }

  // Legacy SHA-256 (64 hex chars)
  const valid = crypto.timingSafeEqual(
    Buffer.from(legacyHash(password)),
    Buffer.from(storedHash)
  );
  return { valid, needsRehash: valid };
}

export function generateToken(payload: Record<string, any>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const data = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

export function verifyToken(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, data, signature] = parts;
    const expectedSignature = crypto.createHmac('sha256', SECRET).update(`${header}.${data}`).digest('base64url');

    // Constant-time signature comparison
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));

    // Enforce expiry
    if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
