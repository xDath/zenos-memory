import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { createLockLease } from '../../../lib/memory-maintainer';

// Lightweight stateless lease endpoint. Drive-backed lock persistence can layer on this shape.
export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const owner = body.owner || 'zenos-memory';
  const ttlMs = Math.min(300000, Math.max(5000, Number(body.ttl_ms || 30000)));
  const lease = createLockLease(owner, ttlMs);
  return NextResponse.json({ success: true, lease, mode: 'optimistic-lease' });
}
