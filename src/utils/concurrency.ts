/**
 * Lightweight in-process concurrency helpers.
 *
 * NOTE: these are per-process. They protect a single Node instance against
 * out-of-order processing and duplicate webhook deliveries. Running multiple
 * instances would require moving this to Redis (see deployment notes).
 */

// --- Per-key serialization -------------------------------------------------
// Ensures tasks sharing a key (e.g. one customer's messages) run one-at-a-time
// in arrival order, preventing read-modify-write races on the session row.
const chains = new Map<string, Promise<unknown>>();

export function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(() => task());
  chains.set(key, next);
  // Drop the entry once this task is the tail, to avoid unbounded growth.
  next.catch(() => undefined).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

// --- Duplicate-delivery guard ----------------------------------------------
// Webhook providers retry on slow responses. We dedupe by provider message id.
const seen = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isDuplicate(id: string | undefined | null): boolean {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  return false;
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, ts] of seen) {
    if (ts < cutoff) seen.delete(id);
  }
}, 5 * 60 * 1000);
// Don't keep the event loop alive just for cleanup.
cleanupTimer.unref();
