import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { createLockLease } from '../../../lib/memory-maintainer';
import { getMemoryEngine } from '../../../lib/memory-engine';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const owner = body.owner || 'zenos-memory';
  const namespace = body.namespace || 'zenos';
  const ttlMs = Math.min(300000, Math.max(5000, Number(body.ttl_ms || 30000)));
  const lease = createLockLease(owner, ttlMs);

  // Persist lock lease as event memory for auditability / optimistic coordination.
  const engine = getMemoryEngine();
  await engine.remember({
    content: JSON.stringify(lease),
    type: 'event',
    namespace,
    metadata: {
      source: 'zenos-lock-lease',
      confidence: 1,
      importance: 7,
      tags: ['lock', 'lease', 'concurrency'],
      expires_at: lease.expires_at,
    },
  });

  return NextResponse.json({ success: true, lease, mode: 'drive-audited-optimistic-lease' });
}

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const engine = getMemoryEngine();
  const locks = await engine.recall({ query: 'lock lease concurrency', namespace, limit: 20, type: 'event', include_low_quality: true });
  const now = Date.now();
  const active = locks.filter(l => l.metadata.expires_at && new Date(l.metadata.expires_at).getTime() > now);
  return NextResponse.json({ success: true, namespace, active_count: active.length, active_locks: active });
}
