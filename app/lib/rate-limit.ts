interface Bucket {
  timestamps: number[];
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();
let requestsSinceCleanup = 0;

function cleanup(now: number, maxAgeMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastSeen > maxAgeMs) buckets.delete(key);
  }
}

export function rateLimit(identity: string, limit = 120, windowMs = 60_000): boolean {
  const now = Date.now();
  requestsSinceCleanup += 1;
  if (requestsSinceCleanup >= 500) {
    cleanup(now, Math.max(windowMs * 2, 120_000));
    requestsSinceCleanup = 0;
  }

  const existing = buckets.get(identity) || { timestamps: [], lastSeen: now };
  existing.timestamps = existing.timestamps.filter(timestamp => now - timestamp < windowMs);
  existing.lastSeen = now;
  if (existing.timestamps.length >= limit) {
    buckets.set(identity, existing);
    return false;
  }
  existing.timestamps.push(now);
  buckets.set(identity, existing);
  return true;
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
  requestsSinceCleanup = 0;
}
